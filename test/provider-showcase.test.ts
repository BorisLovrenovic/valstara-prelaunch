import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateProviderShowcase } from '../src/content/provider-showcase.ts';

const entries: unknown = JSON.parse(
  await readFile('src/content/provider-showcase.json', 'utf8'),
);
const valid = entries as Record<string, unknown>[];
const clone = () => structuredClone(valid);

test('P8 showcase validates all 34 confirmed providers and same-origin assets', async () => {
  const providers = await validateProviderShowcase(entries);
  assert.equal(providers.length, 34);
  assert.equal(new Set(providers.map((provider) => provider.name)).size, 34);
  assert.deepEqual(
    [...new Set(providers.map((provider) => provider.category))],
    ['ai', 'subscriptions', 'software', 'in_game_currency'],
  );
  assert.ok(
    providers.every((provider) =>
      provider.logo.startsWith('/images/providers/'),
    ),
  );
  assert.equal(
    providers
      .filter((provider) => provider.logo.endsWith('.webp'))
      .map((provider) => provider.name)
      .join(),
    'AION2',
  );
});

test('missing fields, confirmation, category and off-origin paths fail', async () => {
  for (const [key, replacement] of [
    ['name', undefined],
    ['brandColor', undefined],
    ['confirmation', undefined],
    ['source', undefined],
    ['category', 'apparel'],
    ['logo', 'https://example.com/logo.svg'],
    ['logo', '/images/providers/absent.svg'],
  ] as const) {
    const fixture = clone();
    if (replacement === undefined) delete fixture[0][key];
    else fixture[0][key] = replacement;
    await assert.rejects(validateProviderShowcase(fixture), Error, key);
  }
});

test('oversized and dimensionless logos fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'valstara-showcase-'));
  const fixture = clone();
  fixture[0].logo = '/images/providers/fixture.svg';
  try {
    await writeFile(
      join(directory, 'fixture.svg'),
      `<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg">${' '.repeat(12289)}</svg>`,
    );
    await assert.rejects(
      validateProviderShowcase(fixture, directory),
      /Oversized logo/u,
    );
    await writeFile(
      join(directory, 'fixture.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    await assert.rejects(
      validateProviderShowcase(fixture, directory),
      /intrinsic dimensions/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('logo source URLs require HTTPS', async () => {
  const fixture = clone();
  fixture[0].source = { kind: 'url', url: 'https://example.com/brand.svg' };
  await validateProviderShowcase(fixture);
  fixture[0].source = { kind: 'url', url: 'http://example.com/brand.svg' };
  await assert.rejects(
    validateProviderShowcase(fixture),
    /Invalid source URL/u,
  );
});

test('banners contain no price, discount, count or date markup', async () => {
  const banner = await readFile('src/components/provider-banner.astro', 'utf8');
  assert.doesNotMatch(banner, /price|discount|count|date|availability|stock/iu);
  assert.match(banner, /provider-banner__tone/u);
  assert.match(banner, /provider-banner__logo/u);
  assert.match(banner, /alt=\{provider\.name\}/u);
  const rail = await readFile('src/components/provider-rail.astro', 'utf8');
  assert.match(rail, /scroll-snap-type: x mandatory/u);
  assert.doesNotMatch(rail, /<script|setInterval|autoplay/iu);
});

test('chipTone accepts only "dark", and only CyberGhost carries it', async () => {
  // E11.5-11d: a white-only logo gets the dark chip, marked in the data file.
  assert.deepEqual(
    valid
      .filter((entry) => 'chipTone' in entry)
      .map((entry) => [entry.name, entry.chipTone]),
    [['CyberGhost', 'dark']],
  );
  const fixture = clone();
  fixture[0].chipTone = 'dark';
  await validateProviderShowcase(fixture);
  for (const tone of ['light', 'Dark', '', 1, null]) {
    fixture[0].chipTone = tone;
    await assert.rejects(
      validateProviderShowcase(fixture),
      /Invalid chip tone: ChatGPT/u,
      String(tone),
    );
  }
});

test('wordmarkHeight is a positive whole pixel count on exactly the 18 founder-listed wordmarks', async () => {
  // Founder decision 2026-11-08 (E11.5-11n): the canvas's optical heights.
  assert.deepEqual(
    Object.fromEntries(
      valid
        .filter((entry) => 'wordmarkHeight' in entry)
        .map((entry) => [entry.name, entry.wordmarkHeight]),
    ),
    {
      Perplexity: 22,
      Cursor: 18,
      'Bolt.new': 18,
      Lovable: 16,
      n8n: 30,
      Spotify: 34,
      'YouTube Premium': 18,
      'Prime Video': 24,
      Netflix: 18,
      'Apple TV': 20,
      LinkedIn: 18,
      MyFitnessPal: 15,
      Canva: 24,
      Dropbox: 17,
      NordVPN: 22,
      Norton: 20,
      Kaspersky: 17,
      CyberGhost: 20,
    },
  );
  const fixture = clone();
  fixture[0].wordmarkHeight = 1;
  await validateProviderShowcase(fixture);
  for (const height of [0, -4, 18.5, '18', '18px', null, Number.NaN]) {
    fixture[0].wordmarkHeight = height;
    await assert.rejects(
      validateProviderShowcase(fixture),
      /Invalid wordmark height: ChatGPT/u,
      String(height),
    );
  }
});
