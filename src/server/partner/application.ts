import { randomUUID } from 'node:crypto';
import { setTimeout as systemSleep } from 'node:timers/promises';

import { createPartnerRepository } from '../db/partner.ts';
import type { DatabasePool } from '../db/pool.ts';
import { createSubscriberRepository } from '../db/subscriber.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import type { FraudScreenFlag, ScreenResult } from '../fraud/service.ts';
import type {
  PartnerCodeCheck,
  PartnerCodeRefusalReason,
} from '../referral/partner-code.ts';
import { consumeRateLimit } from '../ratelimit/consume.ts';
import { normaliseEmail } from '../subscriber/normalise-email.ts';
import type { TurnstileOutcome } from '../turnstile/verify.ts';
import { createVerificationService } from '../verification/service.ts';

import {
  partnerApplicationIpLimit,
  partnerApplicationMailLimit,
  partnerApplicationMailWindowMs,
  partnerApplicationStrictIpLimit,
} from './config.ts';
import {
  parsePartnerApplication,
  readPartnerApplicationValues,
  type PartnerApplicationField,
  type PartnerApplicationFields,
  type PartnerApplicationValues,
  type PartnerFieldError,
} from './fields.ts';

/** The template and business keys of the two application emails (D-050 Q4). */
export const partnerConfirmationTemplate = 'partner_application_confirm';
export const partnerReceivedTemplate = 'partner_application_received';
export function partnerConfirmationBusinessKey(partnerId: string): string {
  return `partner-application:${partnerId}`;
}
export function partnerReceivedBusinessKey(partnerId: string): string {
  return `partner-application-received:${partnerId}`;
}

/** Every request that can reveal membership takes at least this long. */
export const partnerApplicationResponseTargetMs = 500;

/**
 * The submit domain step's outcome. `accepted` is the one neutral answer for
 * a new, a pending and a verified member and for every address that gets no
 * mail, so the response never says whether an address is known.
 */
export type PartnerSubmitOutcome =
  | { readonly kind: 'accepted'; readonly subscriberId: string | null }
  | { readonly kind: 'invalid_email' }
  | { readonly kind: 'blocked_domain' };

export interface PartnerSubmitInput {
  readonly fields: PartnerApplicationFields;
  /** The code that passed the E11.7-01 rules, upper case. */
  readonly requestedCode: string;
  readonly signupIpPrefixHash: Buffer | null;
  readonly challengeTimedOut: boolean;
}

