import { createWeeklyCampaignRepository } from '../db/weekly-campaign.ts';
import type { DatabaseConnection } from '../db/pool.ts';

import {
  readWeeklyNote,
  WeeklyNoteError,
  type WeeklyNote,
} from './weekly-note-content.ts';

// E11.8-03: which founder note, if any, the weekly update carries.
//
// - When a run's queueing starts, it records the SHA-256 of the note deployed
//   for its own ISO week, while `email.weekly_note` is on. Without the flag, or
//   without a note for that week, nothing is recorded and the run sends the
//   unchanged update.
// - At dispatch, a message carries the note only while the flag is on, the
//   run has not left the note out, and the deployed note for the run's week
//   still has the recorded hash. A note that a deploy changed or removed
//   during the send window is left out of the rest of the run, recorded once
//   on the run, with one P3. One run therefore never carries two notes.
//
// Who receives the update is not decided here: queueing and dispatch keep the
// E8-07 checks (docs/modules/email.md).

export type WeeklyNoteLeftOutReason = 'changed' | 'missing' | 'invalid';

export interface WeeklyNoteP3 {
  readonly isoWeek: string;
  readonly reason: WeeklyNoteLeftOutReason;
  readonly occurredAt: Date;
}

export interface WeeklyNoteServiceDependencies {
  readonly database: DatabaseConnection;
  /** `email.weekly_note`; a failed read is off (ADR-023). */
  readonly isEnabled: () => Promise<boolean>;
  readonly clock: () => Date;
  /** Reads the deployed note for a week; the checked-in folder by default. */
  readonly read?: (isoWeek: string) => WeeklyNote | null;
  /** A P3 is a structured log line (docs/architecture/fallbacks.md). */
  readonly reportP3?: (event: WeeklyNoteP3) => void;
}

export interface WeeklyNoteService {
  /** The hash a run starting now records for its week, or null for none. */
  atRunStart(isoWeek: string): Promise<string | null>;
  /** The note one message of the run for `isoWeek` carries, or null. */
  forDispatch(isoWeek: string): Promise<WeeklyNote | null>;
}

function writeP3(event: WeeklyNoteP3): void {
  process.stderr.write(
    `${JSON.stringify({
      event: 'weekly_note_left_out',
      severity: 'P3',
      iso_week: event.isoWeek,
      reason: event.reason,
      occurred_at: event.occurredAt.toISOString(),
    })}\n`,
  );
}

async function enabled(isEnabled: () => Promise<boolean>): Promise<boolean> {
  try {
    return await isEnabled();
  } catch {
    return false;
  }
}

export function createWeeklyNoteService(
  dependencies: WeeklyNoteServiceDependencies,
): WeeklyNoteService {
  const read = dependencies.read ?? ((isoWeek) => readWeeklyNote(isoWeek));
  const reportP3 = dependencies.reportP3 ?? writeP3;

  function deployed(
    isoWeek: string,
  ):
    | { readonly note: WeeklyNote | null }
    | { readonly invalid: WeeklyNoteError } {
    try {
      return { note: read(isoWeek) };
    } catch (error) {
      if (error instanceof WeeklyNoteError) return { invalid: error };
      throw error;
    }
  }

  return {
    async atRunStart(isoWeek) {
      if (!(await enabled(dependencies.isEnabled))) return null;
      const current = deployed(isoWeek);
      if ('invalid' in current) {
        // The build check makes this a deploy defect; the update goes out
        // without the note rather than not at all.
        reportP3({
          isoWeek,
          reason: 'invalid',
          occurredAt: dependencies.clock(),
        });
        return null;
      }
      return current.note?.hash ?? null;
    },

    async forDispatch(isoWeek) {
      if (!(await enabled(dependencies.isEnabled))) return null;
      const repository = createWeeklyCampaignRepository(dependencies.database);
      const run = await repository.run(isoWeek);
      if (
        run === null ||
        run.note_hash === null ||
        run.note_left_out_at !== null
      )
        return null;
      const current = deployed(isoWeek);
      if ('note' in current && current.note?.hash === run.note_hash)
        return current.note;
      const reason: WeeklyNoteLeftOutReason =
        'invalid' in current
          ? 'invalid'
          : current.note === null
            ? 'missing'
            : 'changed';
      const now = dependencies.clock();
      if (await repository.leaveNoteOut(isoWeek, now))
        reportP3({ isoWeek, reason, occurredAt: now });
      return null;
    },
  };
}
