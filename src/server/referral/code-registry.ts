import {
  createReferralCodeRepository,
  type ReferralCodeOwnerKind,
} from '../db/referral-code.ts';
import type { DatabaseConnection } from '../db/pool.ts';

export interface ReferralCodeOwner {
  readonly active: boolean;
  /** The registry's stored, upper-case form of the code. */
  readonly code: string;
  /** Null only for a retired member code whose subscriber was erased. */
  readonly ownerId: string | null;
  readonly ownerKind: ReferralCodeOwnerKind;
}

export interface ReferralCodeRegistry {
  /** Case-insensitive lookup of any member or partner code. */
  lookup(code: string): Promise<ReferralCodeOwner | null>;
}

/**
 * Upper-cases ASCII letters only. Every registered code is upper case, so this
 * makes lookup case-insensitive without any locale-dependent case mapping.
 */
export function normaliseReferralCodeForLookup(code: string): string {
  return code.replace(/[a-z]/gu, (letter) => letter.toUpperCase());
}

/** The shared code registry's lookup (E11.7-01). */
export function createReferralCodeRegistry(
  database: DatabaseConnection,
): ReferralCodeRegistry {
  const repository = createReferralCodeRepository(database);
  return {
    async lookup(code) {
      const entry = await repository.findByCode(
        normaliseReferralCodeForLookup(code),
      );
      if (entry === null) {
        return null;
      }
      return {
        active: entry.active,
        code: entry.code,
        ownerId: entry.owner_id,
        ownerKind: entry.owner_kind,
      };
    },
  };
}
