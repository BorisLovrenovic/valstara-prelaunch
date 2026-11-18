import assert from 'node:assert/strict';
import test from 'node:test';

import {
  latestFileSchema,
  missingReasons,
  priceRecordKeys,
  priceRecordSchema,
  priceStatuses,
  snapshotFileSchema,
} from '../../packages/price-index/src/schema/index.ts';

// E11.6-03: the price record (docs/features/price-index.md#the-price-record)
// and the latest.json and snapshot files. A price is an exact decimal string
// at its currency's exponent, and the record has no fx or converted field.

type Json = Record<string, unknown>;

function record(overrides: Json = {}): Json {
  return {
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    price_local: '149.00',
    price_source_text: 'kr\u00a0149',
    currency: 'SEK',
    price_usd_source: '15.79',
    source: 'scraper:youfundceo.com',
    source_url: 'https://www.youfundceo.com/services/spotify/sweden',
    observed_at: '2026-11-17T14:02:11Z',
    source_verified_at: '2026-11-04',
    status: 'ok',
    missing_reason: null,
    notes: null,
    ...overrides,
  };
}

const missingRecord = (overrides: Json = {}) =>
  record({
    price_local: null,
    price_source_text: null,
    currency: null,
    price_usd_source: null,
    source_url: null,
    source_verified_at: null,
    status: 'missing',
    missing_reason: 'not_on_source',
    ...overrides,
  });

function accepts(value: Json, label: string): void {
  const result = priceRecordSchema.safeParse(value);
  assert.ok(
    result.success,
    `${label}: ${JSON.stringify(result.error?.issues)}`,
  );
}

function rejects(value: Json, label: string, path?: string): void {
  const result = priceRecordSchema.safeParse(value);
  assert.equal(result.success, false, `${label} should be rejected`);
  if (path !== undefined) {
    assert.ok(
      result.error.issues.some(
        (issue) =>
          issue.path.join('.') === path ||
          (issue.code === 'unrecognized_keys' && issue.keys.includes(path)),
      ),
      `${label}: expected an issue at ${path}, got ${JSON.stringify(result.error.issues)}`,
    );
  }
}

test('the record holds the fields of the spec, in its order', () => {
  assert.deepEqual(priceRecordKeys, [
    'market',
    'service_id',
    'plan_id',
    'billing_period',
    'price_local',
    'price_source_text',
    'currency',
    'price_usd_source',
    'source',
    'source_url',
    'observed_at',
    'source_verified_at',
    'status',
    'missing_reason',
    'notes',
  ]);
  assert.deepEqual(priceStatuses, [
    'ok',
    'missing',
    'not_offered',
    'needs_review',
    'manual_override',
    'stale',
    'conflict',
  ]);
  assert.deepEqual(missingReasons, [
    'source_no_price',
    'not_on_source',
    'parse_failed',
    'market_failed',
  ]);
});

test('valid records are accepted', () => {
  accepts(record(), 'a scraped ok record');
  accepts(
    record({
      source: 'manual',
      status: 'manual_override',
      price_usd_source: null,
      price_source_text: null,
      notes: 'Checked on the provider page',
    }),
    'a manual override without a USD figure',
  );
  accepts(
    record({
      market: 'IS',
      price_local: '1190',
      price_source_text: 'kr\u00a01,190',
      currency: 'ISK',
    }),
    'a zero-decimal currency',
  );
  accepts(
    record({ price_local: '1.250', currency: 'KWD', price_source_text: null }),
    'a three-decimal currency',
  );
  accepts(
    record({ status: 'needs_review', currency: 'EUR', price_local: '80.61' }),
    'a currency other than the market currency, which merge flags',
  );
  accepts(record({ source: 'direct:spotify' }), 'a direct source');
  for (const reason of missingReasons) {
    accepts(missingRecord({ missing_reason: reason }), `missing (${reason})`);
  }
  accepts(
    missingRecord({
      status: 'not_offered',
      missing_reason: null,
      source: 'manual',
      source_url: 'https://help.netflix.com/en/node/24926',
    }),
    'not_offered',
  );
  accepts(
    missingRecord({ status: 'stale', missing_reason: null }),
    'a stale not_offered entry, which has no price',
  );
});

test('the record rejects an fx field or any converted price', () => {
  for (const field of [
    'fx',
    'fx_rate',
    'fx_date',
    'price_eur',
    'price_usd',
    'price_converted',
    'converted_price',
    'price_local_eur',
  ]) {
    rejects(
      record({ [field]: field === 'fx' ? { rate: '0.0947' } : '14.11' }),
      `a record with ${field}`,
      field,
    );
  }
});

