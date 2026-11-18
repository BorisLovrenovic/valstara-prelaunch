import assert from 'node:assert/strict';
import test from 'node:test';

import fc from 'fast-check';

import {
  mergePriceIndex,
  type MergeInput,
} from '../../packages/price-index/src/pipeline/index.ts';
import {
  isPublishable,
  publishedView,
  rankMarkets,
} from '../../packages/price-index/src/publish/index.ts';
import {
  latestFileSchema,
  recordIdentity,
  type ApprovalEntry,
  type CatalogueFile,
  type ManualEntry,
  type MarketsFile,
  type PriceRecord,
} from '../../packages/price-index/src/schema/index.ts';
import type {
  Observation,
  SourceGap,
} from '../../packages/price-index/src/sources/index.ts';
import { scraper, settings } from '../helpers/price-index-merge.ts';

// E11.6-06 acceptance criterion: a seeded property test over generated merges
// asserts that no record whose status is not `ok` or approved
// `manual_override` ever passes `isPublishable()`, appears in
// `publishedView()` or is ranked by `rankMarkets()`.
//
// "Approved `manual_override`" is D-028 Q2's meaning: a price override within
// 40% of the last published value (the previous record, when it was `ok`,
// `manual_override` or `stale`), or with nothing to compare with, or approved
// by the last `review` decision on its exact value. The oracle below
// computes that from the generated inputs on its own, without the merge's
// code, and checks every published `ok` record against the founder's rules
// the same way.

const markets: MarketsFile = {
  markets: [
    {
      code: 'SE',
      name: 'Sweden',
      slug: 'sweden',
      currency: 'SEK',
      enabled: true,
    },
    {
      code: 'US',
      name: 'United States',
      slug: 'united-states',
      currency: 'USD',
      enabled: true,
    },
    {
      code: 'DE',
      name: 'Germany',
      slug: 'germany',
      currency: 'EUR',
      enabled: true,
    },
  ],
};

const catalogue: CatalogueFile = {
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
      source_aliases: { service: [], plans: {} },
    },
    {
      service_id: 'netflix',
      name: 'Netflix',
      category: 'streaming',
      website_url: 'https://www.netflix.com/',
      status: 'launch',
      plans: [
        {
          plan_id: 'standard',
          name: 'Standard',
          billing_period: 'month',
          is_student: false,
          is_family: false,
        },
      ],
      source_aliases: { service: [], plans: {} },
    },
  ],
};

const plans = catalogue.services.flatMap((service) =>
  service.plans.map((plan) => ({
    service_id: service.service_id,
    plan_id: plan.plan_id,
    billing_period: plan.billing_period,
  })),
);
const identities = plans.flatMap((plan) =>
  markets.markets.map((market) => ({ ...plan, market: market.code })),
);
const currencyOf = new Map(
  markets.markets.map((market) => [market.code, market.currency]),
);

// Values sit around the 40% edges of 100.00, so every branch is reached.
const prices = [
  '0.00',
  '59.99',
  '60.00',
  '100.00',
  '129.00',
  '140.00',
  '140.01',
  '149.00',
  '250.00',
];
const usd = fc.constantFrom(null, '9.99', '12.40', '12.40', '15.79', '23.40');
const day = (offset: number) =>
  new Date(Date.UTC(2026, 8, 1) + offset * 86_400_000).toISOString();
const instant = fc.integer({ min: 0, max: 150 }).map(day);
const date = fc
  .integer({ min: 0, max: 150 })
  .map((offset) => day(offset).slice(0, 10));
const url = 'https://www.youfundceo.com/services/x/y';

type Identity = (typeof identities)[number];

