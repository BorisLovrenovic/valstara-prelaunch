import type { DatabaseConnection } from './pool.ts';

export type ReferralCodeOwnerKind = 'member' | 'partner';

export interface ReferralCodeEntry {
  readonly active: boolean;
  readonly code: string;
  /** Null only for a retired member code whose subscriber was erased. */
  readonly owner_id: string | null;
  readonly owner_kind: ReferralCodeOwnerKind;
}

/** The largest set of codes one availability query may ask about. */
export const referralCodeAvailabilityBatchLimit = 64;

/**
 * The shared code registry (E11.7-01). Codes reaching this layer are already
 * upper case; the table's checks refuse anything else.
 */
export interface ReferralCodeRepository {
  /** Claims a code for a member. False when the code is already registered. */
  claimMemberCode(code: string, subscriberId: string): Promise<boolean>;
  findByCode(code: string): Promise<ReferralCodeEntry | null>;
  /** The subset of `codes` already registered, in any state. */
  findRegistered(codes: readonly string[]): Promise<ReadonlySet<string>>;
}

export function createReferralCodeRepository(
  database: DatabaseConnection,
): ReferralCodeRepository {
  return {
    async claimMemberCode(code, subscriberId) {
      // DO NOTHING rather than raising, so a collision inside the verification
      // transaction leaves that transaction usable for the next attempt.
      const inserted = await database.execute({
        text: `
          INSERT INTO referral_code (code, owner_kind, owner_id)
          VALUES ($1, 'member', $2)
          ON CONFLICT DO NOTHING
        `,
        values: [code, subscriberId],
      });
      return inserted === 1;
    },

    async findByCode(code) {
      return database.readOne<ReferralCodeEntry>({
        text: `
          SELECT code, owner_kind, owner_id, active
          FROM referral_code
          WHERE code = $1
        `,
        values: [code],
      });
    },

    async findRegistered(codes) {
      if (codes.length === 0) {
        return new Set();
      }
      if (codes.length > referralCodeAvailabilityBatchLimit) {
        throw new RangeError(
          `At most ${referralCodeAvailabilityBatchLimit} codes may be checked at once.`,
        );
      }
      const rows = await database.list<{ code: string }>(
        {
          text: 'SELECT code FROM referral_code WHERE code = ANY($1::text[])',
          values: [codes],
        },
        codes.length,
      );
      return new Set(rows.map((row) => row.code));
    },
  };
}
