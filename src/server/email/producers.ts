import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { createEmailRepository } from '../db/email.ts';
import { tryInSavepoint } from '../db/transaction.ts';
import { createVerificationService } from '../verification/service.ts';

import { createEmailQueue } from './queue.ts';

export interface TransactionalEmailProducers {
  welcome(
    connection: DatabaseConnection,
    subscriberId: string,
  ): Promise<boolean>;
  milestone(
    connection: DatabaseConnection,
    subscriberId: string,
    tier: number,
  ): Promise<boolean>;
  receipt(
    connection: DatabaseConnection,
    subscriberId: string,
    rulesVersion: string,
  ): Promise<boolean>;
}

export function createTransactionalEmailProducers(
  database: DatabasePool,
  clock: () => Date,
  email: Pick<ReturnType<typeof createEmailQueue>, 'queue'> = createEmailQueue(
    database,
    clock,
  ),
): TransactionalEmailProducers {
  async function queue(
    connection: DatabaseConnection,
    subscriberId: string,
    template: string,
    businessKey: string,
    references: Readonly<Record<string, string | number>> = {},
  ): Promise<boolean> {
    return tryInSavepoint(connection, async () => {
      const repository = createEmailRepository(connection);
      await repository.lockBusinessKey(businessKey);
      if (await repository.findByBusinessKey(businessKey)) return false;
      const status = await createVerificationService(connection, {
        clock,
      }).issue(subscriberId, 'status');
      return email.queue(
        {
          template,
          subscriberId,
          businessKey,
          provider: 'resend',
          payload: { ...references, status_token_id: status.id },
        },
        connection,
      );
    });
  }
  return {
    welcome: (connection, subscriberId) =>
      queue(connection, subscriberId, 'welcome', `welcome:${subscriberId}`),
    milestone: (connection, subscriberId, tier) =>
      queue(
        connection,
        subscriberId,
        'milestone_reached',
        `milestone:${subscriberId}:${tier}`,
        { tier },
      ),
    receipt: (connection, subscriberId, rulesVersion) =>
      queue(
        connection,
        subscriberId,
        'giveaway_entry_receipt',
        `giveaway-receipt:${subscriberId}:${rulesVersion}`,
        { rules_version: rulesVersion },
      ),
  };
}
