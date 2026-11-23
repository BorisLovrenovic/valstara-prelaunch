import { createPartnerAttributionRepository } from '../db/partner-attribution.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { createReferralRepository } from '../db/referral.ts';
import { withTransaction } from '../db/transaction.ts';
import {
  partnerAttributionEnabled,
  partnerAttributionEnabledForWrite,
  partnerWelcomeDiscount,
} from '../referral/partner-perks.ts';
import { recomputeReferralRewards } from '../referral/rewards.ts';

export const partnerActivationBatchLimit = 100;

/** The caller holds the linked subscriber lock before the partner lock. */
export async function activatePartnerCode(
  connection: DatabaseConnection,
  partnerId: string,
  subscriberId: string,
  now: Date,
  actor: string,
): Promise<boolean> {
  if (!(await partnerAttributionEnabledForWrite(connection))) return false;
  const repository = createPartnerAttributionRepository(connection);
  if ((await repository.findLivePartner(subscriberId, null))?.id === partnerId)
    return false;
  await repository.setCodeActive(partnerId, true);
  if ((await repository.findLivePartner(subscriberId, null))?.id !== partnerId)
    return false;
  await recomputeReferralRewards(connection, subscriberId, { actor, now });
  return true;
}

export function createPartnerActivationJob(
  database: DatabasePool,
  clock: () => Date,
) {
  const actor = 'system:partner-activation';
  const repository = createPartnerAttributionRepository(database);

  return {
    async run(limit: number): Promise<number> {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > partnerActivationBatchLimit
      ) {
        throw new RangeError('Invalid partner activation batch size.');
      }
      if (!(await partnerAttributionEnabled(database))) return 0;

      const partners = await repository.findDeferredPartners(limit);
      let changed = 0;
      for (const partner of partners) {
        const activated = await withTransaction(
          database,
          async (connection) => {
            await createReferralRepository(connection).lockSubscriber(
              partner.referrer_id,
            );
            return activatePartnerCode(
              connection,
              partner.partner_id,
              partner.referrer_id,
              clock(),
              actor,
            );
          },
        );
        if (activated) changed += 1;
      }

      const remaining = limit - partners.length;
      if (remaining === 0) return changed;
      for (const edge of await repository.findRetroactiveEdges(remaining)) {
        const applied = await withTransaction(database, async (connection) => {
          const referrals = createReferralRepository(connection);
          // Confirmation and voids use the same friend, referrer, edge order.
          if (
            (await referrals.lockSubscriber(edge.referred_id))?.status !==
            'verified'
          )
            return false;
          await referrals.lockSubscriber(edge.referrer_id);
          if (!(await partnerAttributionEnabledForWrite(connection)))
            return false;
          const attribution = createPartnerAttributionRepository(connection);
          const signup = await attribution.findRetroactiveSignup(
            edge.id,
            edge.partner_id,
          );
          if (signup === null) return false;
          const count =
            signup.signup_confirmed_count ??
            (await attribution.countAtLegacySignup(edge.id));
          const discount = partnerWelcomeDiscount(count, signup.partner_type);
          if (
            (await attribution.attributeRetroactively(
              edge.id,
              edge.partner_id,
              discount,
            )) !== 1
          ) {
            throw new Error('The retroactive referral could not be recorded.');
          }
          await recomputeReferralRewards(connection, edge.referred_id, {
            actor,
            now: clock(),
          });
          return true;
        });
        if (applied) changed += 1;
      }
      return changed;
    },
  };
}
