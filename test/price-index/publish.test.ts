import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isPublishable,
  publishedView,
  PublishGateError,
  rankMarkets,
} from '../../packages/price-index/src/publish/index.ts';
import type {
  LatestFile,
  PriceRecord,
} from '../../packages/price-index/src/schema/index.ts';
import { record } from '../helpers/price-index-merge.ts';

// E11.6-06, epic rule 4: `isPublishable`, `publishedView` and `rankMarkets`
// are the one publish gate. Only `ok` and `manual_override` records pass it;
// a record without a USD figure is published but never ranked, and M counts
// only the ranked markets.

const plan = {
  service_id: 'spotify',
  plan_id: 'individual',
  billing_period: 'month',
} as const;

const unpriced = {
  price_local: null,
  price_source_text: null,
  currency: null,
  price_usd_source: null,
} as const;

function byStatus(): Record<PriceRecord['status'], PriceRecord> {
  return {
    ok: record({ status: 'ok' }),
    manual_override: record({
      status: 'manual_override',
      source: 'manual',
      price_source_text: null,
    }),
    needs_review: record({ status: 'needs_review' }),
    conflict: record({ status: 'conflict' }),
    stale: record({ status: 'stale' }),
    missing: record({
      ...unpriced,
      status: 'missing',
      missing_reason: 'not_on_source',
    }),
    not_offered: record({
      ...unpriced,
      status: 'not_offered',
      source: 'manual',
    }),
  };
}

test('isPublishable passes ok and manual_override, and nothing else', () => {
  const published = Object.entries(byStatus())
    .filter(([, entry]) => isPublishable(entry))
    .map(([status]) => status);
  assert.deepEqual(published, ['ok', 'manual_override']);
});

test('isPublishable refuses a priced status without a price above zero', () => {
  assert.equal(isPublishable(record({ price_local: '0.00' })), false);
  assert.equal(isPublishable(record({ ...unpriced })), false);
});

test('a not_offered entry is never published as a price', () => {
  const latest: LatestFile = {
    built_at: '2026-12-01T09:30:00.000Z',
    records: [byStatus().not_offered],
  };
  assert.equal(isPublishable(latest.records[0]!), false);
  assert.deepEqual(publishedView(latest).records, []);
  assert.deepEqual(rankMarkets(latest, plan), []);
});

test('publishedView holds only publishable records, in file order, without their USD figure', () => {
  const statuses = byStatus();
  const latest: LatestFile = {
    built_at: '2026-12-01T09:30:00.000Z',
    records: [
      {
        ...statuses.ok,
        market: 'DE',
        price_local: '10.99',
        price_source_text: '€10.99',
        currency: 'EUR',
      },
      {
        ...statuses.needs_review,
        market: 'FI',
        price_local: '9.99',
        price_source_text: '€9.99',
        currency: 'EUR',
      },
      { ...statuses.manual_override, market: 'SE' },
      {
        ...statuses.stale,
        market: 'US',
        price_local: '11.99',
        price_source_text: '$11.99',
        currency: 'USD',
      },
    ],
  };
  const view = publishedView(latest);
  assert.equal(view.built_at, '2026-12-01T09:30:00.000Z');
  assert.deepEqual(
    view.records.map((entry) => [entry.market, entry.status]),
    [
      ['DE', 'ok'],
      ['SE', 'manual_override'],
    ],
  );
  for (const entry of view.records) {
    assert.equal('price_usd_source' in entry, false);
    assert.equal(JSON.stringify(entry).includes('13.67'), false);
  }
  assert.deepEqual(view.records[0], {
    market: 'DE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    price_local: '10.99',
    price_source_text: '€10.99',
    currency: 'EUR',
    source: 'scraper:youfundceo.com',
    source_url: 'https://www.youfundceo.com/services/spotify/sweden',
    observed_at: '2026-11-01T09:30:00.000Z',
    source_verified_at: '2026-10-28',
    status: 'ok',
    notes: null,
  });
});