export interface PartnerSubmitDependencies {
  readonly clock?: () => Date;
  readonly screenEmailDomain: (domain: string) => Promise<ScreenResult>;
  readonly raiseFraudFlag: (
    subscriberId: string,
    kind: FraudScreenFlag,
    detail: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly flagDuplicateIdentity?: (subscriberId: string) => Promise<boolean>;
  readonly flagIpVelocity?: (
    subscriberId: string,
    prefixHash: Buffer,
  ) => Promise<boolean>;
  readonly flagChallengeTimeout?: (subscriberId: string) => Promise<void>;
}

interface StoredApplication {
  readonly subscriberId: string;
  readonly createdSubscriber: boolean;
}

/**
 * Submitting an application (D-050 Q1): the same normalisation, domain screen
 * and fraud signals as signup, then, in one transaction, the pending
 * subscriber found or created for the normalised address, the `unconfirmed`
 * application and its `partner_application` confirmation link. A pending or
 * verified member is linked. Any other status, a member who already has a
 * confirmed application, and a repeat inside the per-address mail window get
 * the same neutral answer with no mail and no row.
 */
export function createPartnerSubmitService(
  database: DatabasePool,
  dependencies: PartnerSubmitDependencies,
): (input: PartnerSubmitInput) => Promise<PartnerSubmitOutcome> {
  const clock = dependencies.clock ?? (() => new Date());

  return async (input) => {
    const email = normaliseEmail(input.fields.email);
    if (email === null) return { kind: 'invalid_email' };

    // The domain screen runs after normalisation and before the first
    // uniqueness query or write, as on signup (docs/api/README.md).
    const screen = await dependencies.screenEmailDomain(email.domain);
    if (screen.reject !== undefined) return { kind: screen.reject };

    const now = clock();
    // One confirmation link per address per window. The bucket is counted
    // before anything is written, so a throttled repeat leaves no row.
    if (
      (await consumeRateLimit(
        database,
        `partner:mail:${email.normalised}`,
        partnerApplicationMailWindowMs,
        now,
      )) > partnerApplicationMailLimit
    ) {
      return { kind: 'accepted', subscriberId: null };
    }

    const stored = await withTransaction(
      database,
      async (connection): Promise<StoredApplication | null> => {
        const subscribers = createSubscriberRepository(connection);
        const partners = createPartnerRepository(connection);
        const candidateId = randomUUID();
        const inserted = await subscribers.insertPending({
          id: candidateId,
          email: email.raw,
          emailNormalised: email.normalised,
          emailDomain: email.domain,
          marketingOptInVersion: null,
          signupIpPrefixHash: input.signupIpPrefixHash,
          utm: null,
          signupHadRef: false,
        });
        const createdSubscriber = inserted === 1;
        const subscriberId = createdSubscriber
          ? candidateId
          : (await subscribers.findByNormalised(email.normalised))?.id;
        if (subscriberId === undefined) {
          throw new Error('Conflicting subscriber row could not be read back.');
        }
        const status = await partners.lockSubscriber(subscriberId);
        if (status !== 'pending' && status !== 'verified') return null;
        if (await partners.hasLiveApplication(subscriberId)) return null;

        const issued = await createVerificationService(connection, {
          clock,
        }).issue(subscriberId, 'partner_application');
        const partnerId = randomUUID();
        await partners.insertApplication({
          id: partnerId,
          subscriberId,
          createdSubscriber,
          confirmationTokenId: issued.id,
          submittedAt: now,
          fullName: input.fields.fullName,
          countryOfResidence: input.fields.countryOfResidence,
          partnerType: input.fields.partnerType,
          channels: input.fields.channels,
          handles: input.fields.handles,
          audienceSize: input.fields.audienceSize,
          promotionPlan: input.fields.promotionPlan,
          requestedCode: input.requestedCode,
          university: input.fields.university,
          studentEmail: input.fields.studentEmail,
          companyName: input.fields.companyName,
        });
        // Suppression is re-checked again at dispatch (hard rule 5).
        await createEmailQueue(database, clock).queue(
          {
            businessKey: partnerConfirmationBusinessKey(partnerId),
            subscriberId,
            template: partnerConfirmationTemplate,
            provider: 'resend',
            payload: { token_id: issued.id },
          },
          connection,
        );
        return { subscriberId, createdSubscriber };
      },
    );

    if (stored === null) return { kind: 'accepted', subscriberId: null };

    // Fraud signals are metadata, raised after commit as signup raises them:
    // none may reject or roll back an accepted application.
    const subscriberId = stored.subscriberId;
    const bestEffort = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch {
        // A lost review flag degrades the queue; it never touches the row.
      }
    };
    for (const kind of screen.flags) {
      await bestEffort(() =>
        dependencies.raiseFraudFlag(subscriberId, kind, {
          domain: email.domain,
          reason: 'mx_lookup_timeout',
        }),
      );
    }
    if (stored.createdSubscriber && dependencies.flagDuplicateIdentity) {
      const flag = dependencies.flagDuplicateIdentity;
      await bestEffort(() => flag(subscriberId));
    }
    if (
      stored.createdSubscriber &&
      dependencies.flagIpVelocity &&
      input.signupIpPrefixHash !== null
    ) {
      const flag = dependencies.flagIpVelocity;
      const prefix = input.signupIpPrefixHash;
      await bestEffort(() => flag(subscriberId, prefix));
    }
    if (input.challengeTimedOut && dependencies.flagChallengeTimeout) {
      const flag = dependencies.flagChallengeTimeout;
      await bestEffort(() => flag(subscriberId));
    }
    return { kind: 'accepted', subscriberId };
  };
}

/** Why a field is refused on the page: the field rules, plus email and code. */
export type PartnerFormError =
  PartnerFieldError | 'blocked_domain' | PartnerCodeRefusalReason;

/** The page's outcome for a submitted application. */
export type PartnerApplicationOutcome =
  | { readonly kind: 'paused' }
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'refused';
      readonly values: PartnerApplicationValues;
      readonly errors: Readonly<
        Partial<Record<PartnerApplicationField, PartnerFormError>>
      >;
      /** Up to three available codes, when the requested code was refused. */
      readonly alternatives: readonly string[];
    }
  | {
      readonly kind: 'challenge_failed' | 'rate_limited' | 'unavailable';
      readonly values: PartnerApplicationValues;
    };

