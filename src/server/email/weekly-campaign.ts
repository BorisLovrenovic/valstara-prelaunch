import {
  createWeeklyCampaignRepository,
  maxWeeklyQueueBatch,
} from '../db/weekly-campaign.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createVerificationService } from '../verification/service.ts';
import type { FlagService } from '../flags/types.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';
import type { SharedLeaderboardSnapshot } from '../leaderboard/persisted.ts';

import type { QueueEmailInput } from './service.ts';
import { createEmailRepository } from '../db/email.ts';

const dayMs = 24 * 60 * 60 * 1_000;
export const maxWeeklyBatchesPerRun = 100;
const maxMissedWeeksPerRun = 12;

export interface WeeklySendSchedule {
  readonly isoWeekday: number;
  readonly hour: number;
  readonly minute: number;
}

export function weeklyWindow(now: Date, schedule: WeeklySendSchedule) {
  if (
    !Number.isInteger(schedule.isoWeekday) ||
    schedule.isoWeekday < 1 ||
    schedule.isoWeekday > 7 ||
    !Number.isInteger(schedule.hour) ||
    schedule.hour < 0 ||
    schedule.hour > 23 ||
    !Number.isInteger(schedule.minute) ||
    schedule.minute < 0 ||
    schedule.minute > 59
  )
    throw new RangeError('Invalid weekly send schedule.');
  const utcDay = now.getUTCDay() || 7;
  const monday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - utcDay + 1,
  );
  const firstMonday = (year: number) => {
    const jan4 = Date.UTC(year, 0, 4);
    const jan4Day = new Date(jan4).getUTCDay() || 7;
    return jan4 - (jan4Day - 1) * dayMs;
  };
  const year = new Date(monday + 3 * dayMs).getUTCFullYear();
  const week = Math.floor((monday - firstMonday(year)) / (7 * dayMs)) + 1;
  const isoWeek = `${year}-W${String(week).padStart(2, '0')}`;
  const startsAt = new Date(
    monday +
      (schedule.isoWeekday - 1) * dayMs +
      schedule.hour * 60 * 60 * 1_000 +
      schedule.minute * 60 * 1_000,
  );
  return { isoWeek, startsAt, endsAt: new Date(startsAt.getTime() + dayMs) };
}

export interface WeeklyCampaignDependencies {
  readonly database: DatabasePool;
  readonly flags: Pick<FlagService, 'isEnabled'>;
  readonly snapshot: {
    latest(): Promise<SharedLeaderboardSnapshot | null>;
    served(): Promise<SharedLeaderboardSnapshot | null>;
  };
  readonly email: {
    queue(
      input: QueueEmailInput,
      connection?: import('../db/pool.ts').DatabaseConnection,
    ): Promise<boolean>;
  };
  readonly alerts: AlertTransport;
  readonly clock: () => Date;
  readonly tokenSecret: string;
  readonly schedule: WeeklySendSchedule;
}

