import { createPartnerRepository } from '../db/partner.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import {
  createTransactionalEmailProducers,
  type TransactionalEmailProducers,
} from '../email/producers.ts';
import type { FlagService } from '../flags/types.ts';
import type { CurrentGiveawayRules } from '../giveaway/accrue.ts';
import type { WaitlistAgeSettings } from '../giveaway/age-policy.ts';
import type { AccessWindowBand } from '../referral/config.ts';
import { completeVerificationInTransaction } from '../verification/complete.ts';
import { createVerificationService } from '../verification/service.ts';

import {
  partnerReceivedBusinessKey,
  partnerReceivedTemplate,
} from './application.ts';
import { partnerConfirmationIpLimit } from './config.ts';

/**
 * The confirmation link's outcome. `confirmed` covers a first use and a
 * replay; `invalid` is the one answer for an unknown, expired, wrong-purpose
 * or no-longer-confirmable link, so the page never says which.
 */
export type PartnerConfirmationOutcome =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'unavailable' };

export interface PartnerConfirmationDependencies {
  readonly clock?: () => Date;
  readonly isEnabled: () => Promise<boolean>;
  /** One attempt against the hashed IP prefix; returns the window's count. */
  readonly consumeIpRateLimit: (
    prefixHash: string,
    now: Date,
  ) => Promise<number>;
  readonly emailProducers?: TransactionalEmailProducers;
  readonly accessWindowBands?: readonly AccessWindowBand[];
  readonly giveaway?: {
    flags: Pick<FlagService, 'isEnabled'>;
    currentRules: () => CurrentGiveawayRules;
    /** E11.8-06: the shipped settings unless a test supplies its own. */
    settings?: WaitlistAgeSettings;
  };
}

class Rollback extends Error {
  constructor(readonly outcome: PartnerConfirmationOutcome) {
    super(outcome.kind);
  }
}

/**
 * Confirming a partner application (D-050 Q1 and Q4). The single-use
 * `partner_application` token is consumed first, in place of Turnstile, then
 * the attempt is rate-limited by hashed IP prefix and the flag is read
 * (ADR-006). A `pending` member is verified through the existing verification
 * completion, so they become a waitlist member like any other; a `verified`
 * member is linked unchanged. The application moves to `applied`, and the
 * "application received" email is queued under its own business key. Any
 * other member status confirms nothing. A refusal after the consume rolls it
 * back, so the link still works later.
 */
export function createPartnerConfirmationService(
  database: DatabasePool,
  dependencies: PartnerConfirmationDependencies,
): (
  token: string,
  ipPrefixHash: string,
) => Promise<PartnerConfirmationOutcome> {
  const clock = dependencies.clock ?? (() => new Date());
  const producers =
    dependencies.emailProducers ??
    createTransactionalEmailProducers(database, clock);

  return async (token, ipPrefixHash) => {
    if (token === '') return { kind: 'invalid' };
    try {
      return await withTransaction(database, async (connection) => {
        const consumed = await createVerificationService(connection, {
          clock,
        }).consumeForPurpose(token, 'partner_application');
        // Every attempt spends the bucket after the token lookup, invalid
        // and replayed links included, as /dsr's confirmation does.
        if (
          ipPrefixHash === '' ||
          (await dependencies.consumeIpRateLimit(ipPrefixHash, clock())) >
            partnerConfirmationIpLimit
        ) {
          throw new Rollback({ kind: 'rate_limited' });
        }
        if (
          consumed.outcome === 'invalid' ||
          consumed.outcome === 'expired' ||
          consumed.subscriberId === null ||
          consumed.tokenId === undefined ||
          consumed.tokenId === null
        ) {
          return { kind: 'invalid' } as const;
        }
        if (!(await dependencies.isEnabled())) {
          throw new Rollback({ kind: 'paused' });
        }

        const partners = createPartnerRepository(connection);
        const application = await partners.lockByConfirmationToken(
          consumed.tokenId,
        );
        if (
          application === null ||
          application.subscriber_id !== consumed.subscriberId
        ) {
          throw new Rollback({ kind: 'invalid' });
        }
        // A replay of a link that already confirmed its application.
        if (application.status !== 'unconfirmed') {
          return { kind: 'confirmed' } as const;
        }
        const subscriberId = consumed.subscriberId;
        const status = await partners.lockSubscriber(subscriberId);
        // Another application of this member is already confirmed: this one
        // stays unconfirmed and the confirmed one stands. A first use and a
        // replay of this link answer the same.
        if (
          status === 'verified' &&
          (await partners.hasLiveApplication(subscriberId))
        ) {
          return { kind: 'confirmed' } as const;
        }
        if (consumed.outcome === 'already') {
          // The link was used but nothing confirmable remains behind it.
          throw new Rollback({ kind: 'invalid' });
        }
        if (status === 'pending') {
          await completeVerificationInTransaction(
            connection,
            subscriberId,
            true,
            {
              clock,
              producers,
              accessWindowBands: dependencies.accessWindowBands,
              giveaway: dependencies.giveaway,
            },
          );
        } else if (status !== 'verified') {
          throw new Rollback({ kind: 'invalid' });
        }
        if ((await partners.markApplied(application.id, clock())) !== 1) {
          throw new Error('A confirmable application did not reach applied.');
        }
        // The email links the member's own status page, as every member
        // email does, so it carries a status token (email_send holds
        // references only). Suppression is re-checked at dispatch (rule 5).
        const statusToken = await createVerificationService(connection, {
          clock,
        }).issue(subscriberId, 'status');
        await createEmailQueue(database, clock).queue(
          {
            businessKey: partnerReceivedBusinessKey(application.id),
            subscriberId,
            template: partnerReceivedTemplate,
            provider: 'resend',
            payload: { status_token_id: statusToken.id },
          },
          connection,
        );
        return { kind: 'confirmed' } as const;
      });
    } catch (error) {
      if (error instanceof Rollback) return error.outcome;
      return { kind: 'unavailable' };
    }
  };
}
