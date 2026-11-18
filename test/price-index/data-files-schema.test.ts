import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../../packages/price-index/src/cli/validate.ts';
import {
  approvalsFileSchema,
  manualOverridesFileSchema,
  mergeSettingsSchema,
  priceIndexSettingsFileSchema,
} from '../../packages/price-index/src/schema/index.ts';
import {
  decision,
  notOffered,
  priceOverride,
} from '../helpers/price-index-merge.ts';

// E11.6-06: data/price-index/manual-overrides.json and approvals.json, their
// schemas, and the merge's keys in config/price-index.json. An override
// needs a local price and currency, its USD figure is optional, and a
// `not_offered` entry needs the official URL that shows it. A decision needs
// an actor and binds to one value.

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

/** A copy of `entry` without `key`. */
function without(entry: object, key: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([name]) => name !== key),
  );
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(projectRoot, path), 'utf8'));
}

test('the committed manual-overrides.json and approvals.json are valid and empty', async () => {
  assert.deepEqual(
    manualOverridesFileSchema.parse(
      await json('data/price-index/manual-overrides.json'),
    ),
    { overrides: [] },
  );
  assert.deepEqual(
    approvalsFileSchema.parse(await json('data/price-index/approvals.json')),
    { approvals: [] },
  );
});

test('the committed settings hold the merge defaults: 40%, 45 days and 90 days', async () => {
  const file = priceIndexSettingsFileSchema.parse(
    await json('config/price-index.json'),
  );
  assert.deepEqual(file.merge, {
    change_threshold_percent: 40,
    stale_after_days: { scraped: 45, manual: 90 },
  });
});

function overrides(entries: unknown[]) {
  return manualOverridesFileSchema.safeParse({ overrides: entries });
}

test('the overrides schema accepts a price override with or without a USD figure, and a not_offered entry', () => {
  assert.equal(
    overrides([
      priceOverride({ price_usd_source: null }),
      priceOverride({
        market: 'US',
        price_local: '11.99',
        currency: 'USD',
        price_usd_source: '11.99',
      }),
      notOffered({ market: 'DE' }),
    ]).success,
    true,
  );
});

const rejectedOverrides: [string, unknown][] = [
  [
    'a price override without a local price',
    without(priceOverride(), 'price_local'),
  ],
  ['a price override without a currency', without(priceOverride(), 'currency')],
  ['a price written as a number', { ...priceOverride(), price_local: 149 }],
  [
    'a price not at the currency exponent',
    priceOverride({ price_local: '149' }),
  ],
  ['a price of zero', priceOverride({ price_local: '0.00' })],
  ['an unknown currency', priceOverride({ currency: 'XYZ' })],
  [
    'a USD figure with three decimals',
    priceOverride({ price_usd_source: '15.790' }),
  ],
  ['a USD figure of zero', priceOverride({ price_usd_source: '0.00' })],
  [
    'a not_offered entry without its official URL',
    without(notOffered(), 'source_url'),
  ],
  [
    'a not_offered entry with a price',
    { ...notOffered(), price_local: '149.00', currency: 'SEK' },
  ],
  [
    'a source URL that is not https',
    priceOverride({ source_url: 'http://www.spotify.com/' }),
  ],
  ['an empty verified_by', priceOverride({ verified_by: '' })],
  [
    'a verified_at that is not a date',
    priceOverride({ verified_at: '2026-13-01' }),
  ],
  ['an fx field', { ...priceOverride(), fx: '1.0' }],
  ['an unknown kind', { ...priceOverride(), kind: 'estimate' }],
  [
    'an unknown billing period',
    priceOverride({ billing_period: 'week' as 'month' }),
  ],
];

for (const [name, entry] of rejectedOverrides) {
  test(`the overrides schema rejects ${name}`, () => {
    assert.equal(overrides([entry]).success, false);
  });
}

test('the overrides schema rejects two entries for one record', () => {
  assert.equal(overrides([priceOverride(), notOffered()]).success, false);
});

test('the approvals schema accepts a decision on a value and on a disappearance', () => {
  assert.equal(
    approvalsFileSchema.safeParse({
      approvals: [
        decision(),
        decision({ decision: 'reject', price_local: null, currency: null }),
        decision({ source: 'manual' }),
      ],
    }).success,
    true,
  );
});

const rejectedDecisions: [string, unknown][] = [
  ['a decision without an actor', without(decision(), 'actor')],
  ['an empty actor', decision({ actor: ' ' })],
  ['an unknown decision', { ...decision(), decision: 'defer' }],
  ['a price without its currency', decision({ currency: null })],
  ['a currency without a price', decision({ price_local: null })],
  ['a price not at the currency exponent', decision({ price_local: '149' })],
  [
    'a source the record cannot have',
    decision({ source: 'scraper:example.com' }),
  ],
  ['a decided_at that is not a time', decision({ decided_at: '2026-12-01' })],
  ['an unknown key', { ...decision(), note: 'ok' }],
];

for (const [name, entry] of rejectedDecisions) {
  test(`the approvals schema rejects ${name}`, () => {
    assert.equal(
      approvalsFileSchema.safeParse({ approvals: [entry] }).success,
      false,
    );
  });
}

const rejectedSettings: [string, unknown][] = [
  [
    'a zero threshold',
    {
      change_threshold_percent: 0,
      stale_after_days: { scraped: 45, manual: 90 },
    },
  ],
  [
    'a fractional threshold',
    {
      change_threshold_percent: 40.5,
      stale_after_days: { scraped: 45, manual: 90 },
    },
  ],
  [
    'a zero staleness limit',
    {
      change_threshold_percent: 40,
      stale_after_days: { scraped: 0, manual: 90 },
    },
  ],
  [
    'a staleness limit written as text',
    {
      change_threshold_percent: 40,
      stale_after_days: { scraped: 45, manual: '90' },
    },
  ],
  [
    'a missing staleness limit',
    { change_threshold_percent: 40, stale_after_days: { scraped: 45 } },
  ],
  [
    'an unknown key',
    {
      change_threshold_percent: 40,
      stale_after_days: { scraped: 45, manual: 90 },
      auto_approve: true,
    },
  ],
];

for (const [name, settings] of rejectedSettings) {
  test(`the merge settings reject ${name}`, () => {
    assert.equal(mergeSettingsSchema.safeParse(settings).success, false);
  });
}

test('validate reports an invalid merge setting with its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-price-merge-settings-'));
  try {
    await cp(join(projectRoot, 'config'), join(root, 'config'), {
      recursive: true,
    });
    assert.deepEqual(await validateConfig(root), []);
    const settings = (await json('config/price-index.json')) as Record<
      string,
      Record<string, unknown>
    >;
    settings.merge!.change_threshold_percent = 0;
    await writeFile(
      join(root, 'config/price-index.json'),
      JSON.stringify(settings),
    );
    const issues = await validateConfig(root);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.file, 'config/price-index.json');
    assert.equal(issues[0]!.path, 'merge.change_threshold_percent');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
