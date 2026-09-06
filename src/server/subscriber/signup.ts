import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { DatabasePool } from '../db/pool.ts';
import { createSubscriberRepository } from '../db/subscriber.ts';
import { withTransaction } from '../db/transaction.ts';
import { consumeRateLimit } from '../ratelimit/consume.ts';

import { normaliseEmail, type NormalisedEmail } from './normalise-email.ts';
import type { VerificationMailSender } from './verification-mail.ts';

const verificationLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

// One verification mail per normalised address per window. The limit is 1 by
// design, not by tuning: it is what makes a concurrent double-submit produce
// exactly one email (both racers increment the same bucket row atomically, and
// only the one that lands on count 1 sends), while a genuine repeat after the
// window has elapsed re-queues a fresh link. Raising it would break the
// "double submission produces one email" invariant.
export const verificationSendWindowMs = 15 * 60 * 1_000;
export const verificationSendLimit = 1;

/**
 * The subscriber the route needs to shape its response: only the status and
 * whether this request created the row. No personal data beyond the id leaves
 * the module for the route to echo.
 */
export interface SignupSubscriber {
  readonly id: string;
  readonly status: string;
  readonly created: boolean;
}

/**
 * Discriminated outcome of `signup()`. The route maps it onto the closed error
 * code set (`docs/api/README.md`): `invalid_email` → 400 `invalid_email`,
 * `already_verified` → 200 `already_verified`, and `created`/`existing` → the
 * 200 pending response. `existing` covers a pending repeat, whether the
 * verification mail was re-queued or throttled — both are the same honest
 * "check your inbox" response, so the throttle never leaks.
 */
export type SignupOutcome =
  | { readonly kind: 'created'; readonly subscriber: SignupSubscriber }
  | { readonly kind: 'existing'; readonly subscriber: SignupSubscriber }
  | { readonly kind: 'already_verified'; readonly subscriber: SignupSubscriber }
  | { readonly kind: 'invalid_email' };

export interface SignupInput {
  readonly email: string;
  readonly country: string;
  readonly region?: string | undefined;
  readonly verificationUrl: (token: string) => string;
}

export interface SignupServiceDependencies {
  readonly clock?: () => Date;
  readonly sendVerificationMail: VerificationMailSender;
}

interface QueuedVerificationMail {
  readonly businessKey: string;
  readonly verificationUrl: string;
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function createVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

async function upsertSubscriber(
  database: DatabasePool,
  email: NormalisedEmail,
  country: string,
  region: string | null,
): Promise<SignupSubscriber> {
  return withTransaction(database, async (connection) => {
    const repository = createSubscriberRepository(connection);
    const subscriberId = randomUUID();
    const inserted = await repository.insertPending({
      country,
      email: email.raw,
      emailDomain: email.domain,
      emailNormalised: email.normalised,
      id: subscriberId,
      region,
    });

    if (inserted === 1) {
      return { created: true, id: subscriberId, status: 'pending' };
    }

    const existing = await repository.findByNormalised(email.normalised);

    if (existing === null) {
      // The conflicting row must exist — the insert reported a conflict.
      throw new Error('Conflicting subscriber row could not be read back.');
    }

    return { created: false, id: existing.id, status: existing.status };
  });
}

async function queueVerificationMail(
  database: DatabasePool,
  subscriberId: string,
  verificationUrl: (token: string) => string,
  now: Date,
): Promise<QueuedVerificationMail> {
  return withTransaction(database, async (connection) => {
    const repository = createSubscriberRepository(connection);
    const tokenId = randomUUID();
    const token = createVerificationToken();
    const businessKey = `verify:${subscriberId}:${tokenId}`;
    const expiresAt = new Date(now.getTime() + verificationLifetimeMs);

    await repository.insertVerificationToken({
      expiresAt,
      id: tokenId,
      subscriberId,
      tokenHash: tokenHash(token),
    });
    await repository.insertQueuedVerificationEmail({
      businessKey,
      id: randomUUID(),
      subscriberId,
    });

    return { businessKey, verificationUrl: verificationUrl(token) };
  });
}

/**
 * The signup domain step: normalise, upsert on the normalised uniqueness key,
 * and — only for a pending row and only when the per-address send window
 * permits — queue and send a verification mail. Normalisation runs before the
 * uniqueness check (the `ON CONFLICT` inside `upsertSubscriber`), and a send
 * failure is swallowed because the queued `email_send` row is the source of
 * truth; neither the send nor its failure touches the committed subscriber row.
 */
export function createSignupService(
  database: DatabasePool,
  dependencies: SignupServiceDependencies,
): (input: SignupInput) => Promise<SignupOutcome> {
  const clock = dependencies.clock ?? (() => new Date());

  return async (input) => {
    const normalised = normaliseEmail(input.email);
    if (normalised === null) {
      return { kind: 'invalid_email' };
    }

    const region =
      input.region !== undefined && input.region !== '' ? input.region : null;
    const subscriber = await upsertSubscriber(
      database,
      normalised,
      input.country,
      region,
    );

    if (subscriber.status === 'verified') {
      return { kind: 'already_verified', subscriber };
    }
    if (subscriber.status !== 'pending') {
      // Reachable only once later tickets introduce expired/unsubscribed/
      // bounced/disqualified rows; none re-sends a verification mail here.
      return { kind: 'existing', subscriber };
    }

    const now = clock();
    const sendCount = await consumeRateLimit(
      database,
      `signup:verify:${normalised.normalised}`,
      verificationSendWindowMs,
      now,
    );

    if (sendCount <= verificationSendLimit) {
      const mail = await queueVerificationMail(
        database,
        subscriber.id,
        input.verificationUrl,
        now,
      );
      try {
        await dependencies.sendVerificationMail(mail);
      } catch {
        // The queued email_send row is the record; E8 owns dispatch and retry.
      }
    }

    return {
      kind: subscriber.created ? 'created' : 'existing',
      subscriber,
    };
  };
}