function previousRecord(identity: Identity) {
  const marketCurrency = currencyOf.get(identity.market)!;
  const priced = fc.record({
    price_local: fc.constantFrom(...prices.filter((price) => price !== '0.00')),
    currency: fc.constantFrom(marketCurrency, marketCurrency, 'SEK'),
    price_usd_source: usd,
  });
  const base = {
    ...identity,
    price_source_text: null,
    source_url: url,
    source_verified_at: null,
    missing_reason: null,
    notes: null,
  };
  const unpriced = {
    price_local: null,
    currency: null,
    price_usd_source: null,
  };
  return fc.oneof(
    fc
      .record({
        value: priced,
        status: fc.constantFrom('ok', 'stale', 'conflict', 'needs_review'),
        observed_at: instant,
      })
      .map(({ value, status, observed_at }): PriceRecord => ({
        ...base,
        ...value,
        source: scraper,
        observed_at,
        status: status as PriceRecord['status'],
      })),
    fc
      .record({
        value: priced,
        status: fc.constantFrom('manual_override', 'stale', 'needs_review'),
      })
      .map(({ value, status }): PriceRecord => ({
        ...base,
        ...value,
        source: 'manual',
        observed_at: null,
        status: status as PriceRecord['status'],
      })),
    fc.constantFrom<PriceRecord>(
      {
        ...base,
        ...unpriced,
        source: scraper,
        observed_at: null,
        status: 'needs_review',
        notes:
          'Disappeared from the source; the last value was 100.00 SEK, observed 2026-09-01T00:00:00.000Z.',
      },
      {
        ...base,
        ...unpriced,
        source: scraper,
        observed_at: null,
        status: 'missing',
        missing_reason: 'not_on_source',
      },
      {
        ...base,
        ...unpriced,
        source: 'manual',
        observed_at: null,
        status: 'not_offered',
      },
      {
        ...base,
        ...unpriced,
        source: 'manual',
        observed_at: null,
        status: 'stale',
      },
    ),
  );
}

function runEntry(identity: Identity) {
  const marketCurrency = currencyOf.get(identity.market)!;
  return fc.oneof(
    fc.constant(null),
    fc
      .record({
        price_local: fc.constantFrom(...prices),
        currency: fc.constantFrom(
          marketCurrency,
          marketCurrency,
          marketCurrency,
          'SEK',
        ),
        price_usd_source: usd,
        observed_at: instant,
      })
      .map((value): Observation => ({
        ...identity,
        ...value,
        price_source_text: `${value.price_local} ${value.currency}`,
        source: scraper,
        source_url: url,
        source_verified_at: null,
      })),
    fc
      .constantFrom(
        'source_no_price',
        'not_on_source',
        'parse_failed',
        'market_failed',
      )
      .map((reason): SourceGap => ({
        ...identity,
        reason: reason as SourceGap['reason'],
        source_url: url,
        note: null,
      })),
  );
}

function manualEntry(identity: Identity) {
  const base = {
    ...identity,
    source_url: 'https://www.example.com/pricing',
    verified_by: 'Founder',
    note: null,
  };
  return fc.oneof(
    fc.constant(null),
    fc
      .record({
        price_local: fc.constantFrom(
          ...prices.filter((price) => price !== '0.00'),
        ),
        price_usd_source: usd,
        verified_at: date,
      })
      .map((value): ManualEntry => ({
        kind: 'price',
        ...base,
        ...value,
        currency: currencyOf.get(identity.market)!,
      })),
    date.map((verified_at): ManualEntry => ({
      kind: 'not_offered',
      ...base,
      verified_at,
    })),
  );
}

function decisions(identity: Identity) {
  return fc.array(
    fc
      .record({
        decision: fc.constantFrom('approve', 'reject', 'approve'),
        price_local: fc.constantFrom(null, ...prices),
        currency: fc.constantFrom(currencyOf.get(identity.market)!, 'SEK'),
        source: fc.constantFrom(scraper, 'manual'),
        decided_at: instant,
      })
      .map((value): ApprovalEntry => ({
        ...identity,
        ...value,
        decision: value.decision as ApprovalEntry['decision'],
        currency: value.price_local === null ? null : value.currency,
        actor: 'Founder',
      })),
    { maxLength: 3 },
  );
}

