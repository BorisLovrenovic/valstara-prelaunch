import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  mergePriceIndex,
  type MergeInput,
} from '../../packages/price-index/src/pipeline/index.ts';
import { publishedView } from '../../packages/price-index/src/publish/index.ts';
import type {
  CatalogueFile,
  LatestFile,
  MarketsFile,
  PriceRecord,
} from '../../packages/price-index/src/schema/index.ts';
import { recordIdentity } from '../../packages/price-index/src/schema/index.ts';
import { createJsonFileStore } from '../../packages/price-index/src/storage/index.ts';
import {
  clockAt,
  observation,
  oneServiceCatalogue,
  priceOverride,
  record,
  run,
  runTime,
  settings,
} from '../helpers/price-index-merge.ts';

// E11.6-06, epic rule 5 and D-028 Q3 (d): latest.json holds exactly one
// record per enabled market × catalogue plan. Adding a service, a plan or a
// market yields `missing` records with no code change; removing one, or
// disabling a market, takes its records out of latest.json and the published
// view, and never touches a snapshot.

function twoServiceCatalogue(): CatalogueFile {
  const catalogue = oneServiceCatalogue();
  catalogue.services.push({
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
    source_aliases: { service: ['Netflix'], plans: {} },
  });
  return catalogue;
}

function twoMarkets(): MarketsFile {
  return {
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
    ],
  };
}

const netflixSweden = observation({
  service_id: 'netflix',
  plan_id: 'standard',
  price_local: '149.00',
  source_url: 'https://www.youfundceo.com/services/netflix/sweden',
});
const spotifyUs = observation({
  market: 'US',
  price_local: '11.99',
  price_source_text: '$11.99 + tax',
  currency: 'USD',
  price_usd_source: '11.99',
  source_url: 'https://www.youfundceo.com/services/spotify/united-states',
});

function input(
  previous: LatestFile | null,
  catalogue: CatalogueFile,
  markets: MarketsFile,
): MergeInput {
  return {
    previous,
    run: run({ observations: [observation(), netflixSweden, spotifyUs] }),
    overrides: { overrides: [] },
    approvals: { approvals: [] },
    catalogue,
    markets,
    settings: settings(),
    clock: clockAt(runTime),
  };
}

function identities(latest: { records: readonly PriceRecord[] }): string[] {
  return latest.records.map(recordIdentity).sort();
}

function publishedIdentities(latest: LatestFile): string[] {
  return publishedView(latest).records.map(recordIdentity).sort();
}

const fullPrevious = mergePriceIndex(
  input(null, twoServiceCatalogue(), twoMarkets()),
);

test('latest.json holds exactly one record per enabled market × catalogue plan', () => {
  assert.deepEqual(identities(fullPrevious), [
    'SE/netflix/standard/month',
    'SE/spotify/individual/month',
    'US/netflix/standard/month',
    'US/spotify/individual/month',
  ]);
  const usNetflix = fullPrevious.records.find(
    (entry) => recordIdentity(entry) === 'US/netflix/standard/month',
  );
  assert.equal(usNetflix?.status, 'missing');
  assert.equal(usNetflix?.missing_reason, 'market_failed');
});

