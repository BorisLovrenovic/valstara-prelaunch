import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { DatabasePool } from '../db/pool.ts';
import { createFraudFlagRepository } from '../db/fraud-flag.ts';
import { createRateLimitBucketRepository } from '../db/rate-limit-bucket.ts';
import { createStatusLinkRepository } from '../db/status-link.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import type { FlagService } from '../flags/types.ts';
import type { TurnstileOutcome } from '../turnstile/verify.ts';

import { createVerificationService } from './service.ts';
import {
  deriveEmailToken,
  emailTokenSecret,
  hashEmailToken,
} from './token-derivation.ts';

export const statusLinkRecoveryWindowMilliseconds = 15 * 60 * 1_000;
export const statusLinkRecoverySubscriberLimit = 1;
export const statusLinkRecoveryIpPrefixLimit = 5;
export const statusLinkRecoveryStrictIpPrefixLimit = 2;

export type StatusLinkAuthentication =
  | { readonly kind: 'authenticated'; readonly subscriberId: string }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'rejected' };

export type StatusLinkRecoveryOutcome =
  'accepted' | 'disabled' | 'rate_limited';

export type StatusLinkRecoveryBoundaryOutcome =
  StatusLinkRecoveryOutcome | 'challenge_failed';

export interface StatusLinkService {
  authenticate(token: string): Promise<StatusLinkAuthentication>;
  requestReplacement(input: {
    readonly challengeTimedOut: boolean;
    readonly ipPrefixHash: string;
    readonly token: string;
  }): Promise<StatusLinkRecoveryOutcome>;
}

export interface StatusLinkRecoveryBoundaryDependencies {
  readonly recover: (
    challengeTimedOut: boolean,
  ) => Promise<StatusLinkRecoveryOutcome>;
  readonly verifyTurnstile: (token: string) => Promise<TurnstileOutcome>;
}

export interface StatusLinkServiceDependencies {
  readonly clock?: () => Date;
  readonly flags: Pick<FlagService, 'isEnabled'>;
}

/**
 * Public recovery requests cross this boundary before any flag, rate-limit,
 * token or email dependency is constructed or called. Provider unavailability
 * keeps ADR-006's accept-and-flag fallback, signalled to the recovery service
 * so it can apply the strict IP limit.
 */
export function createStatusLinkRecoveryBoundary(
  dependencies: StatusLinkRecoveryBoundaryDependencies,
): (turnstileToken: string) => Promise<StatusLinkRecoveryBoundaryOutcome> {
  return async (turnstileToken) => {
    const challenge = await dependencies.verifyTurnstile(turnstileToken);
    if (challenge === 'rejected') return 'challenge_failed';
    return dependencies.recover(challenge === 'unavailable');
  };
}

export function createStatusLinkService(
  database: DatabasePool,
  dependencies: StatusLinkServiceDependencies,
): StatusLinkService {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async authenticate(token) {
      if (!(await dependencies.flags.isEnabled('member.dashboard'))) {
        return { kind: 'disabled' };
      }
      if (token === '') return { kind: 'rejected' };

      const authenticated = await createVerificationService(database, {
        clock,
      }).consumeForPurpose(token, 'status');
      if (
        (authenticated.outcome !== 'verified' &&
          authenticated.outcome !== 'already') ||
        authenticated.subscriberId === null
      ) {
        return { kind: 'rejected' };
      }
      return {
        kind: 'authenticated',
        subscriberId: authenticated.subscriberId,
      };
    },

    async requestReplacement(input) {
      if (!(await dependencies.flags.isEnabled('member.dashboard'))) {
        return 'disabled';
      }
      if (input.token === '' || input.ipPrefixHash === '') return 'accepted';

      return withTransaction(database, async (connection) => {
        const statusLinks = createStatusLinkRepository(connection);
        const token = await statusLinks.findToken(hashEmailToken(input.token));
        const now = clock();

        // Recovery deliberately recognises only an expired status token. The
        // result remains the same for a forged, cross-purpose or unknown token,
        // so this lookup cannot become a subscriber-existence oracle.
        if (
          token === null ||
          token.purpose !== 'status' ||
          token.expires_at > now ||
          !validCurrentToken(input.token, token.id)
        ) {
          return 'accepted';
        }

        const windowThreshold = new Date(
          now.getTime() - statusLinkRecoveryWindowMilliseconds,
        );
        const rateLimits = createRateLimitBucketRepository(connection);
        const ipCount = await rateLimits.consume(
          `status-link-recovery:ip:${input.challengeTimedOut ? 'strict:' : ''}${input.ipPrefixHash}`,
          now,
          windowThreshold,
        );
        const subscriberCount = await rateLimits.consume(
          `status-link-recovery:subscriber:${token.subscriber_id}`,
          now,
          windowThreshold,
        );
        if (
          ipCount >
            (input.challengeTimedOut
              ? statusLinkRecoveryStrictIpPrefixLimit
              : statusLinkRecoveryIpPrefixLimit) ||
          subscriberCount > statusLinkRecoverySubscriberLimit
        ) {
          return 'rate_limited';
        }

        const emailId = randomUUID();
        const issued = await createVerificationService(connection, {
          clock,
        }).issue(token.subscriber_id, 'status');
        await createEmailQueue(database, clock).queue(
          {
            businessKey: `status-link:${token.subscriber_id}:${emailId}`,
            subscriberId: token.subscriber_id,
            template: 'status_link',
            provider: 'resend',
            payload: { token_id: issued.id },
          },
          connection,
        );
        if (input.challengeTimedOut) {
          await createFraudFlagRepository(
            connection,
          ).insertChallengeTimeoutFlag({
            id: randomUUID(),
            subscriberId: token.subscriber_id,
          });
        }
        return 'accepted';
      });
    },
  };
}

function validCurrentToken(token: string, id: string): boolean {
  const expected = Buffer.from(deriveEmailToken(id, emailTokenSecret()));
  const supplied = Buffer.from(token);
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}
