import {
  mergePriceIndex,
  type MergeInput,
  type MergeRun,
} from '../../packages/price-index/src/pipeline/index.ts';
import type {
  ApprovalEntry,
  CatalogueFile,
  ManualEntry,
  MarketsFile,
  MergeSettings,
  NotOfferedEntry,
  PriceOverride,
  PriceRecord,
} from '../../packages/price-index/src/schema/index.ts';
import type {
  Observation,
  SourceGap,
} from '../../packages/price-index/src/sources/index.ts';

// Shared by the E11.6-06 merge and publish-gate suites. A module of exports
// only, so running it bare (node --test discovers every file under test/)
// does nothing. Every fixture is explicit: a test names the values it needs.

export const scraper = 'scraper:youfundceo.com';
export const runTime = '2026-12-01T09:30:00.000Z';
export const sweden = 'https://www.youfundceo.com/services/spotify/sweden';
export const official = 'https://www.spotify.com/se/premium/';

export function settings(
  overrides: Partial<MergeSettings> = {},
): MergeSettings {
  return {
    change_threshold_percent: 40,
    stale_after_days: { scraped: 45, manual: 90 },
    ...overrides,
  };
}

export function clockAt(iso: string): { now(): Date } {
  return { now: () => new Date(iso) };
}

/** Spotify Premium — Individual, monthly: the one plan most cases need. */
export function oneServiceCatalogue(): CatalogueFile {
  return {
    services: [
      {
        service_id: 'spotify',
        name: 'Spotify Premium',
        category: 'music',
        website_url: 'https://www.spotify.com/',
        status: 'launch',
        plans: [
          {
            plan_id: 'individual',
            name: 'Individual',
            billing_period: 'month',
            is_student: false,
            is_family: false,
          },
        ],
        source_aliases: { service: ['Spotify'], plans: {} },
      },
    ],
  };
}

/** Sweden, enabled, in SEK: the one market most cases need. */
export function oneMarket(): MarketsFile {
  return {
    markets: [
      {
        code: 'SE',
        name: 'Sweden',
        slug: 'sweden',
        currency: 'SEK',
        enabled: true,
      },
    ],
  };
}

export function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    price_local: '149.00',
    price_source_text: 'kr 149',
    currency: 'SEK',
    price_usd_source: '15.79',
    source: scraper,
    source_url: sweden,
    observed_at: runTime,
    source_verified_at: '2026-11-28',
    ...overrides,
  };
}

export function gap(overrides: Partial<SourceGap> = {}): SourceGap {
  return {
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    reason: 'not_on_source',
    source_url: 'https://www.youfundceo.com/countries/sweden',
    note: null,
    ...overrides,
  };
}

/** A previous record: by default a published scraped value of 129.00 SEK. */
export function record(overrides: Partial<PriceRecord> = {}): PriceRecord {
  return {
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    price_local: '129.00',
    price_source_text: 'kr 129',
    currency: 'SEK',
    price_usd_source: '13.67',
    source: scraper,
    source_url: sweden,
    observed_at: '2026-11-01T09:30:00.000Z',
    source_verified_at: '2026-10-28',
    status: 'ok',
    missing_reason: null,
    notes: null,
    ...overrides,
  };
}

export function priceOverride(
  overrides: Partial<PriceOverride> = {},
): PriceOverride {
  return {
    kind: 'price',
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    source_url: official,
    verified_at: '2026-11-30',
    verified_by: 'Founder',
    note: null,
    price_local: '149.00',
    currency: 'SEK',
    price_usd_source: null,
    ...overrides,
  };
}

export function notOffered(
  overrides: Partial<NotOfferedEntry> = {},
): NotOfferedEntry {
  return {
    kind: 'not_offered',
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    source_url: official,
    verified_at: '2026-11-30',
    verified_by: 'Founder',
    note: null,
    ...overrides,
  };
}

export function decision(
  overrides: Partial<ApprovalEntry> = {},
): ApprovalEntry {
  return {
    decision: 'approve',
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    price_local: '149.00',
    currency: 'SEK',
    source: scraper,
    actor: 'Founder',
    decided_at: '2026-12-01T10:00:00.000Z',
    ...overrides,
  };
}

export function run(overrides: Partial<MergeRun> = {}): MergeRun {
  return {
    source: scraper,
    observedAt: runTime,
    observations: [],
    gaps: [],
    ...overrides,
  };
}

export interface SingleCase {
  previous?: PriceRecord;
  observation?: Observation;
  gap?: SourceGap;
  entry?: ManualEntry;
  approvals?: ApprovalEntry[];
  now?: string;
  settings?: MergeSettings;
}

/** The input for one plan in one market (Spotify, Sweden). */
export function singleInput(spec: SingleCase): MergeInput {
  return {
    previous:
      spec.previous === undefined
        ? null
        : { built_at: '2026-11-01T10:00:00.000Z', records: [spec.previous] },
    run: run({
      observations: spec.observation ? [spec.observation] : [],
      gaps: spec.gap ? [spec.gap] : [],
    }),
    overrides: { overrides: spec.entry ? [spec.entry] : [] },
    approvals: { approvals: spec.approvals ?? [] },
    catalogue: oneServiceCatalogue(),
    markets: oneMarket(),
    settings: spec.settings ?? settings(),
    clock: clockAt(spec.now ?? runTime),
  };
}

/** Merges one plan in one market and returns its one record. */
export function mergeSingle(spec: SingleCase): PriceRecord {
  const latest = mergePriceIndex(singleInput(spec));
  if (latest.records.length !== 1) {
    throw new Error(`expected one record, got ${latest.records.length}`);
  }
  return latest.records[0]!;
}
