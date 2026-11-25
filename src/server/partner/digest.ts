import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PartnerDigestConfiguration } from '../config.ts';
import { createCampaignFlagRepository } from '../db/campaign-flags.ts';
import {
  createPartnerDigestRepository,
  maxPartnerDigestBatch,
  type PartnerDigestCadence,
  type PartnerDigestSkipReason,
} from '../db/partner-digest.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import type { QueueEmailInput } from '../email/service.ts';
import { weeklyWindow } from '../email/weekly-campaign.ts';
import { campaignFlagRegistry, type FlagKey } from '../flags/registry.ts';
import type { FlagService } from '../flags/types.ts';
import { partnerAttributionEnabledForWrite } from '../referral/partner-perks.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';
import { createVerificationService } from '../verification/service.ts';

import { partnerDigestBusinessKey, partnerDigestTemplate } from './config.ts';

// E11.7-13: the partner digest (D-071). It reports the period that has just
// ended: monthly on the 1st for the previous UTC calendar month, or weekly on
// Monday for the previous ISO-8601 UTC week, at the configured UTC time. The
// hourly maintenance run queues capped batches from the send time until 24
// hours later. A missed window, or an empty founder note when the period's
// run would start, skips that period, records it and raises P2; nothing is
// sent late. The E8-07 run integrity applies: a durable run per period, one
// email per business key, and a fresh eligibility check inside each queueing
// transaction, so a restart or a concurrent run never sends twice.

const dayMs = 24 * 60 * 60 * 1_000;
export const partnerDigestBatchLimit = maxPartnerDigestBatch;
export const maxPartnerDigestBatchesPerRun = 100;
const maxMissedPeriodsPerRun = 12;

/** The flags that must all be on for a digest to be queued or sent. */
export const partnerDigestFlags = [
  'partners.enabled',
  'partners.digest',
  'email.broadcast',
] as const satisfies readonly FlagKey[];

export interface PartnerDigestWindow {
  readonly cadence: PartnerDigestCadence;
  /** The reported period: `YYYY-MM` or `YYYY-Www`. */
  readonly period: string;
  /** The reported period, as a half-open UTC interval. */
  readonly reportStart: Date;
  readonly reportEnd: Date;
  /** The send window: from the scheduled time, for 24 hours. */
  readonly startsAt: Date;
  readonly endsAt: Date;
}

function assertSchedule(schedule: PartnerDigestConfiguration): void {
  if (
    (schedule.cadence !== 'monthly' && schedule.cadence !== 'weekly') ||
    !Number.isInteger(schedule.hour) ||
    schedule.hour < 0 ||
    schedule.hour > 23 ||
    !Number.isInteger(schedule.minute) ||
    schedule.minute < 0 ||
    schedule.minute > 59
  )
    throw new RangeError('Invalid partner digest schedule.');
}

function sendTime(schedule: PartnerDigestConfiguration): string {
  return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
}

function monthLabel(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

/** The send window of the period in which `now` falls, and what it reports. */
export function partnerDigestWindow(
  now: Date,
  schedule: PartnerDigestConfiguration,
): PartnerDigestWindow {
  assertSchedule(schedule);
  const offsetMs = (schedule.hour * 60 + schedule.minute) * 60 * 1_000;
  if (schedule.cadence === 'monthly') {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const reportEnd = new Date(Date.UTC(year, month, 1));
    const reportStart = new Date(Date.UTC(year, month - 1, 1));
    const startsAt = new Date(reportEnd.getTime() + offsetMs);
    return {
      cadence: 'monthly',
      period: monthLabel(
        reportStart.getUTCFullYear(),
        reportStart.getUTCMonth(),
      ),
      reportStart,
      reportEnd,
      startsAt,
      endsAt: new Date(startsAt.getTime() + dayMs),
    };
  }
  const current = weeklyWindow(now, {
    isoWeekday: 1,
    hour: schedule.hour,
    minute: schedule.minute,
  });
  const reportEnd = new Date(current.startsAt.getTime() - offsetMs);
  const reportStart = new Date(reportEnd.getTime() - 7 * dayMs);
  return {
    cadence: 'weekly',
    period: weeklyWindow(reportStart, { isoWeekday: 1, hour: 0, minute: 0 })
      .isoWeek,
    reportStart,
    reportEnd,
    startsAt: current.startsAt,
    endsAt: current.endsAt,
  };
}

/** The earlier window `periodsAgo` periods before the one at `now`. */
function earlierWindow(
  now: Date,
  periodsAgo: number,
  schedule: PartnerDigestConfiguration,
): PartnerDigestWindow {
  if (schedule.cadence === 'monthly') {
    const at = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - periodsAgo, 1, 12),
    );
    return partnerDigestWindow(at, schedule);
  }
  return partnerDigestWindow(
    new Date(now.getTime() - periodsAgo * 7 * dayMs),
    schedule,
  );
}