const world = fc
  .record({
    cases: fc.tuple(
      ...identities.map((identity) =>
        fc.record({
          identity: fc.constant(identity),
          previous: fc.option(previousRecord(identity), { nil: undefined }),
          run: runEntry(identity),
          entry: manualEntry(identity),
          decisions: decisions(identity),
        }),
      ),
    ),
    now: fc.integer({ min: 60, max: 200 }).map(day),
    threshold: fc.constantFrom(40, 40, 25),
  })
  .map(({ cases, now, threshold }) => ({ cases, now, threshold }));

type World = typeof world extends fc.Arbitrary<infer T> ? T : never;
type Case = World['cases'][number];

function inputOf(generated: World): MergeInput {
  const observations: Observation[] = [];
  const gaps: SourceGap[] = [];
  for (const { run } of generated.cases) {
    if (run !== null && 'reason' in run) {
      gaps.push(run);
    } else if (run !== null) {
      observations.push(run);
    }
  }
  const previous = generated.cases.flatMap(({ previous }) =>
    previous === undefined ? [] : [previous],
  );
  return {
    previous:
      previous.length === 0 ? null : { built_at: day(0), records: previous },
    run: { source: scraper, observedAt: generated.now, observations, gaps },
    overrides: {
      overrides: generated.cases.flatMap(({ entry }) =>
        entry === null ? [] : [entry],
      ),
    },
    approvals: {
      approvals: generated.cases.flatMap(({ decisions: list }) => list),
    },
    catalogue,
    markets,
    settings: settings({ change_threshold_percent: generated.threshold }),
    clock: { now: () => new Date(generated.now) },
  };
}

// --- The oracle -----------------------------------------------------------

function cents(value: string): bigint {
  return BigInt(value.replace('.', ''));
}

function lastDecisionApproves(
  list: readonly ApprovalEntry[],
  value: { price_local: string | null; currency: string | null },
  source: string,
): boolean {
  const matching = list.filter(
    (entry) =>
      entry.price_local === value.price_local &&
      entry.currency === value.currency &&
      entry.source === source,
  );
  return matching.at(-1)?.decision === 'approve';
}

/** True when `value` needs no approval against the previous record. */
function withinBaseline(
  previous: PriceRecord | undefined,
  value: { price_local: string; currency: string },
  threshold: number,
): boolean {
  if (
    previous === undefined ||
    !['ok', 'manual_override', 'stale'].includes(previous.status) ||
    previous.price_local === null
  ) {
    return true;
  }
  if (previous.currency !== value.currency) {
    return false;
  }
  const base = cents(previous.price_local);
  const next = cents(value.price_local);
  const difference = next > base ? next - base : base - next;
  return difference * 100n <= BigInt(threshold) * base;
}

