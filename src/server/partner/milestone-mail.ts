import { createCampaignFlagRepository } from '../db/campaign-flags.ts';
import { createEmailRepository } from '../db/email.ts';
import { createPartnerMilestoneMailRepository } from '../db/partner-milestone-mail.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import type { QueueEmailInput } from '../email/service.ts';
import { campaignFlagRegistry } from '../flags/registry.ts';
import {
  partnerAttributionEnabled,
  partnerAttributionEnabledForWrite,
} from '../referral/partner-perks.ts';
import { createVerificationService } from '../verification/service.ts';

import {
  partnerFirstSignupBusinessKey,
  partnerFirstSignupTemplate,
  partnerInviteBusinessKey,
  partnerInviteTemplate,
  partnerInviteThreshold,
} from './config.ts';

// E11.7-12: the auto-invite and the partner's first-signup email. Both are
// queued by the maintenance worker, in batches of at most 100, so a member or
// partner who qualified before this shipped is caught up and a later one is
// picked up on the next cycle. Each is one email per business key, ever: a
// void that drops a member below the threshold neither re-sends the invite
// nor retracts it, and the email service re-checks suppression at dispatch.
//
// The auto-invite is marketing (ADR-027): it is queued only with current
// marketing consent and while `email.broadcast` is on, as a Brevo broadcast,
// so dispatch re-checks verification, consent and suppression, and an
// unsubscribe from it withdraws marketing consent only. The first-signup
// email is a transactional milestone update on Resend.

export const partnerMilestoneMailBatchLimit = 100;

interface MilestoneQueue {
  queue(
    input: QueueEmailInput,
    connection: DatabaseConnection,
  ): Promise<boolean>;
}

interface MilestoneMailDependencies {
  readonly clock: () => Date;
  readonly email: MilestoneQueue;
  readonly tokenSecret?: string;
}

class AlreadyQueued extends Error {}

function assertLimit(limit: number) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > partnerMilestoneMailBatchLimit
  ) {
    throw new RangeError('Invalid partner milestone mail batch size.');
  }
}

async function broadcastEnabled(
  connection: DatabaseConnection,
): Promise<boolean> {
  const [row] = await createCampaignFlagRepository(connection).list([
    'email.broadcast',
  ]);
  return row?.enabled ?? campaignFlagRegistry['email.broadcast'];
}

/**
 * Issues a status link for the mail's `/me` link and queues the mail in the
 * caller's transaction. A lost race rolls back the token with the transaction.
 */
async function queueWithStatusLink(
  connection: DatabaseConnection,
  dependencies: MilestoneMailDependencies,
  input: Omit<QueueEmailInput, 'payload'>,
): Promise<true> {
  const status = await createVerificationService(connection, {
    clock: dependencies.clock,
    ...(dependencies.tokenSecret === undefined
      ? {}
      : { tokenSecret: dependencies.tokenSecret }),
  }).issue(input.subscriberId, 'status');
  const queued = await dependencies.email.queue(
    { ...input, payload: { status_token_id: status.id } },
    connection,
  );
  if (!queued) throw new AlreadyQueued();
  return true;
}

function ignoreLostRace(error: unknown): false {
  if (error instanceof AlreadyQueued) return false;
  throw error;
}

export function createPartnerInviteJob(
  database: DatabasePool,
  dependencies: MilestoneMailDependencies,
) {
  async function invite(subscriberId: string): Promise<boolean> {
    return withTransaction(database, async (connection) => {
      const repository = createPartnerMilestoneMailRepository(connection);
      if ((await repository.lockSubscriber(subscriberId)) === null)
        return false;
      if (!(await partnerAttributionEnabledForWrite(connection))) return false;
      if (!(await broadcastEnabled(connection))) return false;
      if (
        (await repository.lockInviteEligible(
          subscriberId,
          partnerInviteThreshold,
        )) === null
      )
        return false;
      const recipient =
        await createEmailRepository(connection).recipient(subscriberId);
      if (
        recipient === null ||
        recipient.suppressed ||
        recipient.marketing_consent_at === null
      )
        return false;
      return queueWithStatusLink(connection, dependencies, {
        businessKey: partnerInviteBusinessKey(subscriberId),
        subscriberId,
        template: partnerInviteTemplate,
        provider: 'brevo',
      });
    }).catch(ignoreLostRace);
  }

  return {
    async run(limit: number): Promise<number> {
      assertLimit(limit);
      // Flag off sends nothing; each send checks again inside its transaction.
      if (!(await partnerAttributionEnabled(database))) return 0;
      if (!(await broadcastEnabled(database))) return 0;
      const due = await createPartnerMilestoneMailRepository(
        database,
      ).findInviteDue(partnerInviteThreshold, limit);
      let queued = 0;
      for (const candidate of due) {
        if (await invite(candidate.subscriber_id)) queued += 1;
      }
      return queued;
    },
  };
}

export function createPartnerFirstSignupJob(
  database: DatabasePool,
  dependencies: MilestoneMailDependencies,
) {
  async function notify(
    partnerId: string,
    subscriberId: string,
  ): Promise<boolean> {
    return withTransaction(database, async (connection) => {
      const repository = createPartnerMilestoneMailRepository(connection);
      // Subscriber, then the flag row, then partner: the order activation,
      // the welcome and erasure lock in.
      if ((await repository.lockSubscriber(subscriberId)) === null)
        return false;
      if (!(await partnerAttributionEnabledForWrite(connection))) return false;
      if (
        (await repository.lockFirstSignupEligible(partnerId, subscriberId)) ===
        null
      )
        return false;
      const recipient =
        await createEmailRepository(connection).recipient(subscriberId);
      if (recipient === null || recipient.suppressed) return false;
      return queueWithStatusLink(connection, dependencies, {
        businessKey: partnerFirstSignupBusinessKey(partnerId),
        subscriberId,
        template: partnerFirstSignupTemplate,
        provider: 'resend',
      });
    }).catch(ignoreLostRace);
  }

  return {
    async run(limit: number): Promise<number> {
      assertLimit(limit);
      if (!(await partnerAttributionEnabled(database))) return 0;
      const due =
        await createPartnerMilestoneMailRepository(database).findFirstSignupDue(
          limit,
        );
      let queued = 0;
      for (const candidate of due) {
        if (await notify(candidate.partner_id, candidate.subscriber_id))
          queued += 1;
      }
      return queued;
    },
  };
}
