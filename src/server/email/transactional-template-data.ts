import { createEmailTemplateRepository } from '../db/email-template.ts';
import type { DatabasePool } from '../db/pool.ts';
import { createReferralService } from '../referral/service.ts';

import type { TransactionalTemplateData } from './transactional-templates.ts';

export function createTransactionalTemplateData(
  database: DatabasePool,
): TransactionalTemplateData {
  const repository = createEmailTemplateRepository(database);
  async function subject(statusTokenId: string): Promise<string> {
    const subscriberId = await repository.statusTokenSubject(statusTokenId);
    if (subscriberId === null)
      throw new Error('email_template_status_token_missing');
    return subscriberId;
  }
  return {
    async referralStatus(statusTokenId) {
      return createReferralService(database).status(
        await subject(statusTokenId),
      );
    },
    async receiptEntries(statusTokenId, rulesVersion) {
      return repository.receiptEntries(
        await subject(statusTokenId),
        rulesVersion,
      );
    },
    async winnerDetails(awardId, statusTokenId) {
      const details = await repository.winnerDetails(
        awardId,
        await subject(statusTokenId),
      );
      if (details === null) throw new Error('email_template_winner_missing');
      return details;
    },
  };
}