test('a price is an exact decimal string at the currency exponent, never a number', () => {
  rejects(record({ price_local: 149 }), 'a number price', 'price_local');
  rejects(record({ price_local: 149.0 }), 'a float price', 'price_local');
  rejects(
    record({ price_usd_source: 15.79 }),
    'a number USD',
    'price_usd_source',
  );
  for (const value of [
    '149',
    '149.0',
    '149.000',
    '1,49',
    '-149.00',
    '1e2',
    '',
  ]) {
    rejects(
      record({ price_local: value }),
      `price_local ${value}`,
      'price_local',
    );
  }
  rejects(
    record({ price_local: '1190.00', currency: 'ISK' }),
    'ISK with decimals',
    'price_local',
  );
  for (const value of ['15.7', '15', '15.789']) {
    rejects(
      record({ price_usd_source: value }),
      `price_usd_source ${value}`,
      'price_usd_source',
    );
  }
});

test('field rules', () => {
  rejects(record({ market: 'se' }), 'a lower-case market', 'market');
  rejects(
    record({ service_id: 'Spotify' }),
    'a non-kebab service',
    'service_id',
  );
  rejects(
    record({ plan_id: 'premium individual' }),
    'a non-kebab plan',
    'plan_id',
  );
  rejects(
    record({ billing_period: 'week' }),
    'an unknown period',
    'billing_period',
  );
  rejects(record({ currency: 'XXX' }), 'a non-ISO currency', 'currency');
  rejects(record({ status: 'approved' }), 'an unknown status', 'status');
  rejects(
    missingRecord({ missing_reason: 'blocked' }),
    'an unknown missing reason',
    'missing_reason',
  );
  rejects(
    record({ source: 'scraper:example.com' }),
    'another scraper',
    'source',
  );
  rejects(record({ source: 'direct:' }), 'a nameless direct source', 'source');
  rejects(
    record({ source_url: 'http://example.com/' }),
    'an http URL',
    'source_url',
  );
  rejects(
    record({ observed_at: '2026-11-17 14:02' }),
    'a non-RFC 3339 time',
    'observed_at',
  );
  rejects(
    record({ source_verified_at: '4 Nov 2026' }),
    'a non-ISO date',
    'source_verified_at',
  );
  rejects(
    record({ price_source_text: '' }),
    'an empty source text',
    'price_source_text',
  );
  const withoutNotes = record();
  delete withoutNotes.notes;
  rejects(withoutNotes, 'a record missing a key', 'notes');
});

test('the rules that span fields', () => {
  rejects(
    missingRecord({ missing_reason: null }),
    'missing without a reason',
    'missing_reason',
  );
  rejects(
    record({ missing_reason: 'parse_failed' }),
    'a reason on an ok record',
    'missing_reason',
  );
  rejects(
    record({
      price_local: null,
      price_source_text: null,
      price_usd_source: null,
    }),
    'a price without a price_local',
    'currency',
  );
  rejects(record({ currency: null }), 'a price with no currency', 'currency');
  rejects(
    missingRecord({ price_usd_source: '15.79' }),
    'a USD figure with no local price',
    'price_usd_source',
  );
  rejects(
    missingRecord({ price_source_text: 'kr 149' }),
    'source text with no local price',
    'price_source_text',
  );
  rejects(
    missingRecord({ price_local: '149.00', currency: 'SEK' }),
    'a missing record with a price',
    'price_local',
  );
  rejects(
    record({ status: 'not_offered' }),
    'a not_offered record with a price',
    'price_local',
  );
  rejects(
    missingRecord({
      status: 'ok',
      missing_reason: null,
    }),
    'an ok record with no price',
    'price_local',
  );
  rejects(
    missingRecord({
      status: 'manual_override',
      missing_reason: null,
    }),
    'a manual override with no price',
    'price_local',
  );
});

test('latest.json and a snapshot share one shape, with one record per identity', () => {
  const file = {
    built_at: '2026-12-01T09:30:00Z',
    records: [
      record(),
      record({ market: 'NO', currency: 'NOK' }),
      missingRecord({ service_id: 'canva', plan_id: 'pro' }),
    ],
  };
  assert.ok(latestFileSchema.safeParse(file).success);
  assert.ok(snapshotFileSchema.safeParse(file).success);
  assert.ok(
    latestFileSchema.safeParse({ ...file, records: [] }).success,
    'an empty index',
  );

  const duplicate = {
    ...file,
    records: [...file.records, record({ price_local: '159.00' })],
  };
  for (const schema of [latestFileSchema, snapshotFileSchema]) {
    const result = schema.safeParse(duplicate);
    assert.equal(result.success, false);
    assert.match(
      JSON.stringify(result.error?.issues),
      /duplicate record SE\/spotify\/individual\/month/,
    );
    assert.equal(
      schema.safeParse({
        ...file,
        records: [record({ billing_period: 'year' }), record()],
      }).success,
      true,
      'another billing period is another record',
    );
    assert.equal(schema.safeParse({ ...file, fx: {} }).success, false, 'fx');
    assert.equal(
      schema.safeParse({ ...file, built_at: '2026-12-01' }).success,
      false,
      'built_at must be a time',
    );
    assert.equal(
      schema.safeParse({ ...file, records: [record({ fx: '1' })] }).success,
      false,
      'a record with fx',
    );
  }
});
