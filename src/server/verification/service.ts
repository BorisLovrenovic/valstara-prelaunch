import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { DatabaseConnection } from '../db/pool.ts';
import {
  createVerificationTokenRepository,
  type VerificationTokenRepository,
} from '../db/verification-token.ts';

import type { ConsumeResult, CustomerOutcome, TokenPurpose } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;

// Per-purpose expiry (docs/modules/verification.md). Held here as configuration
// so a token's lifetime is decided once, at issue, from its purpose alone.
export const purposeLifetimeMs: Readonly<Record<TokenPurpose, number>> = {
  verify: 7 * DAY_MS,
  status: 30 * DAY_MS,
  unsubscribe: 90 * DAY_MS,
};

export interface IssuedToken {
  /** The plaintext token — it exists only here and in the emailed URL. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface VerificationService {
  issue(subscriberId: string, purpose: TokenPurpose): Promise<IssuedToken>;
  consume(token: string, purpose: TokenPurpose): Promise<ConsumeResult>;
  purgeExpired(before: Date, limit: number): Promise<number>;
}

export interface VerificationServiceDependencies {
  readonly clock?: () => Date;
}

/**
 * Collapse a `ConsumeResult` to the visitor-facing outcome. `verified` and
 * `already` are both success; `expired` and `invalid` are the identical
 * failure, so a rendered page cannot reveal which token hashes exist.
 */
export function customerOutcome(result: ConsumeResult): CustomerOutcome {
  return result === 'verified' || result === 'already' ? 'ok' : 'rejected';
}

// SHA-256 of the token. Only this ever reaches the database — never the
// plaintext (ADR-011, standing rule 6 on double opt-in tokens).
function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

// 256 bits from the CSPRNG, url-safe. Unguessable and non-sequential.
function createToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The verification-token domain module (E3-06). It owns single-use, hashed,
 * expiring tokens with a purpose discriminator and per-purpose expiry. All SQL
 * lives in the `verification-token` data layer; this module holds only the
 * hashing, the token generation and the consume decision.
 *
 * The factory takes a `DatabaseConnection` — the minimal interface these
 * methods need — so a caller running inside a transaction (E3-07's verify
 * transaction) can bind the service to its own connection and consume a token
 * atomically alongside the other state transitions.
 */
export function createVerificationService(
  database: DatabaseConnection,
  dependencies: VerificationServiceDependencies = {},
): VerificationService {
  const clock = dependencies.clock ?? (() => new Date());
  return createVerificationServiceWithRepository(
    createVerificationTokenRepository(database),
    clock,
  );
}

export function createVerificationServiceWithRepository(
  repository: VerificationTokenRepository,
  clock: () => Date,
): VerificationService {
  return {
    async issue(subscriberId, purpose) {
      const token = createToken();
      const expiresAt = new Date(clock().getTime() + purposeLifetimeMs[purpose]);

      await repository.insert({
        expiresAt,
        id: randomUUID(),
        purpose,
        subscriberId,
        tokenHash: tokenHash(token),
      });

      return { expiresAt, token };
    },

    async consume(token, purpose) {
      if (token === '') {
        return 'invalid';
      }

      const now = clock();
      const hash = tokenHash(token);

      // The atomic update is the single-use primitive: exactly one concurrent
      // consume of a fresh token changes a row.
      const consumed = await repository.consumeFresh(hash, purpose, now);
      if (consumed === 1) {
        return 'verified';
      }

      // The fresh consume did not land — classify why, without leaking whether
      // a token hash exists beyond the expired/invalid pair the caller renders
      // identically.
      const existing = await repository.findByHash(hash);
      if (existing === null || existing.purpose !== purpose) {
        return 'invalid';
      }
      if (existing.consumed_at !== null) {
        return 'already';
      }
      if (existing.expires_at <= now) {
        return 'expired';
      }
      // Unconsumed and unexpired, yet the update did not land: another consumer
      // took it between the update and this read. That is a successful replay.
      return 'already';
    },

    async purgeExpired(before, limit) {
      return repository.purgeExpired(before, limit);
    },
  };
}
