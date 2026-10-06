import type { ReferralAttributionConfiguration } from '../config.ts';
import type {
  AttributionCounts,
  ReferralAttributionHealthRepository,
} from '../db/referral-attribution-health.ts';

export type AttributionHealthState =
  'disabled' | 'warming_up' | 'healthy' | 'collapsed';

export interface AttributionShare extends AttributionCounts {
  readonly share: number | null;
}

export interface ReferralAttributionHealth {
  readonly baseline: AttributionShare | null;
  readonly current: AttributionShare | null;
  readonly measuredAt: Date;
  readonly state: AttributionHealthState;
}

export interface ReferralAttributionAlert {
  readonly baselineShare: number;
  readonly currentShare: number;
  readonly measuredAt: Date;
  readonly relativeDrop: number;
  readonly severity: 'P1';
}

export function createReferralAttributionHealth(
  repository: ReferralAttributionHealthRepository,
  configuration: ReferralAttributionConfiguration,
  isEnabled: () => Promise<boolean>,
  clock: () => Date,
): () => Promise<ReferralAttributionHealth> {
  return async () => {
    const measuredAt = clock();
    if (!(await isEnabled())) {
      return { baseline: null, current: null, measuredAt, state: 'disabled' };
    }
    const currentFrom = new Date(
      measuredAt.getTime() - configuration.cohortHours * 60 * 60 * 1_000,
    );
    const baselineFrom = new Date(
      currentFrom.getTime() - configuration.baselineDays * 24 * 60 * 60 * 1_000,
    );
    const counts = await repository.counts(
      baselineFrom,
      currentFrom,
      measuredAt,
    );
    const baseline = share(counts.baseline);
    const current = share(counts.current);
    const state =
      current.signups < configuration.minimumSignups ||
      baseline.share === null ||
      baseline.share === 0 ||
      current.share === null
        ? 'warming_up'
        : (baseline.share - current.share) / baseline.share >=
            configuration.dropPercent / 100
          ? 'collapsed'
          : 'healthy';
    return { baseline, current, measuredAt, state };
  };
}

export async function runReferralAttributionCheck(
  attributionHealth: () => Promise<ReferralAttributionHealth>,
  alert: (input: ReferralAttributionAlert) => Promise<void>,
): Promise<ReferralAttributionHealth> {
  const result = await attributionHealth();
  if (
    result.state === 'collapsed' &&
    result.baseline?.share !== null &&
    result.baseline?.share !== undefined &&
    result.current?.share !== null &&
    result.current?.share !== undefined
  ) {
    await alert({
      baselineShare: result.baseline.share,
      currentShare: result.current.share,
      measuredAt: result.measuredAt,
      relativeDrop:
        (result.baseline.share - result.current.share) / result.baseline.share,
      severity: 'P1',
    });
  }
  return result;
}

function share(counts: AttributionCounts): AttributionShare {
  return {
    ...counts,
    share: counts.signups === 0 ? null : counts.attributed / counts.signups,
  };
}
