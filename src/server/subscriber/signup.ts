import { randomUUID } from 'node:crypto';

import type { DatabasePool } from '../db/pool.ts';
import type { UtmParameters } from '../referral/capture.ts';
import type { FraudScreenFlag, ScreenResult } from '../fraud/service.ts';
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
  | { readonly kind: 'invalid_email' }
  | { readonly kind: 'blocked_domain' };

export interface SignupInput {
  readonly email: string;
  readonly country: string;
  readonly region?: string | undefined;
  readonly referralCode?: string | null;
  readonly utm?: UtmParameters | null;
  readonly signupIpPrefixHash?: Buffer | null;
  readonly verificationUrl: (token: string) => string;
}

export interface SignupServiceDependencies {
  readonly clock?: () => Date;
  readonly attributeReferral?: (
    referredId: string,
    code: string,
    allowAttribution: boolean,
  ) => Promise<unknown>;
  readonly isReferralEnabled?: () => Promise<boolean>;
  readonly flagDuplicateIdentity?: (subscriberId: string) => Promise<boolean>;
  readonly flagIpVelocity?: (
    subscriberId: string,
    prefixHash: Buffer,
  ) => Promise<boolean>;
  readonly raiseFraudFlag: (
    subscriberId: string,
    kind: FraudScreenFlag,
    detail: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly screenEmailDomain: (domain: string) => Promise<ScreenResult>;
  readonly sendVerificationMail: VerificationMailSender;
}

async function upsertSubscriber(
  database: DatabasePool,
  email: NormalisedEmail,
  country: string,
  region: string | null,
  utm: UtmParameters | null,
  signupIpPrefixHash: Buffer | null,
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
      signupIpPrefixHash,
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
 * The signup domain step: normalise, run the domain screen, upsert on the
 * normalised uniqueness key, attribute, raise post-upsert fraud signals, and
 * — only for a pending row and only when the per-address send window permits —
 * queue and send a verification mail. Normalisation and screening both run
 * before the uniqueness check (the `ON CONFLICT` inside `upsertSubscriber`),
 * and a send or flag failure is swallowed because neither may roll back or
 * reject the committed subscriber row.
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

    // E5-01 owns this step. It is after normalisation and before the first
    // uniqueness query or write, matching docs/api/README.md's load-bearing
    // route order.
    const screen = await dependencies.screenEmailDomain(normalised.domain);
    if (screen.reject !== undefined) {
      return { kind: screen.reject };
    }

    const region =
      input.region !== undefined && input.region !== '' ? input.region : null;
    const subscriber = await upsertSubscriber(
      database,
      normalised,
      input.country,
      region,
      input.utm ?? null,
      input.signupIpPrefixHash ?? null,
    );

    // A DNS timeout must never cost a real signup. The row is committed first
    // because fraud_flag requires its id; flagging is best-effort metadata and
    // cannot turn the accepted signup back into a failure.
    for (const kind of screen.flags) {
      try {
        await dependencies.raiseFraudFlag(subscriber.id, kind, {
          domain: normalised.domain,
          reason: 'mx_lookup_timeout',
        });
      } catch {
        // The subscriber row remains the source of truth and can still verify.
      }
    }

    // Only the initial row can receive attribution. Existing subscribers are
    // still checked for self-referral, but their original referrer is never
    // reassigned.
    if (
      input.referralCode !== undefined &&
      input.referralCode !== null &&
      dependencies.attributeReferral !== undefined &&
      (await (dependencies.isReferralEnabled?.() ?? Promise.resolve(false)))
    ) {
      await dependencies.attributeReferral(
        subscriber.id,
        input.referralCode,
        subscriber.created,
      );
    }

    // E5-02: this signal applies only to the newly inserted identity. Repeats
    // of an existing signup are not new identities and must not create review
    // noise. The signal is metadata only, so a lookup or flag-write failure
    // cannot turn an accepted signup into a rejection.
    if (
      subscriber.created &&
      dependencies.flagDuplicateIdentity !== undefined
    ) {
      try {
        await dependencies.flagDuplicateIdentity(subscriber.id);
      } catch {
        // Fraud signals never change subscriber status or reject a signup.
      }
    }

    if (
      subscriber.created &&
      dependencies.flagIpVelocity !== undefined &&
      input.signupIpPrefixHash !== undefined &&
      input.signupIpPrefixHash !== null
    ) {
      try {
        await dependencies.flagIpVelocity(
          subscriber.id,
          input.signupIpPrefixHash,
        );
      } catch {
        /* Fraud flags never reject signups. */
      }
    }

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
