import { createAuditService, type AuditService } from '../audit/service.ts';
import {
  createCampaignFlagRepository,
  type CampaignFlagRepository,
} from '../db/campaign-flags.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';

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

export function createFlagService(database: DatabasePool): FlagService {
  return createFlagServiceWithDependencies(
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