/** The previous record is a `needs_review` or `conflict` flag. */
function flagged(previous: PriceRecord | undefined): boolean {
  return (
    previous !== undefined &&
    (previous.status === 'needs_review' || previous.status === 'conflict')
  );
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

/** Why the oracle refuses a published record, or null when it agrees. */
function oracleRefusal(
  published: PriceRecord,
  generated: Case,
  world: World,
): string | null {
  const { previous, run, entry, decisions: list } = generated;
  const value = {
    price_local: published.price_local!,
    currency: published.currency!,
  };
  if (published.status !== 'ok' && published.status !== 'manual_override') {
    return `status ${published.status} was published`;
  }
  if (published.currency !== currencyOf.get(published.market)) {
    return 'a price in another currency than the market was published';
  }
  if (cents(value.price_local) <= 0n) {
    return 'a price that is not above zero was published';
  }

  if (published.status === 'manual_override') {
    if (
      entry === null ||
      entry.kind !== 'price' ||
      entry.price_local !== value.price_local ||
      entry.currency !== value.currency ||
      published.source !== 'manual'
    ) {
      return 'a manual_override that is not the founder override';
    }
    if (daysBetween(entry.verified_at, world.now.slice(0, 10)) > 90) {
      return 'a manual entry older than 90 days was published';
    }
    // After a flag that shows a value the override waits for its own
    // approval; after a disappearance it fills the gap (D-028 Q1, Q2).
    const approved =
      (!(flagged(previous) && previous!.price_local !== null) &&
        withinBaseline(previous, value, world.threshold)) ||
      lastDecisionApproves(list, value, 'manual');
    return approved ? null : 'an unapproved manual_override was published';
  }

  // `ok`: the scraper's value, observed now or kept from a failed page.
  if (published.source === 'manual') {
    return 'an ok record from a manual source';
  }
  const observed =
    run !== null && !('reason' in run)
      ? run
      : run === null ||
          run.reason === 'parse_failed' ||
          run.reason === 'market_failed'
        ? previous
        : undefined;
  if (
    observed === undefined ||
    observed.price_local !== value.price_local ||
    observed.currency !== value.currency
  ) {
    return 'an ok value that the scraper did not show';
  }
  if (daysBetween(published.observed_at!, world.now) > 45) {
    return 'a scraped value older than 45 days was published';
  }
  const approved = lastDecisionApproves(list, value, published.source);
  const agrees =
    entry !== null &&
    entry.kind === 'price' &&
    entry.price_local === value.price_local &&
    entry.currency === value.currency;
  if (entry !== null && !agrees && !approved) {
    return 'a conflict with a manual entry was published without approval';
  }
  if (agrees) {
    return (!flagged(previous) &&
      withinBaseline(previous, value, world.threshold)) ||
      approved
      ? null
      : 'an agreed value beyond the threshold was published without approval';
  }
  if (flagged(previous) && !approved) {
    return 'a value after a flag was published without approval';
  }
  if (!withinBaseline(previous, value, world.threshold) && !approved) {
    return 'a change beyond the threshold was published without approval';
  }
  return null;
}

test('seeded property: only ok and approved manual_override records pass the gate, the view and the ranking', () => {
  const statusesSeen = new Set<string>();
  const publishedStatusesSeen = new Set<string>();

  fc.assert(
    fc.property(world, (generated) => {
      const latest = mergePriceIndex(inputOf(generated));
      assert.ok(latestFileSchema.safeParse(latest).success);
      assert.equal(latest.records.length, identities.length);

      const cases = new Map(
        generated.cases.map((entry) => [recordIdentity(entry.identity), entry]),
      );
      for (const result of latest.records) {
        statusesSeen.add(result.status);
        if (!isPublishable(result)) {
          continue;
        }
        publishedStatusesSeen.add(result.status);
        const refusal = oracleRefusal(
          result,
          cases.get(recordIdentity(result))!,
          generated,
        );
        assert.equal(refusal, null, `${recordIdentity(result)}: ${refusal}`);
      }

      const publishable = latest.records.filter(isPublishable);
      assert.deepEqual(
        publishedView(latest).records.map(recordIdentity),
        publishable.map(recordIdentity),
      );

      for (const plan of plans) {
        const ranked = rankMarkets(latest, plan);
        const expected = publishable.filter(
          (entry) =>
            entry.service_id === plan.service_id &&
            entry.plan_id === plan.plan_id &&
            entry.price_usd_source !== null,
        );
        assert.deepEqual(
          ranked.map(({ market }) => market).sort(),
          expected.map(({ market }) => market).sort(),
        );
        for (const { rank, market } of ranked) {
          const own = cents(
            expected.find((entry) => entry.market === market)!
              .price_usd_source!,
          );
          const above = expected.filter(
            (entry) => cents(entry.price_usd_source!) > own,
          ).length;
          assert.equal(rank, above + 1);
        }
      }
    }),
    { seed: 20_261_118, numRuns: 400 },
  );

  // The generated merges reached every status, so the gate was tested
  // against each of them, and published both kinds of record.
  assert.deepEqual([...statusesSeen].sort(), [
    'conflict',
    'manual_override',
    'missing',
    'needs_review',
    'not_offered',
    'ok',
    'stale',
  ]);
  assert.deepEqual([...publishedStatusesSeen].sort(), [
    'manual_override',
    'ok',
  ]);
});
