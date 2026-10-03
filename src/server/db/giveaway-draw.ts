import type { ChainInfo, RandomnessBeacon } from 'drand-client';

import type { DatabaseConnection } from './pool.ts';

export const drawBatchLimit = 1_000;

export interface LedgerEntryRow {
  readonly id: string;
  readonly subscriber_id: string;
  readonly method: 'base' | 'referral';
  readonly source_edge_id: string | null;
  readonly rules_version: string;
  readonly rules_sha256: Buffer;
}

export interface SnapshotRow extends LedgerEntryRow {
  readonly selection_score: number | null;
}

export interface DrawRow {
  readonly id: string;
  readonly state: 'pending' | 'published' | 'aborted';
  readonly entry_snapshot_hash: Buffer | null;
  readonly snapshot_committed_at: Date | null;
  readonly snapshot_count: string;
  readonly prize_count: number | null;
  readonly rules_version: string | null;
  readonly rules_sha256: Buffer | null;
  readonly drand_chain_hash: Buffer | null;
  readonly drand_chain_info: ChainInfo | null;
  readonly target_round: string | null;
  readonly target_round_at: Date | null;
  readonly beacon_round: string | null;
  readonly beacon_randomness: Buffer | null;
  readonly beacon_signature: Buffer | null;
  readonly beacon_previous_signature: Buffer | null;
  readonly beacon_relay_used: string | null;
  readonly beacon_verified_relays: string[] | null;
  readonly seed: string | null;
  readonly seed_generated_at: Date | null;
  readonly winners: string[] | null;
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
  readonly published_at: Date | null;
  readonly reproduced_at: Date | null;
  readonly executed_by: string;
}

export interface SelectionRow {
  readonly position: string;
  readonly subscriber_id: string;
  readonly entry_id: string;
  readonly selection_score?: number;
  readonly is_winner?: boolean;
}

