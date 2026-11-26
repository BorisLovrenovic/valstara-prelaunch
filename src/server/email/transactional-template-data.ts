import { createEmailTemplateRepository } from '../db/email-template.ts';
import type { DatabasePool } from '../db/pool.ts';
import { createFlagService } from '../flags/service.ts';
import { createReferralService } from '../referral/service.ts';

import type { TransactionalTemplateData } from './transactional-templates.ts';

export function createTransactionalTemplateData(
  database: DatabasePool,
): TransactionalTemplateData {
  const repository = createEmailTemplateRepository(database);
  const flags = createFlagService(database);
  async function subject(statusTokenId: string): Promise<string> {
    const subscriberId = await repository.statusTokenSubject(statusTokenId);
    if (subscriberId === null)
      throw new Error('email_template_status_token_missing');
    return subscriberId;
  }
  return {
    async referralStatus(statusTokenId) {
      const status = await createReferralService(database).status(
        await subject(statusTokenId),
      );
      if (
        status.partnerWelcomePerk === undefined ||
        (await flags.isEnabled('referral.enabled'))
      )
        return status;
      return { ...status, partnerWelcomePerk: undefined };
    },
    async memberReferral(statusTokenId) {
      // Off, nothing more is read and the welcome email is unchanged.
      if (!(await flags.isEnabled('email.referred_welcome_line'))) return false;
      return repository.memberReferred(await subject(statusTokenId));
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