test('removing a service removes its records from latest.json and the published view, and leaves every snapshot byte-identical', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'valstara-price-merge-'));
  try {
    const store = createJsonFileStore({ directory });
    await store.writeLatest(fullPrevious);
    const snapshot = await store.writeSnapshot(fullPrevious, '2026-12-01');
    const snapshotPath = join(directory, 'snapshots', snapshot.name);
    const snapshotBytes = await readFile(snapshotPath);
    assert.ok(
      publishedIdentities(fullPrevious).includes('SE/netflix/standard/month'),
    );

    const previous = await store.readLatest();
    const next = mergePriceIndex(
      input(previous, oneServiceCatalogue(), twoMarkets()),
    );
    await store.writeLatest(next);

    const written = await store.readLatest();
    assert.deepEqual(identities(written!), [
      'SE/spotify/individual/month',
      'US/spotify/individual/month',
    ]);
    assert.equal(
      publishedIdentities(written!).some((id) => id.includes('/netflix/')),
      false,
    );
    assert.deepEqual(await readFile(snapshotPath), snapshotBytes);
    assert.deepEqual(await readdir(join(directory, 'snapshots')), [
      snapshot.name,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('adding a service yields missing records, and no published one', () => {
  const previous = mergePriceIndex(
    input(null, oneServiceCatalogue(), twoMarkets()),
  );
  const catalogue = twoServiceCatalogue();
  const added = mergePriceIndex({
    ...input(previous, catalogue, twoMarkets()),
    run: run({ observations: [observation(), spotifyUs] }),
  });
  const netflix = added.records.filter(
    (entry) => entry.service_id === 'netflix',
  );
  assert.deepEqual(
    netflix.map((entry) => [entry.market, entry.status]),
    [
      ['SE', 'missing'],
      ['US', 'missing'],
    ],
  );
  assert.equal(
    publishedIdentities(added).some((id) => id.includes('/netflix/')),
    false,
  );
});

test('adding and removing a plan is a catalogue change only', () => {
  const withPremium = twoServiceCatalogue();
  withPremium.services[1]!.plans.push({
    plan_id: 'premium',
    name: 'Premium (4K)',
    billing_period: 'month',
    is_student: false,
    is_family: false,
  });
  const added = mergePriceIndex(input(fullPrevious, withPremium, twoMarkets()));
  assert.deepEqual(
    added.records
      .filter((entry) => entry.plan_id === 'premium')
      .map((entry) => [entry.market, entry.status]),
    [
      ['SE', 'missing'],
      ['US', 'missing'],
    ],
  );
  const removed = mergePriceIndex(
    input(added, twoServiceCatalogue(), twoMarkets()),
  );
  assert.equal(
    removed.records.some((entry) => entry.plan_id === 'premium'),
    false,
  );
});

test('adding a market yields missing records, and removing or disabling one takes its records out', () => {
  const markets = twoMarkets();
  markets.markets.push({
    code: 'DE',
    name: 'Germany',
    slug: 'germany',
    currency: 'EUR',
    enabled: true,
  });
  const added = mergePriceIndex(
    input(fullPrevious, twoServiceCatalogue(), markets),
  );
  assert.deepEqual(
    added.records
      .filter((entry) => entry.market === 'DE')
      .map((entry) => entry.status),
    ['missing', 'missing'],
  );

  const disabled = structuredClone(markets);
  disabled.markets.find((market) => market.code === 'US')!.enabled = false;
  const withoutUs = mergePriceIndex(
    input(added, twoServiceCatalogue(), disabled),
  );
  assert.equal(
    withoutUs.records.some((entry) => entry.market === 'US'),
    false,
  );
  assert.equal(
    publishedView(withoutUs).records.some((entry) => entry.market === 'US'),
    false,
  );

  const removed = mergePriceIndex(
    input(added, twoServiceCatalogue(), twoMarkets()),
  );
  assert.equal(
    removed.records.some((entry) => entry.market === 'DE'),
    false,
  );
});

test('a manual entry, observation or decision for a removed plan or disabled market produces no record', () => {
  const markets = twoMarkets();
  markets.markets[1]!.enabled = false;
  const latest = mergePriceIndex({
    ...input(
      { built_at: runTime, records: [record({ service_id: 'tidal' })] },
      oneServiceCatalogue(),
      markets,
    ),
    overrides: {
      overrides: [
        priceOverride({
          market: 'US',
          price_local: '11.99',
          currency: 'USD',
        }),
        priceOverride({ service_id: 'tidal' }),
      ],
    },
  });
  assert.deepEqual(identities(latest), ['SE/spotify/individual/month']);
});