export function createWeeklyCampaignJob(
  dependencies: WeeklyCampaignDependencies,
) {
  const { database, clock } = dependencies;
  const repository = createWeeklyCampaignRepository(database);

  async function notifyMissed(isoWeek: string): Promise<void> {
    const current = await repository.run(isoWeek);
    if (current?.state !== 'skipped' || current.alerted_at !== null) return;
    await dependencies.alerts.send({
      event: 'weekly_campaign_window_missed',
      detail: { iso_week: isoWeek },
      occurredAt: clock(),
      severity: 'P2',
    });
    await repository.markAlerted(isoWeek, clock());
  }

  async function checkPastWindows(
    now: Date,
    currentWeek: string,
  ): Promise<void> {
    const firstRun = await repository.firstRunWeek();
    const firstSnapshot =
      firstRun === null ? await repository.firstSnapshot() : null;
    for (let weeksAgo = 1; weeksAgo <= maxMissedWeeksPerRun; weeksAgo += 1) {
      const past = weeklyWindow(
        new Date(now.getTime() - weeksAgo * 7 * dayMs),
        dependencies.schedule,
      );
      if (past.isoWeek >= currentWeek || now < past.endsAt) continue;
      if (firstRun !== null && past.isoWeek < firstRun.iso_week) break;
      if (
        firstRun === null &&
        (firstSnapshot === null || firstSnapshot.as_of >= past.endsAt)
      )
        break;
      const run = await repository.run(past.isoWeek);
      if (
        run?.state === 'completed' &&
        (await repository.unsent(past.isoWeek)) === 0
      )
        continue;
      if (run?.state !== 'skipped') await repository.skip(past.isoWeek, now);
      await notifyMissed(past.isoWeek);
    }
  }

  return {
    async run(limit = maxWeeklyQueueBatch): Promise<{
      queued: number;
      state: 'paused' | 'early' | 'skipped' | 'completed' | 'started';
    }> {
      if (!Number.isInteger(limit) || limit < 1 || limit > maxWeeklyQueueBatch)
        throw new RangeError('Weekly queue batch is out of range.');
      if (!(await dependencies.flags.isEnabled('email.broadcast')))
        return { queued: 0, state: 'paused' };
      const now = clock();
      const window = weeklyWindow(now, dependencies.schedule);
      await checkPastWindows(now, window.isoWeek);
      if (now < window.startsAt) return { queued: 0, state: 'early' };
      let run = await repository.run(window.isoWeek);
      if (run?.state === 'skipped') {
        await notifyMissed(window.isoWeek);
        return { queued: 0, state: 'skipped' };
      }
      if (now >= window.endsAt) {
        if (
          run?.state === 'completed' &&
          (await repository.unsent(window.isoWeek)) === 0
        )
          return { queued: 0, state: 'completed' };
        await repository.skip(window.isoWeek, now);
        await notifyMissed(window.isoWeek);
        return { queued: 0, state: 'skipped' };
      }
      if (run?.state === 'completed') return { queued: 0, state: 'completed' };
      if (run === null) {
        const snapshot =
          (await dependencies.snapshot.served()) ??
          (await dependencies.snapshot.latest());
        if (snapshot === null) throw new Error('weekly_snapshot_unavailable');
        await repository.start(window.isoWeek, snapshot.id, now);
        run = await repository.run(window.isoWeek);
      }
      if (run?.snapshot_id === null || run === null)
        throw new Error('weekly_snapshot_unavailable');
      let queued = 0;
      for (let batch = 0; batch < maxWeeklyBatchesPerRun; batch += 1) {
        if (clock() >= window.endsAt) break;
        const eligible = await repository.eligible(window.isoWeek, limit);
        if (eligible.length === 0) {
          await repository.complete(window.isoWeek);
          return { queued, state: 'completed' };
        }
        for (const subscriber of eligible) {
          if (clock() >= window.endsAt) break;
          const inserted = await withTransaction(
            database,
            async (connection) => {
              const key = `weekly:${window.isoWeek}:${subscriber.id}`;
              const outbox = createEmailRepository(connection);
              await outbox.lockBusinessKey(key);
              if (await outbox.findByBusinessKey(key)) return false;
              const emailRepository =
                createWeeklyCampaignRepository(connection);
              // Re-check the audience inside the transaction; dispatch checks it again.
              const stillEligible = await emailRepository.eligibleId(
                window.isoWeek,
                subscriber.id,
              );
              if (!stillEligible) return false;
              const status = await createVerificationService(connection, {
                clock,
                tokenSecret: dependencies.tokenSecret,
              }).issue(subscriber.id, 'status');
              return dependencies.email.queue(
                {
                  template: 'weekly_campaign_update',
                  subscriberId: subscriber.id,
                  businessKey: key,
                  provider: 'brevo',
                  payload: {
                    snapshot_id: run.snapshot_id!,
                    status_token_id: status.id,
                  },
                  expiresAt: window.endsAt,
                },
                connection,
              );
            },
          );
          if (inserted) queued += 1;
        }
      }
      return { queued, state: 'started' };
    },
  };
}