/** The reported interval of a period label, for the renderer at dispatch. */
export function partnerDigestPeriodRange(period: string): {
  readonly start: Date;
  readonly end: Date;
  readonly label: PeriodLabel;
} {
  const month = /^([0-9]{4})-(0[1-9]|1[0-2])$/u.exec(period);
  if (month !== null) {
    const year = Number(month[1]);
    const index = Number(month[2]) - 1;
    return {
      start: new Date(Date.UTC(year, index, 1)),
      end: new Date(Date.UTC(year, index + 1, 1)),
      label: { kind: 'month', year, month: index },
    };
  }
  const week = /^([0-9]{4})-W(0[1-9]|[1-4][0-9]|5[0-3])$/u.exec(period);
  if (week !== null) {
    const year = Number(week[1]);
    const number = Number(week[2]);
    const jan4 = Date.UTC(year, 0, 4);
    const firstMonday = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * dayMs;
    const start = new Date(firstMonday + (number - 1) * 7 * dayMs);
    if (
      weeklyWindow(start, { isoWeekday: 1, hour: 0, minute: 0 }).isoWeek !==
      period
    )
      throw new Error('partner_digest_period_invalid');
    return {
      start,
      end: new Date(start.getTime() + 7 * dayMs),
      label: { kind: 'week', year, week: number },
    };
  }
  throw new Error('partner_digest_period_invalid');
}

export type PeriodLabel =
  | { readonly kind: 'month'; readonly year: number; readonly month: number }
  | { readonly kind: 'week'; readonly year: number; readonly week: number };

/** The content file the founder edits; it ships with no note text. */
export const partnerDigestNoteFile = 'src/content/partner-digest-note.json';

/**
 * Reads the founder's note. Returns null while the note is empty. A file that
 * is not exactly `{ "note": string }` throws, so the job reports a failure
 * instead of sending a digest without the note.
 */
export function readPartnerDigestNote(
  path = resolve(process.cwd(), partnerDigestNoteFile),
): string | null {
  const document: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    Object.keys(document).join(',') !== 'note' ||
    typeof (document as { note: unknown }).note !== 'string'
  )
    throw new Error('partner_digest_note_invalid');
  const note = (document as { note: string }).note.trim();
  return note === '' ? null : note;
}

/** Every digest flag, read in the caller's transaction, with code defaults. */
export async function partnerDigestFlagsOn(
  connection: DatabaseConnection,
): Promise<boolean> {
  const rows =
    await createCampaignFlagRepository(connection).list(partnerDigestFlags);
  return partnerDigestFlags.every(
    (key) =>
      rows.find((row) => row.key === key)?.enabled ?? campaignFlagRegistry[key],
  );
}

export interface PartnerDigestJobDependencies {
  readonly database: DatabasePool;
  readonly flags: Pick<FlagService, 'isEnabled'>;
  readonly email: {
    queue(
      input: QueueEmailInput,
      connection: DatabaseConnection,
    ): Promise<boolean>;
  };
  readonly alerts: AlertTransport;
  readonly clock: () => Date;
  readonly schedule: PartnerDigestConfiguration;
  readonly note?: () => string | null;
  readonly tokenSecret?: string;
}

export type PartnerDigestRunState =
  'paused' | 'early' | 'not_due' | 'skipped' | 'completed' | 'started';

class AlreadyQueued extends Error {}

