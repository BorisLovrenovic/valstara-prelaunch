import { createAuditService, type AuditService } from '../audit/service.ts';
import {
  ConfigurationError,
  getEmailQuotaConfiguration,
  getGiveawayEntryPeriodStart,
  type EmailQuotaConfiguration,
} from '../config.ts';
import {
  createCampaignFlagRepository,
  type CampaignFlagRepository,
} from '../db/campaign-flags.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { currentRulesFromFiles } from '../giveaway/current-rules-file.ts';
import { createGiveawayEntryReconciliationJob } from '../giveaway/reconcile.ts';
import type { CurrentGiveawayRules } from '../giveaway/accrue.ts';

import {
  campaignFlagKeys,
  campaignFlagRegistry,
  isFlagKey,
  type FlagKey,
} from './registry.ts';
import type { Flag, FlagClock, FlagService } from './types.ts';

export const flagCacheTtlMilliseconds = 5_000;

type FlagValues = Readonly<Record<FlagKey, boolean>>;

interface CacheEntry {
  readonly expiresAt: number;
  readonly values: FlagValues;
}

type FlagChangeOperation = (
  repository: CampaignFlagRepository,
  audit: Pick<AuditService, 'record'>,
) => Promise<void>;

type RunFlagChange = (operation: FlagChangeOperation) => Promise<void>;

const systemClock: FlagClock = {
  now: () => Date.now(),
};

export function createFlagService(
  database: DatabasePool,
  giveaway: {
    currentRules?: () => Promise<CurrentGiveawayRules>;
    periodStart?: Date;
    emailQuota?: EmailQuotaConfiguration;
    onGiveawayEntry?: (method: 'base' | 'referral') => void;
  } = {},
): FlagService {
  const service = createFlagServiceWithDependencies(
    createCampaignFlagRepository(database),
    async (operation) => {
      await withTransaction(database, async (connection) => {
        await operation(
          createCampaignFlagRepository(connection),
          createAuditService(connection),
        );
      });
    },
  );
  return {
    ...service,
    async set(key, enabled, actor) {
      if (key === 'giveaway.open' && enabled) {
        const quota = giveaway.emailQuota ?? getEmailQuotaConfiguration();
        const freeProviders = (['resend', 'brevo'] as const).filter(
          (provider) => quota[provider].tier !== 'paid',
        );
        if (freeProviders.length > 0) {
          if (actor.trim() === '')
            throw new TypeError('A campaign flag change requires an actor.');
          await withTransaction(database, async (connection) => {
            await createAuditService(connection).record({
              action: 'flag.enable_refused',
              actor,
              detail: { reason: 'email_free_tier', providers: freeProviders },
              subjectId: key,
              subjectType: 'campaign_flag',
            });
          });
          throw new Error('giveaway_open_requires_paid_email_tiers');
        }
      }
      const periodStart = giveaway.periodStart ?? getGiveawayEntryPeriodStart();
      if (key === 'giveaway.open' && enabled && periodStart === null) {
        throw new ConfigurationError(
          'WAITLIST_LIVE_AT',
          'is required before giveaway.open is enabled',
        );
      }
      await service.set(key, enabled, actor);
      if (key === 'giveaway.open' && enabled) {
        const job = createGiveawayEntryReconciliationJob(
          database,
          service,
          giveaway.currentRules ?? currentRulesFromFiles,
          periodStart,
          undefined,
          giveaway.onGiveawayEntry,
        );
        let checked: number;
        do {
          ({ checked } = await job.run(1_000));
        } while (
          checked === 1_000 &&
          (await service.isEnabled('giveaway.open'))
        );
      }
    },
  };
}

export function createFlagServiceWithDependencies(
  repository: CampaignFlagRepository,
  runFlagChange: RunFlagChange,
  clock: FlagClock = systemClock,
): FlagService {
  let cache: CacheEntry | null = null;

  async function effectiveValues(): Promise<FlagValues> {
    const now = clock.now();
    if (cache !== null && now < cache.expiresAt) {
      return cache.values;
    }

    const values = await readValues(repository);
    cache = {
      expiresAt: clock.now() + flagCacheTtlMilliseconds,
      values,
    };
    return values;
  }

  return {
    async isEnabled(key) {
      assertFlagKey(key);
      return (await effectiveValues())[key];
    },
    async list() {
      const values = await effectiveValues();
      return campaignFlagKeys.map<Flag>((key) => ({
        enabled: values[key],
        key,
      }));
    },
    async set(key, enabled, actor) {
      assertFlagKey(key);
      assertEnabled(enabled);
      assertActor(actor);

      await runFlagChange(async (transactionRepository, transactionAudit) => {
        await transactionRepository.set(key, enabled, actor);
        await transactionAudit.record({
          action: 'flag.changed',
          actor,
          detail: { enabled },
          subjectId: key,
          subjectType: 'campaign_flag',
        });
      });
      cache = null;
    },
  };
}

async function readValues(
  repository: CampaignFlagRepository,
): Promise<FlagValues> {
  try {
    const rows = await repository.list(campaignFlagKeys);
    const values: Record<FlagKey, boolean> = { ...campaignFlagRegistry };

    for (const row of rows) {
      assertFlagKey(row.key);
      values[row.key] = row.enabled;
    }

    return Object.freeze(values);
  } catch {
    return campaignFlagRegistry;
  }
}

function assertFlagKey(key: string): asserts key is FlagKey {
  if (!isFlagKey(key)) {
    throw new RangeError(`Unregistered campaign flag: ${key}`);
  }
}

function assertEnabled(enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    throw new TypeError('A campaign flag value must be boolean.');
  }
}

function assertActor(actor: string): void {
  if (actor.trim().length === 0) {
    throw new TypeError('A campaign flag change requires an actor.');
  }
}