export interface PartnerApplicationHandlerDependencies {
  readonly verifyTurnstile: (token: string) => Promise<TurnstileOutcome>;
  readonly isEnabled: () => Promise<boolean>;
  readonly consumeIpRateLimit: (
    prefixHash: string,
    now: Date,
    strict: boolean,
  ) => Promise<number>;
  readonly checkCode: (requested: string) => Promise<PartnerCodeCheck>;
  readonly submit: (input: PartnerSubmitInput) => Promise<PartnerSubmitOutcome>;
  readonly hashIpPrefix: (clientAddress: string) => Buffer | null;
  readonly clock?: () => Date;
  readonly monotonicClock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** The strict window applies when Turnstile could not be confirmed. */
export function partnerApplicationIpAllowance(strict: boolean): number {
  return strict ? partnerApplicationStrictIpLimit : partnerApplicationIpLimit;
}

/**
 * `/partners/apply`'s POST (E11.7-05). Turnstile is verified server-side
 * before any other work, then the flag, then the hashed-prefix rate limit
 * (ADR-006). A refused field or code returns the form with what was typed and
 * the code's alternatives, rendered by the server with no JavaScript.
 */
export function createPartnerApplicationHandler(
  dependencies: PartnerApplicationHandlerDependencies,
): (
  form: FormData,
  clientAddress: string,
) => Promise<PartnerApplicationOutcome> {
  const clock = dependencies.clock ?? (() => new Date());
  const monotonicClock =
    dependencies.monotonicClock ??
    (() => Number(process.hrtime.bigint() / 1_000_000n));
  const sleep = dependencies.sleep ?? systemSleep;

  return async (form, clientAddress) => {
    // 1. Turnstile, before anything else. A missing token is a failed
    // challenge; a provider outage accepts under the strict limit and flags.
    const turnstileToken = form.get('turnstile_token');
    const values = readPartnerApplicationValues(form);
    if (typeof turnstileToken !== 'string' || turnstileToken === '') {
      return { kind: 'challenge_failed', values };
    }
    let challenge: TurnstileOutcome;
    try {
      challenge = await dependencies.verifyTurnstile(turnstileToken);
    } catch {
      challenge = 'unavailable';
    }
    if (challenge === 'rejected') return { kind: 'challenge_failed', values };
    const challengeTimedOut = challenge === 'unavailable';

    // 2. The flag, after Turnstile because it reads the flag store.
    try {
      if (!(await dependencies.isEnabled())) return { kind: 'paused' };
    } catch {
      return { kind: 'unavailable', values };
    }

    // 3. The hashed IP prefix limit. An unattributable address is limited.
    const prefixHash = dependencies.hashIpPrefix(clientAddress);
    if (prefixHash === null) return { kind: 'rate_limited', values };
    try {
      const count = await dependencies.consumeIpRateLimit(
        prefixHash.toString('hex'),
        clock(),
        challengeTimedOut,
      );
      if (count > partnerApplicationIpAllowance(challengeTimedOut)) {
        return { kind: 'rate_limited', values };
      }
    } catch {
      return { kind: 'unavailable', values };
    }

    // 4. The fields, then the code rules (E11.7-01). Both report together.
    const parsed = parsePartnerApplication(values);
    const errors: Partial<Record<PartnerApplicationField, PartnerFormError>> =
      parsed.ok ? {} : { ...parsed.errors };
    let alternatives: readonly string[] = [];
    let requestedCode: string | null = null;
    if (values.requestedCode.trim() !== '') {
      let check: PartnerCodeCheck;
      try {
        check = await dependencies.checkCode(values.requestedCode.trim());
      } catch {
        return { kind: 'unavailable', values };
      }
      if (check.outcome === 'refused') {
        errors.requested_code = check.reason;
        alternatives = check.alternatives;
      } else {
        requestedCode = check.code;
      }
    }
    if (!parsed.ok || requestedCode === null) {
      return { kind: 'refused', values, errors, alternatives };
    }

    // 5. The member and the application. Every accepted path shares one
    // minimum response time, so a known address is not a timing signal.
    const startedAt = monotonicClock();
    let outcome: PartnerSubmitOutcome;
    try {
      outcome = await dependencies.submit({
        fields: parsed.fields,
        requestedCode,
        signupIpPrefixHash: prefixHash,
        challengeTimedOut,
      });
    } catch {
      return { kind: 'unavailable', values };
    }
    if (outcome.kind === 'invalid_email') {
      return {
        kind: 'refused',
        values,
        errors: { email_address: 'invalid' },
        alternatives: [],
      };
    }
    if (outcome.kind === 'blocked_domain') {
      return {
        kind: 'refused',
        values,
        errors: { email_address: 'blocked_domain' },
        alternatives: [],
      };
    }
    const remaining =
      partnerApplicationResponseTargetMs - (monotonicClock() - startedAt);
    if (remaining > 0) await sleep(remaining);
    return { kind: 'accepted' };
  };
}