export function createGiveawayDrawRepository(database: DatabaseConnection) {
  return {
    async lockEntryLedger(): Promise<void> {
      await database.readOne({ text: 'SELECT pg_advisory_xact_lock(705, 5)' });
    },
    active(): Promise<DrawRow | null> {
      return database.readOne<DrawRow>({
        text: `SELECT * FROM giveaway_draw WHERE state <> 'aborted' FOR UPDATE`,
      });
    },
    byId(drawId: string): Promise<DrawRow | null> {
      return database.readOne<DrawRow>({
        text: 'SELECT * FROM giveaway_draw WHERE id = $1',
        values: [drawId],
      });
    },
    createPending(drawId: string, actor: string): Promise<number> {
      return database.execute({
        text: `INSERT INTO giveaway_draw (id, executed_by) VALUES ($1, $2)`,
        values: [drawId, actor],
      });
    },
    ledgerPage(afterId: string | null): Promise<readonly LedgerEntryRow[]> {
      return database.list<LedgerEntryRow>(
        {
          text: `SELECT id::text, subscriber_id::text, method,
                      source_edge_id::text, rules_version, rules_sha256
               FROM giveaway_entry WHERE voided_at IS NULL AND NOT EXISTS (SELECT 1 FROM subscriber s WHERE s.id=giveaway_entry.subscriber_id AND s.status IN ('erasure_pending','erased'))
                 AND ($1::uuid IS NULL OR id > $1::uuid)
               ORDER BY id`,
          values: [afterId],
        },
        drawBatchLimit,
      );
    },
    eligiblePersonCount(): Promise<number> {
      return database
        .readOne<{ count: string }>({
          text: `SELECT count(DISTINCT subscriber_id)::text AS count
               FROM giveaway_entry WHERE voided_at IS NULL AND NOT EXISTS (SELECT 1 FROM subscriber s WHERE s.id=giveaway_entry.subscriber_id AND s.status IN ('erasure_pending','erased'))`,
        })
        .then((row) => Number(row?.count ?? 0));
    },
    copySnapshot(drawId: string, entryIds: readonly string[]): Promise<number> {
      return database.execute({
        text: `INSERT INTO giveaway_draw_snapshot_row
                 (draw_id, entry_id, subscriber_id, method, source_edge_id,
                  rules_version, rules_sha256)
               SELECT $1, id, subscriber_id, method, source_edge_id,
                      rules_version, rules_sha256
               FROM giveaway_entry WHERE id = ANY($2::uuid[]) AND voided_at IS NULL`,
        values: [drawId, entryIds],
      });
    },
    commitSnapshot(input: {
      drawId: string;
      hash: Buffer;
      count: number;
      committedAt: Date;
      info: ChainInfo;
      round: number;
      roundAt: Date;
      prizeCount: number;
      rulesVersion: string;
      rulesSha256: string;
    }): Promise<number> {
      return database.execute({
        text: `UPDATE giveaway_draw SET entry_snapshot_hash = $2,
                 snapshot_count = $3, snapshot_committed_at = $4,
                 drand_chain_hash = decode($5, 'hex'), drand_chain_info = $6::jsonb,
                 target_round = $7, target_round_at = $8, next_attempt_at = $8,
                 prize_count = $9, rules_version = $10,
                 rules_sha256 = decode($11, 'hex')
               WHERE id = $1 AND snapshot_committed_at IS NULL`,
        values: [
          input.drawId,
          input.hash,
          input.count,
          input.committedAt,
          input.info.hash,
          JSON.stringify(input.info),
          input.round,
          input.roundAt,
          input.prizeCount,
          input.rulesVersion,
          input.rulesSha256,
        ],
      });
    },
    abort(drawId: string): Promise<number> {
      return database.execute({
        text: `UPDATE giveaway_draw SET state = 'aborted'
               WHERE id = $1 AND state = 'pending' AND seed IS NULL`,
        values: [drawId],
      });
    },
    duePending(now: Date): Promise<DrawRow | null> {
      return database.readOne<DrawRow>({
        text: `SELECT * FROM giveaway_draw WHERE state = 'pending'
                 AND snapshot_committed_at IS NOT NULL
                 AND next_attempt_at <= $1 FOR UPDATE SKIP LOCKED`,
        values: [now],
      });
    },
    scheduleRetry(
      drawId: string,
      attempt: number,
      nextAt: Date,
      alertedAt: Date,
    ): Promise<number> {
      return database.execute({
        text: `UPDATE giveaway_draw SET attempt_count = $2,
                 next_attempt_at = $3, last_alert_at = $4
               WHERE id = $1 AND state = 'pending'`,
        values: [drawId, attempt, nextAt, alertedAt],
      });
    },
    snapshotPage(
      drawId: string,
      afterId: string | null,
    ): Promise<readonly SnapshotRow[]> {
      return database.list<SnapshotRow>(
        {
          text: `SELECT entry_id::text AS id, subscriber_id::text, method,
                      source_edge_id::text, rules_version, rules_sha256,
                      selection_score
               FROM giveaway_draw_snapshot_row WHERE draw_id = $1
                 AND ($2::uuid IS NULL OR entry_id > $2::uuid)
               ORDER BY entry_id`,
          values: [drawId, afterId],
        },
        drawBatchLimit,
      );
    },
    storeScores(
      drawId: string,
      ids: readonly string[],
      scores: readonly number[],
    ): Promise<number> {
      return database.execute({
        text: `UPDATE giveaway_draw_snapshot_row AS s SET selection_score = v.score
               FROM unnest($2::uuid[], $3::double precision[]) AS v(id, score)
               WHERE s.draw_id = $1 AND s.entry_id = v.id`,
        values: [drawId, ids, scores],
      });
    },
    scoredPage(
      drawId: string,
      afterScore: number | null,
      afterId: string | null,
    ): Promise<
      readonly { id: string; subscriber_id: string; selection_score: number }[]
    > {
      return database.list<{
        id: string;
        subscriber_id: string;
        selection_score: number;
      }>(
        {
          text: `SELECT entry_id::text AS id, subscriber_id::text, selection_score
               FROM giveaway_draw_snapshot_row WHERE draw_id = $1
                 AND selection_score IS NOT NULL
                 AND ($2::double precision IS NULL OR
                      (selection_score, entry_id) > ($2, $3::uuid))
               ORDER BY selection_score, entry_id`,
          values: [drawId, afterScore, afterId],
        },
        drawBatchLimit,
      );
    },
    insertSelections(
      drawId: string,
      positions: readonly number[],
      subscriberIds: readonly string[],
      entryIds: readonly string[],
    ): Promise<number> {
      return database.execute({
        text: `INSERT INTO giveaway_draw_selection
                 (draw_id, position, subscriber_id, entry_id, is_winner)
               SELECT $1, v.position, v.subscriber_id, v.entry_id, false
               FROM unnest($2::bigint[], $3::uuid[], $4::uuid[])
                    AS v(position, subscriber_id, entry_id)
               ORDER BY v.position
               ON CONFLICT (draw_id, subscriber_id) DO NOTHING`,
        values: [drawId, positions, subscriberIds, entryIds],
      });
    },
    markWinners(drawId: string, prizeCount: number): Promise<number> {
      return database.execute({
        text: `UPDATE giveaway_draw_selection SET is_winner = true
               WHERE draw_id = $1 AND position IN (
                 SELECT position FROM giveaway_draw_selection
                 WHERE draw_id = $1 ORDER BY position LIMIT $2
               )`,
        values: [drawId, prizeCount],
      });
    },
    selectionsPage(
      drawId: string,
      afterPosition: string | null,
    ): Promise<readonly SelectionRow[]> {
      return database.list<SelectionRow>(
        {
          text: `SELECT position::text, subscriber_id::text, entry_id::text, is_winner
               FROM giveaway_draw_selection WHERE draw_id = $1
                 AND ($2::bigint IS NULL OR position > $2::bigint)
               ORDER BY position`,
          values: [drawId, afterPosition],
        },
        drawBatchLimit,
      );
    },
    expectedUniquePage(
      drawId: string,
      afterScore: number | null,
      afterId: string | null,
    ): Promise<readonly SelectionRow[]> {
      return database.list<SelectionRow>(
        {
          text: `WITH firsts AS (
                 SELECT DISTINCT ON (subscriber_id)
                   subscriber_id, entry_id, selection_score
                 FROM giveaway_draw_snapshot_row WHERE draw_id = $1
                 ORDER BY subscriber_id, selection_score, entry_id
               )
               SELECT subscriber_id::text, entry_id::text, selection_score
               FROM firsts
               WHERE $2::double precision IS NULL OR
                     (selection_score, entry_id) > ($2, $3::uuid)
               ORDER BY selection_score, entry_id`,
          values: [drawId, afterScore, afterId],
        },
        drawBatchLimit,
      );
    },
    winnerIds(drawId: string, prizeCount: number): Promise<readonly string[]> {
      return database
        .list<{ subscriber_id: string }>(
          {
            text: `SELECT subscriber_id::text FROM giveaway_draw_selection
               WHERE draw_id = $1 AND is_winner = true ORDER BY position`,
            values: [drawId],
          },
          prizeCount,
        )
        .then((rows) => rows.map((row) => row.subscriber_id));
    },
    storeBeacon(input: {
      drawId: string;
      seed: string;
      beacon: RandomnessBeacon;
      relay: string;
      verifiedRelays: readonly string[];
      at: Date;
      winners: readonly string[];
    }): Promise<number> {
      return database.execute({
        text: `UPDATE giveaway_draw SET beacon_round = $2,
                 beacon_randomness = decode($3, 'hex'),
                 beacon_signature = decode($4, 'hex'),
                 beacon_previous_signature = CASE WHEN $5::text IS NULL
                   THEN NULL ELSE decode($5, 'hex') END,
                 beacon_relay_used = $6, beacon_verified_relays = $7::jsonb,
                 seed = $8, seed_generated_at = $9, executed_at = $9,
                 winners = $10::jsonb
               WHERE id = $1 AND state = 'pending' AND seed IS NULL`,
        values: [
          input.drawId,
          input.beacon.round,
          input.beacon.randomness,
          input.beacon.signature,
          'previous_signature' in input.beacon
            ? input.beacon.previous_signature
            : null,
          input.relay,
          JSON.stringify(input.verifiedRelays),
          input.seed,
          input.at,
          JSON.stringify(input.winners),
        ],
      });
    },
    publish(drawId: string, at: Date): Promise<number> {
      return database.execute({
        text: `UPDATE giveaway_draw SET state = 'published',
                 reproduced_at = $2, published_at = $2
               WHERE id = $1 AND state = 'pending' AND seed IS NOT NULL`,
        values: [drawId, at],
      });
    },
  };
}
