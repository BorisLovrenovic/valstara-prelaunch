import type { DatabasePool } from '../../src/server/db/pool.ts';

/** Seed an exact ledger count using the same one-unit row shape as accrual. */
export async function seedGiveawayEntryRows(
  database: Pick<DatabasePool, 'readOne'>,
  subscriberId: string,
  count: number,
  options: {
    readonly includeBase?: boolean;
    readonly rulesVersion?: string;
    readonly voidedAt?: Date;
  } = {},
): Promise<void> {
  const includeBase = options.includeBase ?? true;
  if (!Number.isInteger(count) || count < (includeBase ? 1 : 0)) {
    throw new RangeError('The entry fixture needs a non-negative row count.');
  }
  const result = await database.readOne<{ inserted: number }>({
    text: `WITH generated AS (
             SELECT gen_random_uuid() AS id
             FROM generate_series(1, $2::integer - CASE WHEN $5 THEN 1 ELSE 0 END)
           ), referred AS (
             INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
             SELECT id, id::text || '@entry-fixture.test',
                    id::text || '@entry-fixture.test', 'entry-fixture.test', 'verified'
             FROM generated RETURNING id
           ), flagged AS (
             INSERT INTO fraud_flag (id, subscriber_id, kind, detail, state)
             SELECT gen_random_uuid(), id, 'manual', '{}'::jsonb, 'open'
             FROM referred RETURNING subscriber_id
           ), edges AS (
             INSERT INTO referral_edge
               (id, referrer_id, referred_id, state, reward_state)
             SELECT gen_random_uuid(), $1::uuid, subscriber_id, 'confirmed', 'settled'
             FROM flagged RETURNING id
           ), inserted AS (
           INSERT INTO giveaway_entry
             (id, subscriber_id, method, entries, rules_version,
              rules_sha256, source_edge_id, voided_at)
           SELECT gen_random_uuid(), $1::uuid, 'base', 1, $3,
                  decode(repeat('ab', 32), 'hex'), NULL::uuid, $4::timestamptz
           WHERE $5
           UNION ALL
           SELECT gen_random_uuid(), $1::uuid, 'referral', 1, $3,
                  decode(repeat('ab', 32), 'hex'), id, $4::timestamptz
           FROM edges RETURNING id
           )
           SELECT count(*)::integer AS inserted FROM inserted`,
    values: [
      subscriberId,
      count,
      options.rulesVersion ?? 'fixture-v1',
      options.voidedAt ?? null,
      includeBase,
    ],
  });
  if (result?.inserted !== count) {
    throw new Error('The entry fixture did not create the requested rows.');
  }
}
