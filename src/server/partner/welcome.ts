import { createEmailRepository } from '../db/email.ts';
import { createPartnerDashboardRepository } from '../db/partner-dashboard.ts';
import { createPartnerWelcomeRepository } from '../db/partner-welcome.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import type { QueueEmailInput } from '../email/service.ts';
import {
  partnerAttributionEnabled,
  partnerAttributionEnabledForWrite,
} from '../referral/partner-perks.ts';
import { createVerificationService } from '../verification/service.ts';

import { partnerWelcomeBusinessKey, partnerWelcomeTemplate } from './config.ts';

// E11.7-11 (D-057): the partner welcome. It goes once to every partner who
// is active with a live code: in a catch-up for those already active when it
// ships, and on the first maintenance cycle after any later activation or
// reactivation of a partner who never had it. The welcome carries a fresh
// private dashboard link, issued under E11.7-09's rules: issuing it cancels
// any earlier link, in the same transaction that queues the mail.

export const partnerWelcomeBatchLimit = 100;

interface WelcomeQueue {
  queue(
    input: QueueEmailInput,
    connection: DatabaseConnection,
  ): Promise<boolean>;
}

class AlreadyWelcomed extends Error {}

export function createPartnerWelcomeJob(
  database: DatabasePool,
  dependencies: {
    readonly clock: () => Date;
    readonly email: WelcomeQueue;
    readonly tokenSecret?: string;
  },
) {
  const { clock, email } = dependencies;

  async function welcome(partnerId: string, subscriberId: string) {
    return withTransaction(database, async (connection) => {
      const repository = createPartnerWelcomeRepository(connection);
      // Subscriber, then partner: the order activation and erasure lock in.
      if ((await repository.lockSubscriber(subscriberId)) === null)
        return false;
      // The flag row is locked for the transaction, so the programme cannot
      // be paused between this check and the queued mail.
      if (!(await partnerAttributionEnabledForWrite(connection))) return false;
      const partner = await repository.lockEligible(partnerId, subscriberId);
      if (partner === null) return false;
      const recipient =
        await createEmailRepository(connection).recipient(subscriberId);
      if (recipient === null || recipient.suppressed) return false;

      const link = await createVerificationService(connection, {
        clock,
        ...(dependencies.tokenSecret === undefined
          ? {}
          : { tokenSecret: dependencies.tokenSecret }),
      }).issue(subscriberId, 'partner_dashboard');
      const queued = await email.queue(
        {
          businessKey: partnerWelcomeBusinessKey(partner.id),
          subscriberId,
          template: partnerWelcomeTemplate,
          provider: 'resend',
          payload: { token_id: link.id },
          expiresAt: link.expiresAt,
        },
        connection,
      );
      // Another run welcomed this partner first: keep their current link.
      if (!queued) throw new AlreadyWelcomed();
      if (
        (await createPartnerDashboardRepository(connection).setCurrentLink(
          partner.id,
          link.id,
        )) !== 1
      ) {
        throw new Error('The welcome dashboard link could not be set.');
      }
      return true;
    }).catch((error: unknown) => {
      if (error instanceof AlreadyWelcomed) return false;
      throw error;
    });
  }

  return {
    async run(limit: number): Promise<number> {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > partnerWelcomeBatchLimit
      ) {
        throw new RangeError('Invalid partner welcome batch size.');
      }
      // Flag off sends nothing; each send checks again under the flag lock.
      if (!(await partnerAttributionEnabled(database))) return 0;
      const due = await createPartnerWelcomeRepository(database).findDue(limit);
      let queued = 0;
      for (const candidate of due) {
        if (await welcome(candidate.partner_id, candidate.subscriber_id))
          queued += 1;
      }
      return queued;
    },
  };
}
