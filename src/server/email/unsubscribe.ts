import { randomUUID } from 'node:crypto';

import { createAuditService } from '../audit/service.ts';
import { createUnsubscribeRepository } from '../db/unsubscribe.ts';
import { createFraudFlagRepository } from '../db/fraud-flag.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createRateLimitBucketRepository } from '../db/rate-limit-bucket.ts';
import { createVerificationTokenRepository } from '../db/verification-token.ts';
import { createVerificationService } from '../verification/service.ts';
import {
  deriveEmailToken,
  hashEmailToken,
} from '../verification/token-derivation.ts';

const windowMs = 15 * 60 * 1_000;
const ipLimit = 10;
const subscriberLimit = 5;

export type UnsubscribeAction = 'message_unsubscribe' | 'leave_waitlist';
export type UnsubscribeOutcome =
  'accepted' | 'already' | 'invalid' | 'rate_limited';

class RateLimitedError extends Error {}

export function createUnsubscribeService(
  database: DatabasePool,
  dependencies: {
    readonly clock?: () => Date;
    readonly tokenSecret?: string;
    readonly onFailure: (input: {
      readonly unsubscribeTokenId: string | null;
      readonly emailSendId: string | null;
      readonly tokenSha256: string;
      readonly requestedAction: UnsubscribeAction;
      readonly occurredAt: Date;
    }) => Promise<void>;
    readonly onEffectiveChange?: (sourceTemplate: string) => void;
  },
) {
  const clock = dependencies.clock ?? (() => new Date());
  return {
    async applyById(input: {
      readonly unsubscribeTokenId: string;
      readonly actor: string;
      readonly ipPrefixHash: string;
      readonly action?: 'leave_waitlist';
    }): Promise<UnsubscribeOutcome> {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          input.unsubscribeTokenId,
        )
      ) {
        throw new RangeError('Invalid unsubscribe token ID.');
      }
      const secret = dependencies.tokenSecret ?? process.env.EMAIL_TOKEN_SECRET;
      if (secret === undefined || secret === '')
        throw new Error('EMAIL_TOKEN_SECRET is required.');
      const token = deriveEmailToken(input.unsubscribeTokenId, secret);
      const row = await createVerificationTokenRepository(database).findByHash(
        hashEmailToken(token),
      );
      if (row === null) return 'invalid';
      if (row.purpose === 'status' && input.action !== 'leave_waitlist')
        throw new Error('A status token requires --action leave_waitlist.');
      if (row.purpose !== 'status' && row.purpose !== 'unsubscribe')
        return 'invalid';
      return this.apply({
        token,
        action: input.action ?? 'message_unsubscribe',
        credential: row.purpose,
        ipPrefixHash: input.ipPrefixHash,
        actor: input.actor,
      });
    },
    async applyByHash(input: {
      readonly tokenSha256: string;
      readonly actor: string;
      readonly ipPrefixHash: string;
      readonly action?: 'leave_waitlist';
    }): Promise<UnsubscribeOutcome> {
      if (!/^[0-9a-f]{64}$/iu.test(input.tokenSha256))
        throw new RangeError('Invalid unsubscribe token hash.');
      const token = await createVerificationTokenRepository(
        database,
      ).findByHash(Buffer.from(input.tokenSha256, 'hex'));
      if (token === null) return 'invalid';
      if (token.purpose === 'status' && input.action !== 'leave_waitlist')
        throw new Error('A status token requires --action leave_waitlist.');
      if (token.purpose !== 'status' && token.purpose !== 'unsubscribe')
        return 'invalid';
      return this.applyById({
        unsubscribeTokenId: token.id,
        actor: input.actor,
        ipPrefixHash: input.ipPrefixHash,
        action: input.action,
      });
    },
    async apply(input: {
      readonly token: string;
      readonly action: UnsubscribeAction;
      readonly credential?: 'unsubscribe' | 'status';
      readonly ipPrefixHash: string;
      readonly requestId?: string;
      readonly actor?: string;
      readonly challengeTimedOut?: boolean;
    }): Promise<UnsubscribeOutcome> {
      let emailSendId: string | null = null;
      let unsubscribeTokenId: string | null = null;
      let effectiveSourceTemplate: string | null = null;
      const tokenSha256 = hashEmailToken(input.token).toString('hex');
      if (
        input.credential === 'status' &&
        input.actor === undefined &&
        input.ipPrefixHash === ''
      )
        return 'rate_limited';
      try {
        const outcome = await withTransaction(database, async (connection) => {
          const now = clock();
          const credential = input.credential ?? 'unsubscribe';
          const limits = createRateLimitBucketRepository(connection);
          const threshold = new Date(now.getTime() - windowMs);
          if (credential === 'status' && input.actor === undefined) {
            const ipCount = await limits.consume(
              `unsubscribe:status:ip:${input.challengeTimedOut ? 'strict:' : ''}${input.ipPrefixHash || 'missing'}`,
              now,
              threshold,
            );
            if (ipCount > (input.challengeTimedOut ? 2 : 5))
              throw new RateLimitedError();
          }
          // The signed single-use token is the first authentication step on
          // the email route. The status route verifies Turnstile before here.
          const auth = await createVerificationService(connection, {
            clock,
            tokenSecret: dependencies.tokenSecret,
          }).consumeForPurpose(input.token, credential);
          if (credential === 'unsubscribe' && auth.outcome === 'already')
            return 'already';
          if (credential === 'unsubscribe' && input.actor === undefined) {
            const ipCount = await limits.consume(
              `unsubscribe:ip:${input.ipPrefixHash || 'missing'}`,
              now,
              threshold,
            );
            if (ipCount > ipLimit) throw new RateLimitedError();
          }
          if (
            (auth.outcome !== 'verified' &&
              !(credential === 'status' && auth.outcome === 'already')) ||
            auth.subscriberId === null
          )
            return 'invalid';

          const repository = createUnsubscribeRepository(connection);
          let bound: Awaited<ReturnType<typeof repository.boundSend>> = null;
          let statusSubject: Awaited<
            ReturnType<typeof repository.statusSubject>
          > = null;
          if (credential === 'unsubscribe') {
            const token = await createVerificationTokenRepository(
              connection,
            ).findByHash(hashEmailToken(input.token));
            if (token === null) throw new Error('Consumed token disappeared.');
            unsubscribeTokenId = token.id;
            bound = await repository.boundSend(token.id);
            if (bound === null || bound.subscriber_id !== auth.subscriberId)
              throw new Error('Unsubscribe token binding is missing.');
            emailSendId = bound.email_send_id;
          } else {
            if (input.action !== 'leave_waitlist') return 'invalid';
            statusSubject = await repository.statusSubject(auth.subscriberId);
            if (statusSubject === null) return 'invalid';
          }

          if (input.actor === undefined) {
            const subscriberCount = await limits.consume(
              `unsubscribe:${credential}:subscriber:${auth.subscriberId}`,
              now,
              threshold,
            );
            if (subscriberCount > subscriberLimit) throw new RateLimitedError();
          }

          if (
            credential === 'status' &&
            input.actor === undefined &&
            input.challengeTimedOut
          ) {
            await createFraudFlagRepository(
              connection,
            ).insertChallengeTimeoutFlag({
              id: randomUUID(),
              subscriberId: auth.subscriberId,
            });
          }

          const audit = createAuditService(connection);
          const suppress =
            input.action === 'leave_waitlist' || bound?.provider === 'resend';
          if (suppress) {
            if (
              statusSubject?.suppressed &&
              statusSubject.status !== 'verified'
            )
              return 'already';
            if (!(bound?.suppressed ?? false)) {
              await repository.suppress(
                bound?.email_normalised ?? statusSubject!.email_normalised,
                bound?.template ?? 'member_status',
                now,
              );
            }
            if (input.action === 'leave_waitlist') {
              const withdrewMarketing = await repository.withdrawMarketing(
                auth.subscriberId,
                now,
              );
              const leftWaitlist = await repository.leaveWaitlist(
                auth.subscriberId,
                now,
              );
              if (withdrewMarketing || leftWaitlist)
                effectiveSourceTemplate = bound?.template ?? 'member_status';
            }
            await audit.record({
              action: 'subscriber.unsubscribed',
              actor: input.actor ?? 'subscriber',
              detail: {
                source_template: bound?.template ?? 'member_status',
                email_send_id: bound?.email_send_id ?? null,
              },
              requestId: input.requestId,
              subjectId: auth.subscriberId,
              subjectType: 'subscriber',
            });
          } else if (bound?.provider === 'brevo') {
            if (bound.marketing_consent_at !== null) {
              if (await repository.withdrawMarketing(auth.subscriberId, now))
                effectiveSourceTemplate = bound.template;
            }
            await audit.record({
              action: 'consent.marketing_withdrawn',
              actor: input.actor ?? 'subscriber',
              detail: {
                source_template: bound.template,
                email_send_id: bound.email_send_id,
              },
              requestId: input.requestId,
              subjectId: auth.subscriberId,
              subjectType: 'subscriber',
            });
          } else {
            throw new Error(
              'Unregistered email provider on unsubscribe binding.',
            );
          }
          return 'accepted';
        });
        if (outcome === 'accepted' && effectiveSourceTemplate !== null) {
          try {
            dependencies.onEffectiveChange?.(effectiveSourceTemplate);
          } catch {
            /* Committed preferences cannot fail over analytics. */
          }
        }
        return outcome;
      } catch (error) {
        if (error instanceof RateLimitedError) return 'rate_limited';
        await dependencies
          .onFailure({
            unsubscribeTokenId,
            emailSendId,
            tokenSha256,
            requestedAction: input.action,
            occurredAt: clock(),
          })
          .catch(() => undefined);
        throw error;
      }
    },
  };
}
