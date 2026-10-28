import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  bannerShapes,
  catalogueShape,
  composeBanner,
} from '../src/components/provider-banner.ts';
import { resolveLandingHero } from '../src/content/landing-hero.ts';
import type { Provider } from '../src/content/provider-showcase.ts';

// E11.5-11d: the one banner function the catalogue and the hero share.

const providers = JSON.parse(
  await readFile('src/content/provider-showcase.json', 'utf8'),
) as Provider[];
const byName = (name: string) =>
  providers.find((provider) => provider.name === name) as Provider;

test('the catalogue cycles the six tonal shapes in order', () => {
  assert.deepEqual(bannerShapes, ['t1', 't2', 't3', 't4', 't5', 't6']);
  assert.deepEqual(
    Array.from({ length: 14 }, (_, index) => catalogueShape(index)),
    [
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
      't1',
      't2',
    ],
  );
});

test('a composed banner carries its data colours, chip tone and logo size', () => {
  const sizes = new Map([
    ['/images/providers/cyberghost.svg', { width: 149, height: 34 }],
  ]);
  const cyberghost = composeBanner(
    byName('CyberGhost'),
    't4',
    (logo) => sizes.get(logo) ?? null,
  );
  assert.deepEqual(
    {
      shape: cyberghost.shape,
      tone: cyberghost.tone,
      foreground: cyberghost.foreground,
      chipTone: cyberghost.chipTone,
      size: [cyberghost.logoWidth, cyberghost.logoHeight],
    },
    {
      shape: 't4',
      tone: 'ink',
      foreground: 'ink',
      chipTone: 'dark',
      size: [149, 34],
    },
  );
  const netflix = composeBanner(byName('Netflix'), 't2', () => null);
  assert.equal(netflix.chipTone, 'light');
  assert.equal(netflix.tone, 'light');
  assert.equal(netflix.foreground, 'white');
  // A logo without a declared size (the square AION2 raster) is a square.
  assert.deepEqual([netflix.logoWidth, netflix.logoHeight], [1, 1]);
});

test('the hero composes its banners with the same function', () => {
  const hero = resolveLandingHero(
    {
      stack: ['ChatGPT', 'Microsoft 365', 'CyberGhost'],
      strip: ['ChatGPT', 'CyberGhost', 'Microsoft 365'],
    },
    providers,
    () => null,
  );
  assert.deepEqual(
    hero.stack[2],
    composeBanner(byName('CyberGhost'), 't2', () => null),
  );
  assert.equal(hero.strip[1].chipTone, 'dark');
});
