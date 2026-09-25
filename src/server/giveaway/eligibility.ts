import {
  createGiveawayEligibilityRepository,
  type GiveawayEligibilityRepository,
} from '../db/giveaway-eligibility.ts';
import type { DatabaseConnection } from '../db/pool.ts';
import type { FlagService } from '../flags/types.ts';

export interface GiveawayEligibilityService {
  isEligible(subscriberId: string): Promise<boolean>;
}

export function createGiveawayEligibilityService(
  database: DatabaseConnection,
  flags: Pick<FlagService, 'isEnabled'>,
): GiveawayEligibilityService {
  return createGiveawayEligibilityServiceWithDependencies(
    createGiveawayEligibilityRepository(database),
    flags,
  );
}

export function createGiveawayEligibilityServiceWithDependencies(
  repository: GiveawayEligibilityRepository,
  flags: Pick<FlagService, 'isEnabled'>,
): GiveawayEligibilityService {
  return {
    async isEligible(subscriberId) {
      if (!(await flags.isEnabled('giveaway.open'))) {
        return false;
      }
      return (await repository.statusFor(subscriberId)) === 'verified';
    },
  };
}
