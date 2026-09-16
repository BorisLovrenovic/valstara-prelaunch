import type { DatabaseConnection } from './pool.ts';

export interface IpVelocityRepository {
  countSince(prefixHash: Buffer, since: Date): Promise<number>;
  purgeBefore(before: Date, limit: number): Promise<number>;
}

export function createIpVelocityRepository(
  database: DatabaseConnection,
): IpVelocityRepository {
  return {
    async countSince(prefixHash, since) {
      const row = await database.readOne<{ readonly count: string }>({
        text: `SELECT count(*)::text AS count FROM subscriber
               WHERE signup_ip_prefix_hash = $1 AND created_at >= $2`,
        values: [prefixHash, since],
      });
      return Number(row?.count ?? '0');
    },
    async purgeBefore(before, limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError('An IP-prefix retention limit must be positive.');
      }
      return database.execute({
        text: `UPDATE subscriber
               SET signup_ip_prefix_hash = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE id IN (
                 SELECT id FROM (
                   SELECT id FROM subscriber
                   WHERE signup_ip_prefix_hash IS NOT NULL AND created_at < $1
                   ORDER BY created_at ASC
                   LIMIT $2
                 ) AS expired
               )`,
        values: [before, limit],
      });
    },
  };
}
