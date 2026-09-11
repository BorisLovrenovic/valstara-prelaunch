import { randomUUID } from 'node:crypto';

import type { DatabasePool } from '../db/pool.ts';
import type { UtmParameters } from '../referral/capture.ts';
import { createSubscriberRepository } from '../db/subscriber.ts';
import { withTransaction } from '../db/transaction.ts';
import { consumeRateLimit } from '../ratelimit/consume.ts';

import { normaliseEmail, type NormalisedEmail } from './normalise-email.ts';
import {
  queueVerificationMail,
  type VerificationMailSender,
} from './verification-mail.ts';

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
 * code set (`docs/api/README.md`): `invalid_email` → 400 `invalid_email`; every
 * non-error outcome maps to the same 200 pending response. The internal
 * `already_verified` outcome lets the service suppress a second mail without
 * exposing membership through the route. `existing` covers a pending repeat,
 * whether the verification mail was re-queued or throttled — both receive the
 * same neutral accepted response, so the throttle never leaks.
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
  readonly utm?: UtmParameters | null;
  readonly verificationUrl: (token: string) => string;
}

export interface SignupServiceDependencies {
  readonly clock?: () => Date;
  readonly sendVerificationMail: VerificationMailSender;
}

async function upsertSubscriber(
  database: DatabasePool,
  email: NormalisedEmail,
  country: string,
  region: string | null,
  utm: UtmParameters | null,
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
      utm,
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
      input.utm ?? null,
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
