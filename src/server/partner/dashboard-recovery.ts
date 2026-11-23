import { randomUUID } from 'node:crypto';
import { setTimeout as systemSleep } from 'node:timers/promises';

import { createEmailRepository } from '../db/email.ts';
import { createFraudFlagRepository } from '../db/fraud-flag.ts';
import { createPartnerDashboardRepository } from '../db/partner-dashboard.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import { consumeRateLimit } from '../ratelimit/consume.ts';
import { normaliseEmail } from '../subscriber/normalise-email.ts';
import type { TurnstileOutcome } from '../turnstile/verify.ts';
import { createVerificationService } from '../verification/service.ts';
import { deriveEmailToken } from '../verification/token-derivation.ts';

import { partnerApplicationResponseTargetMs } from './application.ts';
import {
  partnerApplicationIpLimit,
  partnerApplicationIpWindowMs,
  partnerApplicationLimits,
  partnerApplicationMailLimit,
  partnerApplicationMailWindowMs,
  partnerApplicationStrictIpLimit,
} from './config.ts';

export const partnerDashboardRecoveryTemplate = 'partner_dashboard_link';

export type DashboardRecoveryOutcome =
  | 'accepted'
  | 'challenge_failed'
  | 'invalid_email'
  | 'paused'
  | 'rate_limited'
  | 'unavailable';

interface RecoveryDependencies {
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly isEnabled: () => Promise<boolean>;
  readonly hashIpPrefix: (address: string) => string | null;
  readonly verifyTurnstile: (token: string) => Promise<TurnstileOutcome>;
  readonly tokenSecret: string;
}

export function createPartnerDashboardRecovery(
  database: DatabasePool,
  dependencies: RecoveryDependencies,
) {
  const clock = dependencies.clock ?? (() => new Date());
  const sleep = dependencies.sleep ?? systemSleep;

  return async (
    form: FormData,
    clientAddress: string,
  ): Promise<DashboardRecoveryOutcome> => {
    const value = form.get('turnstile_token');
    const challenge = await dependencies.verifyTurnstile(
      typeof value === 'string' ? value : '',
    );
    if (challenge === 'rejected') return 'challenge_failed';
    if (!(await dependencies.isEnabled())) return 'paused';

    const start = clock();
    const strict = challenge === 'unavailable';
    const prefix = dependencies.hashIpPrefix(clientAddress);
    if (
      prefix === null ||
      (await consumeRateLimit(
        database,
        `partner-dashboard:recover:ip:${strict ? 'strict:' : ''}${prefix}`,
        partnerApplicationIpWindowMs,
        start,
      )) >
        (strict ? partnerApplicationStrictIpLimit : partnerApplicationIpLimit)
    ) {
      return 'rate_limited';
    }

    const raw = form.get('email_address');
    const address =
      typeof raw === 'string' && raw.length <= partnerApplicationLimits.email
        ? normaliseEmail(raw)
        : null;
    if (address === null) return 'invalid_email';

    const addressKey = deriveEmailToken(
      `partner-dashboard-recovery:${address.normalised}`,
      dependencies.tokenSecret,
    );
    if (
      (await consumeRateLimit(
        database,
        `partner-dashboard:recover:address:${addressKey}`,
        partnerApplicationMailWindowMs,
        start,
      )) > partnerApplicationMailLimit
    ) {
      return 'rate_limited';
    }

    try {
      await withTransaction(database, async (connection) => {
        const repository = createPartnerDashboardRepository(connection);
        const subscriber = await repository.lockSubscriberForRecovery(
          address.normalised,
        );
        if (subscriber === null) return;
        const owner = await repository.lockEligibleOwner(subscriber.id);
        if (owner === null) return;
        const recipient = await createEmailRepository(connection).recipient(
          subscriber.id,
        );
        if (recipient === null || recipient.suppressed) return;

        const issued = await createVerificationService(connection, {
          clock,
          tokenSecret: dependencies.tokenSecret,
        }).issue(subscriber.id, 'partner_dashboard');
        const queued = await createEmailQueue(database, clock).queue(
          {
            businessKey: `partner-dashboard-link:${issued.id}`,
            subscriberId: subscriber.id,
            template: partnerDashboardRecoveryTemplate,
            provider: 'resend',
            payload: { token_id: issued.id },
            expiresAt: issued.expiresAt,
          },
          connection,
        );
        if (
          !queued ||
          (await repository.setCurrentLink(owner.id, issued.id)) !== 1
        ) {
          throw new Error('The dashboard link could not be queued.');
        }
        if (strict) {
          await createFraudFlagRepository(
            connection,
          ).insertChallengeTimeoutFlag({
            id: randomUUID(),
            subscriberId: subscriber.id,
          });
        }
      });
    } catch {
      // The acknowledgement is conditional. A queue failure rolls back the
      // new link without turning a recipient-specific error into an oracle.
    } finally {
      const remaining =
        partnerApplicationResponseTargetMs -
        (clock().getTime() - start.getTime());
      if (remaining > 0) await sleep(remaining);
    }
    return 'accepted';
  };
}
