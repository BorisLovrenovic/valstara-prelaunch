import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateConfig } from '../../packages/price-index/src/cli/validate.ts';
import { readFetcherSettings } from '../../packages/price-index/src/http/settings.ts';
import {
  fetcherSettingsSchema,
  priceIndexSettingsFileSchema,
} from '../../packages/price-index/src/schema/price-index-settings.ts';
import { fetcherSettings } from '../helpers/price-index-fetcher.ts';

// E11.6-04: config/price-index.json holds the fetcher's keys only, and
// `validate` (so `npm run check`) rejects an invalid one.

const projectRoot = new URL('../..', import.meta.url).pathname;

test('the committed config/price-index.json holds exactly the fetcher defaults', async () => {
  const file = JSON.parse(
    await readFile(join(projectRoot, 'config/price-index.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(file), ['fetcher']);
  assert.deepEqual(
    priceIndexSettingsFileSchema.parse(file).fetcher,
    fetcherSettings(),
  );
  assert.deepEqual(await readFetcherSettings(projectRoot), fetcherSettings());
  assert.equal(JSON.stringify(file).includes('PriceIndexBot'), false);
});

const rejected: [string, (settings: Record<string, unknown>) => void][] = [
  ['another source host', (s) => (s.source_origin = 'https://example.com')],
  ['the apex host', (s) => (s.source_origin = 'https://youfundceo.com')],
  ['plain http', (s) => (s.source_origin = 'http://www.youfundceo.com')],
  [
    'a jitter min above its max',
    (s) => (s.jitter_seconds = { min: 21, max: 20 }),
  ],
  ['a zero jitter floor', (s) => (s.jitter_seconds = { min: 0, max: 20 })],
  ['a fractional delay', (s) => (s.jitter_seconds = { min: 8.5, max: 20 })],
  ['a delay written as text', (s) => (s.page_timeout_seconds = '60')],
  ['a zero checkpoint wait', (s) => (s.checkpoint_wait_seconds = 0)],
  ['no failure limit', (s) => (s.max_consecutive_failures = 0)],
  ['no runs kept', (s) => (s.raw_runs_kept = 0)],
  [
    'a backoff shorter than the jitter floor',
    (s) => ((s.backoff as Record<string, number>).initial_seconds = 5),
  ],
  [
    'a backoff cap below its start',
    (s) => ((s.backoff as Record<string, number>).max_seconds = 30),
  ],
  [
    'a shrinking backoff',
    (s) => ((s.backoff as Record<string, number>).multiplier = 0),
  ],
  ['an unknown key', (s) => (s.user_agent = 'PriceIndexBot/1.0')],
  ['a missing key', (s) => delete s.raw_runs_kept],
];

for (const [name, change] of rejected) {
  test(`the settings schema rejects ${name}`, () => {
    const settings = structuredClone(fetcherSettings()) as unknown as Record<
      string,
      unknown
    >;
    change(settings);
    assert.equal(fetcherSettingsSchema.safeParse(settings).success, false);
  });
}

test('validate reports an invalid or missing config/price-index.json with its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-price-index-settings-'));
  try {
    await cp(join(projectRoot, 'config'), join(root, 'config'), {
      recursive: true,
    });
    assert.deepEqual(await validateConfig(root), []);

    const settings = {
      fetcher: { ...fetcherSettings(), source_origin: 'https://example.com' },
    };
    await writeFile(
      join(root, 'config/price-index.json'),
      JSON.stringify(settings),
    );
    const issues = await validateConfig(root);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.file, 'config/price-index.json');
    assert.equal(issues[0]!.path, 'fetcher.source_origin');

    await rm(join(root, 'config/price-index.json'));
    assert.deepEqual(await validateConfig(root), [
      { file: 'config/price-index.json', path: '', message: 'file not found' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
