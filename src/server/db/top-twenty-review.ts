import type { DatabaseConnection } from './pool.ts';

export interface TopTwentyEntryRow {
  readonly subscriber_id: string;
}

export interface ActiveTopTwentyReviewRow {
  readonly id: string;
  readonly membership_hash: Buffer;
}

export interface TopTwentyReviewRepository {
  createBatch(id: string, membershipHash: Buffer): Promise<void>;
  findActive(): Promise<ActiveTopTwentyReviewRow | null>;
  invalidate(batchId: string): Promise<number>;
  listCurrentMembers(limit: number): Promise<readonly TopTwentyEntryRow[]>;
  recordOutcome(input: {
    readonly actor: string;
    readonly batchId: string;
    readonly outcome: string;
    readonly subscriberId: string;
  }): Promise<void>;
}

export function createTopTwentyReviewRepository(
  database: DatabaseConnection,
): TopTwentyReviewRepository {
  return {
    async createBatch(id, membershipHash) {
      await database.execute({
        text: `
          INSERT INTO top_twenty_review_batch (id, membership_hash)
          VALUES ($1, $2)
        `,
        values: [id, membershipHash],
      });
    },
    findActive() {
      return database.readOne<ActiveTopTwentyReviewRow>({
        text: `
          SELECT id::text, membership_hash
          FROM top_twenty_review_batch
          WHERE invalidated_at IS NULL
          FOR UPDATE
        `,
      });
    },
    invalidate(batchId) {
      return database.execute({
        text: `
          UPDATE top_twenty_review_batch
          SET invalidated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND invalidated_at IS NULL
        `,
        values: [batchId],
      });
    },
    listCurrentMembers(limit) {
      return database.list<TopTwentyEntryRow>(
        {
          text: `
            WITH review_entries AS (
              SELECT id,subscriber_id,entries FROM giveaway_entry
              WHERE voided_at IS NULL AND NOT EXISTS
                (SELECT 1 FROM dsr_erasure e WHERE e.subscriber_id=giveaway_entry.subscriber_id)
              UNION
              SELECT s.entry_id,s.subscriber_id,1 FROM giveaway_draw_snapshot_row s
                JOIN giveaway_draw d ON d.id=s.draw_id
                JOIN dsr_erasure e ON e.subscriber_id=s.subscriber_id
                WHERE d.state <> 'aborted' AND d.snapshot_committed_at IS NOT NULL
            )
            SELECT subscriber_id::text FROM review_entries
            GROUP BY subscriber_id
            ORDER BY SUM(entries) DESC, subscriber_id ASC
          `,
        },
        limit,
      );
    },
    async recordOutcome(input) {
      await database.execute({
        text: `
          INSERT INTO top_twenty_review (
            batch_id, subscriber_id, outcome, actor
          )
          VALUES ($1, $2, $3, $4)
        `,
        values: [input.batchId, input.subscriberId, input.outcome, input.actor],
      });
    },
  };
}