export function createPartnerDigestJob(
  dependencies: PartnerDigestJobDependencies,
) {
  const { database, clock, schedule } = dependencies;
  assertSchedule(schedule);
  const repository = createPartnerDigestRepository(database);
  const note = dependencies.note ?? (() => readPartnerDigestNote());

  async function notifySkipped(period: string): Promise<void> {
    const current = await repository.run(period);
    if (current?.state !== 'skipped' || current.alerted_at !== null) return;
    await dependencies.alerts.send({
      event: 'partner_digest_period_skipped',
      detail: { period, reason: current.skip_reason ?? 'missed_window' },
      occurredAt: clock(),
      severity: 'P2',
    });
    await repository.markAlerted(period, clock());
  }

  async function skip(
    window: PartnerDigestWindow,
    reason: PartnerDigestSkipReason,
    now: Date,
  ): Promise<void> {
    await repository.skip(
      window.period,
      window.cadence,
      window.startsAt,
      reason,
      now,
    );
    await notifySkipped(window.period);
  }

  async function finishedCleanly(period: string): Promise<boolean> {
    const run = await repository.run(period);
    return (
      run?.state === 'completed' &&
      (await repository.unsent(period, partnerDigestTemplate)) === 0
    );
  }

  /** Records any earlier window of this schedule that closed unsent. */
  async function checkEarlierWindows(now: Date, since: Date): Promise<void> {
    for (let ago = 1; ago <= maxMissedPeriodsPerRun; ago += 1) {
      const past = earlierWindow(now, ago, schedule);
      // A window that opened before this schedule took effect was never owed.
      if (past.startsAt < since) break;
      if (now < past.endsAt) continue;
      const run = await repository.run(past.period);
      if (run?.state === 'skipped') {
        await notifySkipped(past.period);
        continue;
      }
      if (await finishedCleanly(past.period)) continue;
      await skip(past, 'missed_window', now);
    }
  }

  async function queueOne(
    window: PartnerDigestWindow,
    partnerId: string,
    subscriberId: string,
  ): Promise<boolean> {
    return withTransaction(database, async (connection) => {
      const digest = createPartnerDigestRepository(connection);
      // Subscriber, then the programme flag row, then partner: the order
      // activation, the welcome and erasure lock in.
      if ((await digest.lockSubscriber(subscriberId)) === null) return false;
      if (!(await partnerAttributionEnabledForWrite(connection))) return false;
      if (!(await partnerDigestFlagsOn(connection))) return false;
      if ((await digest.lockEligible(partnerId, subscriberId)) === null)
        return false;
      const status = await createVerificationService(connection, {
        clock,
        ...(dependencies.tokenSecret === undefined
          ? {}
          : { tokenSecret: dependencies.tokenSecret }),
      }).issue(subscriberId, 'status');
      const queued = await dependencies.email.queue(
        {
          template: partnerDigestTemplate,
          subscriberId,
          businessKey: partnerDigestBusinessKey(window.period, partnerId),
          provider: 'brevo',
          payload: { period: window.period, status_token_id: status.id },
          expiresAt: window.endsAt,
        },
        connection,
      );
      // A lost race rolls back the status token with the transaction.
      if (!queued) throw new AlreadyQueued();
      return true;
    }).catch((error: unknown) => {
      if (error instanceof AlreadyQueued) return false;
      throw error;
    });
  }

  return {
    async run(limit: number = partnerDigestBatchLimit): Promise<{
      queued: number;
      state: PartnerDigestRunState;
    }> {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > partnerDigestBatchLimit
      )
        throw new RangeError('Partner digest batch is out of range.');
      // Flag off sends nothing; each queue checks the flags again.
      for (const key of partnerDigestFlags) {
        if (!(await dependencies.flags.isEnabled(key)))
          return { queued: 0, state: 'paused' };
      }
      const now = clock();
      await repository.recordSchedule(
        schedule.cadence,
        sendTime(schedule),
        now,
      );
      const recorded = await repository.schedule();
      if (recorded === null) throw new Error('partner_digest_schedule_missing');
      await checkEarlierWindows(now, recorded.since);

      const window = partnerDigestWindow(now, schedule);
      if (now < window.startsAt) return { queued: 0, state: 'early' };
      let run = await repository.run(window.period);
      if (run?.state === 'skipped') {
        await notifySkipped(window.period);
        return { queued: 0, state: 'skipped' };
      }
      if (now >= window.endsAt) {
        if (await finishedCleanly(window.period))
          return { queued: 0, state: 'completed' };
        // The schedule took effect after this window closed: nothing was owed.
        if (run === null && recorded.since >= window.endsAt)
          return { queued: 0, state: 'not_due' };
        await skip(window, 'missed_window', now);
        return { queued: 0, state: 'skipped' };
      }
      if (run?.state === 'completed') return { queued: 0, state: 'completed' };
      if (run === null) {
        if (note() === null) {
          await skip(window, 'note_missing', now);
          return { queued: 0, state: 'skipped' };
        }
        await repository.start(
          window.period,
          window.cadence,
          window.startsAt,
          now,
        );
        run = await repository.run(window.period);
        if (run?.state === 'skipped') {
          await notifySkipped(window.period);
          return { queued: 0, state: 'skipped' };
        }
      }

      let queued = 0;
      for (let batch = 0; batch < maxPartnerDigestBatchesPerRun; batch += 1) {
        if (clock() >= window.endsAt) break;
        const due = await repository.eligible(window.period, limit);
        if (due.length === 0) {
          await repository.complete(window.period);
          return { queued, state: 'completed' };
        }
        let progressed = false;
        for (const candidate of due) {
          if (clock() >= window.endsAt) break;
          if (
            await queueOne(
              window,
              candidate.partner_id,
              candidate.subscriber_id,
            )
          ) {
            queued += 1;
            progressed = true;
          }
        }
        // Every candidate in the batch failed its locked re-check: leave the
        // rest for the next run rather than re-reading the same batch.
        if (!progressed) break;
      }
      return { queued, state: 'started' };
    },
  };
}
