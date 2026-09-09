import type { VerificationRateConfiguration } from '../config.ts';
import {
  createVerificationRateRepository,
  type MailboxProvider,
  type VerificationRateCounts,
  type VerificationRateRepository,
} from '../db/verification-rate.ts';
import type { DatabaseConnection } from '../db/pool.ts';

export type VerificationRateState = 'collapsed' | 'healthy' | 'warming_up';

export interface VerificationRate {
  readonly rate: number | null;
  readonly signups: number;
  readonly verified: number;
}

export interface ProviderVerificationRate extends VerificationRate {
  readonly provider: MailboxProvider;
}

export interface VerificationRateHealth {
  readonly baseline: VerificationRate;
  readonly current: VerificationRate;
  readonly measuredAt: Date;
  readonly providers: readonly ProviderVerificationRate[];
  readonly state: VerificationRateState;
}

export interface VerificationRateAlert {
  readonly baselineRate: number;
  readonly currentRate: number;
  readonly measuredAt: Date;
  readonly relativeDrop: number;
  readonly severity: 'P1';
}

export interface VerificationRateDependencies {
  readonly alert?: (alert: VerificationRateAlert) => void;
  readonly clock?: () => Date;
}

export interface VerificationRateMonitor {
  health(): Promise<VerificationRateHealth>;
  run(): Promise<VerificationRateHealth>;
}

export function createVerificationRateMonitor(
  database: DatabaseConnection,
  configuration: VerificationRateConfiguration,
  dependencies: VerificationRateDependencies = {},
): VerificationRateMonitor {
  return createVerificationRateMonitorWithRepository(
    createVerificationRateRepository(database),
    configuration,
    dependencies,
  );
}

export function createVerificationRateMonitorWithRepository(
  repository: VerificationRateRepository,
  configuration: VerificationRateConfiguration,
  dependencies: VerificationRateDependencies = {},
): VerificationRateMonitor {
  assertConfiguration(configuration);
  const clock = dependencies.clock ?? (() => new Date());
  const alert = dependencies.alert ?? (() => undefined);

  async function health(): Promise<VerificationRateHealth> {
    const measuredAt = clock();
    const currentFrom = new Date(
      measuredAt.getTime() - configuration.cohortHours * 60 * 60 * 1_000,
    );
    const baselineFrom = new Date(
      currentFrom.getTime() - configuration.baselineDays * 24 * 60 * 60 * 1_000,
    );
    const [currentCounts, baselineCounts, providerCounts] = await Promise.all([
      repository.counts(currentFrom, measuredAt),
      repository.counts(baselineFrom, currentFrom),
      repository.providerCounts(currentFrom, measuredAt),
    ]);
    const current = rate(currentCounts);
    const baseline = rate(baselineCounts);
    const state = stateFor(current, baseline, configuration);

    return {
      baseline,
      current,
      measuredAt,
      providers: providerCounts.map((provider) => ({
        provider: provider.provider,
        ...rate(provider),
      })),
      state,
    };
  }

  return {
    health,
    async run() {
      const result = await health();
      if (
        result.state === 'collapsed' &&
        result.baseline.rate !== null &&
        result.current.rate !== null
      ) {
        alert({
          baselineRate: result.baseline.rate,
          currentRate: result.current.rate,
          measuredAt: result.measuredAt,
          relativeDrop:
            (result.baseline.rate - result.current.rate) / result.baseline.rate,
          severity: 'P1',
        });
      }
      return result;
    },
  };
}

function rate(counts: VerificationRateCounts): VerificationRate {
  return {
    rate: counts.signups === 0 ? null : counts.verified / counts.signups,
    signups: counts.signups,
    verified: counts.verified,
  };
}

function stateFor(
  current: VerificationRate,
  baseline: VerificationRate,
  configuration: VerificationRateConfiguration,
): VerificationRateState {
  if (
    current.signups < configuration.minimumSignups ||
    baseline.signups < configuration.minimumSignups ||
    current.rate === null ||
    baseline.rate === null ||
    baseline.rate === 0
  ) {
    return 'warming_up';
  }

  const relativeDrop = (baseline.rate - current.rate) / baseline.rate;
  return relativeDrop >= configuration.collapsePercent / 100
    ? 'collapsed'
    : 'healthy';
}

function assertConfiguration(
  configuration: VerificationRateConfiguration,
): void {
  const positiveValues = [
    configuration.baselineDays,
    configuration.cohortHours,
    configuration.minimumSignups,
  ];
  if (positiveValues.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new RangeError(
      'Verification-rate windows and minimum signups must be positive integers.',
    );
  }
  if (
    !Number.isInteger(configuration.collapsePercent) ||
    configuration.collapsePercent < 1 ||
    configuration.collapsePercent > 100
  ) {
    throw new RangeError(
      'Verification-rate collapse percent must be from 1 to 100.',
    );
  }
}
