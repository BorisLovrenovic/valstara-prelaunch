import type { DatabaseConnection } from './pool.ts';

export const awardBatchLimit = 100;

export interface PublishedAwardDraw {
  readonly id: string;
  readonly entry_snapshot_hash: Buffer;
  readonly prize_count: number;
  readonly rules_version: string;
  readonly published_at: Date;
}

export interface AwardSelection {
  readonly position: string;
  readonly entry_id: string;
  readonly subscriber_id: string;
}

export interface AwardRow {
  readonly id: string;
  readonly draw_id: string;
  readonly prize_slot: number;
  readonly entry_snapshot_hash: Buffer;
  readonly selection_position: string;
  readonly entry_id: string;
  readonly subscriber_id: string;
  readonly state: 'notified' | 'confirmed' | 'delivered' | 'exhausted';
  readonly notified_at: Date;
  readonly response_deadline_at: Date;
  readonly country_of_residence: string | null;
  readonly substitution_state: 'none' | 'offered' | 'replacement' | 'cash';
  readonly substitution_offered_at: Date | null;
  readonly substitution_deadline_at: Date | null;
  readonly substitution_offer: unknown;
}

export function createGiveawayAwardRepository(db: DatabaseConnection) {
  return {
    async lockFlow(): Promise<void> {
      await db.readOne({ text: 'SELECT pg_advisory_xact_lock(705, 6)' });
    },
    publishedDraw(): Promise<PublishedAwardDraw | null> {
      return db.readOne<PublishedAwardDraw>({
        text: `SELECT id::text, entry_snapshot_hash, prize_count,
                      rules_version, published_at
               FROM giveaway_draw WHERE state = 'published'`,
      });
    },
    winnerPage(drawId: string, after: string | null) {
      return db.list<AwardSelection>(
        {
          text: `SELECT position::text, entry_id::text, subscriber_id::text
               FROM giveaway_draw_selection
               WHERE draw_id = $1 AND is_winner = true
                 AND ($2::bigint IS NULL OR position > $2::bigint)
               ORDER BY position`,
          values: [drawId, after],
        },
        awardBatchLimit,
      );
    },
    awardForSlot(drawId: string, slot: number): Promise<AwardRow | null> {
      return db.readOne<AwardRow>({
        text: `SELECT * FROM giveaway_award
               WHERE draw_id = $1 AND prize_slot = $2 FOR UPDATE`,
        values: [drawId, slot],
      });
    },
    awardById(id: string): Promise<AwardRow | null> {
      return db.readOne<AwardRow>({
        text: 'SELECT * FROM giveaway_award WHERE id = $1 FOR UPDATE',
        values: [id],
      });
    },
    erasedSubject(id: string) {
      return db.readOne({
        text: "SELECT id FROM subscriber WHERE id=$1 AND status IN ('erasure_pending','erased')",
        values: [id],
      });
    },
    provisionalForSubject(id: string) {
      return db.list<AwardRow>(
        {
          text: "SELECT * FROM giveaway_award WHERE subscriber_id=$1 AND state='notified' ORDER BY id FOR UPDATE",
          values: [id],
        },
        awardBatchLimit,
      );
    },
    async replacedCandidate(
      awardId: string,
      subscriberId: string,
    ): Promise<boolean> {
      const row = await db.readOne<{ found: boolean }>({
        text: `SELECT true AS found FROM giveaway_award_candidate
               WHERE award_id = $1 AND subscriber_id = $2
                 AND outcome = 'replaced'`,
        values: [awardId, subscriberId],
      });
      return row !== null;
    },
    insertAward(input: {
      id: string;
      drawId: string;
      slot: number;
      hash: Buffer;
      selection: AwardSelection;
      notifiedAt: Date;
      deadlineAt: Date;
    }): Promise<number> {
      return db.execute({
        text: `INSERT INTO giveaway_award
                 (id, draw_id, prize_slot, entry_snapshot_hash,
                  selection_position, entry_id, subscriber_id,
                  notified_at, response_deadline_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (draw_id, prize_slot) DO NOTHING`,
        values: [
          input.id,
          input.drawId,
          input.slot,
          input.hash,
          input.selection.position,
          input.selection.entry_id,
          input.selection.subscriber_id,
          input.notifiedAt,
          input.deadlineAt,
        ],
      });
    },
    claimCandidate(input: {
      drawId: string;
      awardId: string;
      selection: AwardSelection;
    }): Promise<number> {
      return db.execute({
        text: `INSERT INTO giveaway_award_candidate
                 (draw_id, selection_position, award_id, subscriber_id)
               VALUES ($1, $2, $3, $4)`,
        values: [
          input.drawId,
          input.selection.position,
          input.awardId,
          input.selection.subscriber_id,
        ],
      });
    },
    nextReserve(drawId: string): Promise<AwardSelection | null> {
      return db.readOne<AwardSelection>({
        text: `SELECT s.position::text, s.entry_id::text,
                      s.subscriber_id::text
               FROM giveaway_draw_selection s
               JOIN subscriber person ON person.id = s.subscriber_id
               WHERE s.draw_id = $1 AND s.is_winner = false
                 AND person.status = 'verified'
                 AND NOT EXISTS (
                   SELECT 1 FROM giveaway_award_candidate c
                   WHERE c.draw_id = s.draw_id
                     AND c.selection_position = s.position)
               ORDER BY s.position`,
        values: [drawId],
      });
    },
    markCandidate(input: {
      drawId: string;
      position: string;
      outcome: 'confirmed' | 'replaced';
      reason: 'age' | 'sanctions' | 'skill' | 'deadline' | 'erasure' | null;
      at: Date;
    }): Promise<number> {
      return db.execute({
        text: `UPDATE giveaway_award_candidate
               SET outcome = $3, reason = $4, checked_at = $5
               WHERE draw_id = $1 AND selection_position = $2
                 AND outcome = 'awaiting'`,
        values: [
          input.drawId,
          input.position,
          input.outcome,
          input.reason,
          input.at,
        ],
      });
    },
    replace(input: {
      awardId: string;
      selection: AwardSelection;
      at: Date;
      deadlineAt: Date;
    }): Promise<number> {
      return db.execute({
        text: `UPDATE giveaway_award SET
                 selection_position = $2, entry_id = $3,
                 subscriber_id = $4, state = 'notified',
                 notified_at = $5, response_deadline_at = $6,
                 country_of_residence = NULL, age_confirmed = NULL,
                 sanctions_passed = NULL, skill_passed = NULL,
                 substitution_state = 'none',
                 substitution_offered_at = NULL,
                 substitution_deadline_at = NULL,
                 substitution_offer = NULL,
                 substitution = NULL, publicity_permission = false,
                 updated_at = $5
               WHERE id = $1`,
        values: [
          input.awardId,
          input.selection.position,
          input.selection.entry_id,
          input.selection.subscriber_id,
          input.at,
          input.deadlineAt,
        ],
      });
    },
    exhaust(id: string, at: Date): Promise<number> {
      return db.execute({
        text: `UPDATE giveaway_award SET state = 'exhausted',
                 updated_at = $2 WHERE id = $1`,
        values: [id, at],
      });
    },
    saveChecks(input: {
      awardId: string;
      country: string;
      skillPassed: boolean | null;
      publicity: boolean;
      at: Date;
    }): Promise<number> {
      return db.execute({
        text: `UPDATE giveaway_award SET state = 'confirmed',
                 country_of_residence = $2, age_confirmed = true,
                 sanctions_passed = true, skill_passed = $3,
                 publicity_permission = $4, updated_at = $5
               WHERE id = $1`,
        values: [
          input.awardId,
          input.country,
          input.skillPassed,
          input.publicity,
          input.at,
        ],
      });
    },
    offerSubstitution(input: {
      awardId: string;
      at: Date;
      deadlineAt: Date;
      offer: unknown;
    }): Promise<number> {
      return db.execute({
        text: `UPDATE giveaway_award
               SET substitution_state = 'offered',
                   substitution_offered_at = $2,
                   substitution_deadline_at = $3,
                   substitution_offer = $4::jsonb,
                   updated_at = $2
               WHERE id = $1 AND state = 'confirmed'
                 AND substitution_state = 'none'`,
        values: [
          input.awardId,
          input.at,
          input.deadlineAt,
          JSON.stringify(input.offer),
        ],
      });
    },
    saveSubstitution(input: {
      awardId: string;
      state: 'replacement' | 'cash';
      detail: unknown;
      at: Date;
    }): Promise<number> {
      return db.execute({
        text: `UPDATE giveaway_award
               SET substitution_state = $2,
                   substitution = $3::jsonb, updated_at = $4
               WHERE id = $1 AND state = 'confirmed'
                 AND substitution_state = 'offered'`,
        values: [
          input.awardId,
          input.state,
          JSON.stringify(input.detail),
          input.at,
        ],
      });
    },
    overduePage(now: Date) {
      return db.list<{ id: string }>(
        {
          text: `SELECT id::text FROM giveaway_award
               WHERE state = 'notified' AND response_deadline_at <= $1
               ORDER BY response_deadline_at, id`,
          values: [now],
        },
        awardBatchLimit,
      );
    },
    substitutionOverduePage(now: Date) {
      return db.list<{ id: string }>(
        {
          text: `SELECT id::text FROM giveaway_award
               WHERE state = 'confirmed'
                 AND substitution_state = 'offered'
                 AND substitution_deadline_at <= $1
               ORDER BY substitution_deadline_at, id`,
          values: [now],
        },
        awardBatchLimit,
      );
    },
  };
}
