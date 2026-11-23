import type { DatabaseConnection } from '../db/pool.ts';
import {
  createCampaignFlagRepository,
  lockPartnerActivationFlag,
} from '../db/campaign-flags.ts';
import { campaignFlagRegistry } from '../flags/registry.ts';

export function partnerWelcomeDiscount(
  confirmedCount: number,
  partnerType: string,
): 10 | 15 | 20 {
  if (confirmedCount >= 39) return 20;
  if (confirmedCount >= 21 || partnerType === 'student_ambassador') return 15;
  return 10;
}

/** Read the live override during attribution and activation, without cache lag. */
export async function partnerAttributionEnabled(
  connection: DatabaseConnection,
): Promise<boolean> {
  const [row] = await createCampaignFlagRepository(connection).list([
    'partners.enabled',
  ]);
  return row?.enabled ?? campaignFlagRegistry['partners.enabled'];
}

/** Use inside the transaction that applies partner attribution or activation. */
export async function partnerAttributionEnabledForWrite(
  connection: DatabaseConnection,
): Promise<boolean> {
  await lockPartnerActivationFlag(connection);
  return partnerAttributionEnabled(connection);
}