test('an invalid latest.json publishes nothing: the gate throws', () => {
  const invalid = {
    built_at: '2026-12-01T09:30:00.000Z',
    records: [{ ...record(), fx: '1.0' }],
  } as unknown as LatestFile;
  assert.throws(() => publishedView(invalid), PublishGateError);
  assert.throws(() => rankMarkets(invalid, plan), PublishGateError);
  const duplicate: LatestFile = {
    built_at: '2026-12-01T09:30:00.000Z',
    records: [record(), record()],
  };
  assert.throws(() => publishedView(duplicate), PublishGateError);
});

function market(
  code: string,
  usd: string | null,
  overrides: Partial<PriceRecord> = {},
): PriceRecord {
  return record({ market: code, price_usd_source: usd, ...overrides });
}

test('rankMarkets ranks publishable records by their USD figure, most expensive first', () => {
  const latest: LatestFile = {
    built_at: '2026-12-01T09:30:00.000Z',
    records: [
      market('DE', '12.40'),
      market('SE', '15.79'),
      market('US', '11.99'),
      market('CH', '23.40', {
        status: 'manual_override',
        source: 'manual',
        price_source_text: null,
      }),
    ],
  };
  assert.deepEqual(
    rankMarkets(latest, plan).map(({ rank, market: code }) => [rank, code]),
    [
      [1, 'CH'],
      [2, 'SE'],
      [3, 'DE'],
      [4, 'US'],
    ],
  );
  for (const entry of rankMarkets(latest, plan)) {
    assert.equal('price_usd_source' in entry.record, false);
  }
});

test('a record without price_usd_source is publishable but never ranked, and M counts only ranked markets', () => {
  const latest: LatestFile = {
    built_at: '2026-12-01T09:30:00.000Z',
    records: [
      market('DE', '12.40'),
      market('SE', null, {
        status: 'manual_override',
        source: 'manual',
        price_source_text: null,
      }),
      market('US', '11.99'),
    ],
  };
  const sweden = latest.records[1]!;
  assert.equal(isPublishable(sweden), true);
  assert.ok(
    publishedView(latest).records.some((entry) => entry.market === 'SE'),
  );
  const ranked = rankMarkets(latest, plan);
  assert.deepEqual(
    ranked.map(({ market: code }) => code),
    ['DE', 'US'],
  );
  assert.equal(ranked.length, 2);
});

test('rankMarkets leaves out every record the gate refuses, however expensive', () => {
  const latest: LatestFile = {
    built_at: '2026-12-01T09:30:00.000Z',
    records: [
      market('DE', '12.40'),
      market('NO', '99.00', { status: 'needs_review' }),
      market('SE', '98.00', { status: 'conflict' }),
      market('US', '97.00', { status: 'stale' }),
    ],
  };
  assert.deepEqual(
    rankMarkets(latest, plan).map(({ rank, market: code }) => [rank, code]),
    [[1, 'DE']],
  );
});

test('equal USD figures share a rank, listed by market code', () => {
  const latest: LatestFile = {
    built_at: '2026-12-01T09:30:00.000Z',
    records: [
      market('SE', '12.40'),
      market('DE', '12.40'),
      market('US', '11.99'),
      market('CH', '23.40'),
    ],
  };
  assert.deepEqual(
    rankMarkets(latest, plan).map(({ rank, market: code }) => [rank, code]),
    [
      [1, 'CH'],
      [2, 'DE'],
      [2, 'SE'],
      [4, 'US'],
    ],
  );
});

test('rankMarkets ranks one plan only', () => {
  const latest: LatestFile = {
    built_at: '2026-12-01T09:30:00.000Z',
    records: [
      market('DE', '12.40'),
      market('SE', '99.00', { plan_id: 'family' }),
      market('US', '98.00', { service_id: 'netflix' }),
    ],
  };
  assert.deepEqual(
    rankMarkets(latest, plan).map(({ market: code }) => code),
    ['DE'],
  );
});

test('src/publish imports nothing but src/schema, so the site can import it alone', async () => {
  const root = fileURLToPath(
    new URL('../../packages/price-index/src/', import.meta.url),
  );
  const files = await readdir(join(root, 'publish'));
  assert.ok(files.includes('gate.ts'));
  for (const file of files) {
    const source = await readFile(join(root, 'publish', file), 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const target = posix.normalize(posix.join('publish', match[1]!));
      assert.ok(
        target.startsWith('publish/') || target.startsWith('schema/'),
        `${file} imports ${match[1]}`,
      );
    }
  }
});
