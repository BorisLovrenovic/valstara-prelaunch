import type { DatabaseConnection } from './pool.ts';

interface RankedPartner {
  readonly partner_id: string;
  readonly confirmed_signups: number;
}

interface CurrentRank extends RankedPartner {
  readonly rank: number;
  readonly display_name: string | null;
  readonly display_name_disclosure_version: number | null;
  readonly show_on_leaderboard: boolean;
}

const eligible = `p.status = 'active' AND p.personal_data_purged_at IS NULL
  AND s.status = 'verified' AND NOT EXISTS (
    SELECT 1 FROM fraud_flag f WHERE f.subscriber_id = s.id AND f.state <> 'dismissed'
  )`;

const rankingCursor = 'partner_leaderboard_candidates';
const batchSize = 100;
export const partnerLeaderboardTopSize = 20;

export function createPartnerLeaderboardRepository(db: DatabaseConnection) {
  return {
    lockSnapshot() {
      return db.readOne<{ as_of: Date | null }>({
        text: 'SELECT as_of FROM partner_leaderboard_snapshot WHERE singleton FOR UPDATE',
      });
    },

    async replaceSnapshot(asOf: Date) {
      while (
        (await db.execute({
          text: `DELETE FROM partner_leaderboard_rank WHERE rank IN (
            SELECT rank FROM partner_leaderboard_rank ORDER BY rank LIMIT $1
          )`,
          values: [batchSize],
        })) === batchSize
      ) {
        // Delete the old ranks in bounded batches inside the publication transaction.
      }
      await db.execute({
        text: `DECLARE ${rankingCursor} NO SCROLL CURSOR FOR
          SELECT p.id AS partner_id, totals.confirmed_signups
          FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
          CROSS JOIN LATERAL (
            SELECT count(*)::int AS confirmed_signups
            FROM referral_edge e JOIN subscriber friend ON friend.id = e.referred_id
            WHERE e.referrer_id = s.id AND e.state = 'confirmed' AND e.voided_at IS NULL
              AND friend.verified_at IS NOT NULL
              AND friend.status NOT IN ('erasure_pending', 'erased')
          ) totals
          WHERE ${eligible}
          ORDER BY totals.confirmed_signups DESC, s.verified_at ASC NULLS LAST, p.id`,
      });

      let prior = 0;
      for (;;) {
        const page = await db.list<RankedPartner>(
          { cursor: rankingCursor },
          batchSize,
        );
        if (page.length === 0) break;
        await db.execute({
          text: `INSERT INTO partner_leaderboard_rank (partner_id, rank, confirmed_signups)
            SELECT entry.partner_id, ($3::int + entry.position)::int, entry.confirmed_signups
            FROM unnest($1::uuid[], $2::int[]) WITH ORDINALITY
              AS entry(partner_id, confirmed_signups, position)`,
          values: [
            page.map((row) => row.partner_id),
            page.map((row) => row.confirmed_signups),
            prior,
          ],
        });
        prior += page.length;
      }
      await db.execute({
        text: 'UPDATE partner_leaderboard_snapshot SET as_of = $1 WHERE singleton',
        values: [asOf],
      });
    },

    readForViewer(viewerId: string) {
      return db.readOne<{ as_of: Date; rows: readonly CurrentRank[] }>({
        text: `SELECT snap.as_of, COALESCE((
          SELECT jsonb_agg(current_row ORDER BY current_row.rank)
          FROM (
            SELECT ranked.*, p.display_name, p.display_name_disclosure_version,
              p.show_on_leaderboard
            FROM (
              SELECT * FROM partner_leaderboard_rank WHERE rank <= $2
              UNION ALL
              SELECT * FROM partner_leaderboard_rank WHERE partner_id = $1 AND rank > $2
            ) ranked
            JOIN partner p ON p.id = ranked.partner_id
            JOIN subscriber s ON s.id = p.subscriber_id
            WHERE ${eligible}
          ) current_row
        ), '[]') AS rows
        FROM partner_leaderboard_snapshot snap WHERE snap.singleton AND snap.as_of IS NOT NULL`,
        values: [viewerId, partnerLeaderboardTopSize],
      });
    },
  };
}
