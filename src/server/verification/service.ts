import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { DatabaseConnection } from '../db/pool.ts';
import {
  createVerificationTokenRepository,
  type VerificationTokenRepository,
} from '../db/verification-token.ts';

import type {
  ConsumeResult,
  CustomerOutcome,
  TokenPurpose,
  VerificationCompletionConsumeResult,
} from './types.ts';

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
  consumeForVerification(
    token: string,
  ): Promise<VerificationCompletionConsumeResult>;
  consumeForPurpose(
    token: string,
    purpose: TokenPurpose,
  ): Promise<VerificationCompletionConsumeResult>;
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

function createVerificationServiceWithRepository(
  repository: VerificationTokenRepository,
  clock: () => Date,
): VerificationService {
  return {
    async issue(subscriberId, purpose) {
      const token = createToken();
      const expiresAt = new Date(
        clock().getTime() + purposeLifetimeMs[purpose],
      );

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
      return (await consumeWithSubscriber(repository, token, purpose, clock))
        .outcome;
    },

    async consumeForVerification(token) {
      return consumeWithSubscriber(repository, token, 'verify', clock);
    },

    async consumeForPurpose(token, purpose) {
      return consumeWithSubscriber(repository, token, purpose, clock);
    },

    async purgeExpired(before, limit) {
      return repository.purgeExpired(before, limit);
    },
  };
}

async function consumeWithSubscriber(
  repository: VerificationTokenRepository,
  token: string,
  purpose: TokenPurpose,
  clock: () => Date,
): Promise<VerificationCompletionConsumeResult> {
  if (token === '') {
    return { outcome: 'invalid', subscriberId: null };
  }

  const now = clock();
  const hash = tokenHash(token);
  const consumed = await repository.consumeFresh(hash, purpose, now);
  const existing = await repository.findByHash(hash);

  if (consumed === 1) {
    if (existing === null) {
      throw new Error('A consumed verification token could not be read.');
    }
    return { outcome: 'verified', subscriberId: existing.subscriber_id };
  }
  if (existing === null || existing.purpose !== purpose) {
    return { outcome: 'invalid', subscriberId: null };
  }
  // Status links are reusable bearer credentials, but never beyond expiry.
  // Verification-token replays retain their existing success semantics.
  if (purpose === 'status' && existing.expires_at <= now) {
    return { outcome: 'expired', subscriberId: null };
  }
  if (existing.consumed_at !== null) {
    return { outcome: 'already', subscriberId: existing.subscriber_id };
  }
  if (existing.expires_at <= now) {
    return { outcome: 'expired', subscriberId: null };
  }
  return { outcome: 'already', subscriberId: existing.subscriber_id };
}
