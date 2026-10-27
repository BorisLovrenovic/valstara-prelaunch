import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  bannerForeground,
  bannerTone,
  relativeLuminance,
  resolveLandingHero,
  svgIntrinsicSize,
  validateLandingHero,
} from '../src/content/landing-hero.ts';
import {
  validateProviderShowcase,
  type Provider,
} from '../src/content/provider-showcase.ts';

const executeFile = promisify(execFile);
const heroList: unknown = JSON.parse(
  await readFile('src/content/landing-hero.json', 'utf8'),
);
const providers = await validateProviderShowcase(
  JSON.parse(await readFile('src/content/provider-showcase.json', 'utf8')),
);

test('the hero list names the wireframe trio: the stack back to front, the strip left to right', () => {
  assert.deepEqual(validateLandingHero(heroList, providers), {
    stack: ['ChatGPT', 'Microsoft 365', 'Netflix'],
    strip: ['ChatGPT', 'Netflix', 'Microsoft 365'],
  });
});

test('a hero provider outside the showcase, a short or repeated list, or a strip outside the stack fails', () => {
  const list = { stack: ['ChatGPT', 'Microsoft 365', 'Netflix'] };
  for (const [input, message] of [
    [
      { ...list, strip: ['ChatGPT', 'Netflix', 'Disney+'] },
      /not in the showcase: Disney\+/u,
    ],
    [
      {
        stack: ['ChatGPT', 'Microsoft 365', 'Hulu'],
        strip: ['ChatGPT', 'Netflix', 'Microsoft 365'],
      },
      /not in the showcase: Hulu/u,
    ],
    [{ ...list, strip: ['ChatGPT', 'Netflix'] }, /strip must list 3/u],
    [{ ...list, strip: ['ChatGPT', 'Netflix', 'Netflix'] }, /repeats/u],
    [
      { ...list, strip: ['ChatGPT', 'Netflix', 'Gemini'] },
      /strip must show the stack providers/u,
    ],
    [{ stack: 'ChatGPT', strip: [] }, /stack must list 3/u],
    [[], /must be an object/u],
  ] as const) {
    assert.throws(() => validateLandingHero(input, providers), message);
  }
});

test('the prebuild check fails the build on a hero name the showcase lacks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-landing-hero-'));
  try {
    await cp('src', join(root, 'src'), { recursive: true });
    await cp('public/images/providers', join(root, 'public/images/providers'), {
      recursive: true,
    });
    const check = join(process.cwd(), 'scripts/ci/provider-showcase-check.ts');
    const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
    await executeFile(tsx, [check], { cwd: root });
    await writeFile(
      join(root, 'src/content/landing-hero.json'),
      JSON.stringify({
        stack: ['ChatGPT', 'Microsoft 365', 'Netflix'],
        strip: ['ChatGPT', 'Netflix', 'Microsoft 366'],
      }),
    );
    await assert.rejects(
      executeFile(tsx, [check], { cwd: root }),
      /not in the showcase: Microsoft 366/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('banner colours follow luminance and contrast, as the wireframe computes them', () => {
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(relativeLuminance('#ffffff'), 1);
  // Near-black takes the 13% white layer; white text sits on it.
  assert.equal(bannerTone('#000000'), 'dark');
  assert.equal(bannerForeground('#000000'), 'white');
  // Mid and saturated colours keep white text and take the 16% layer.
  for (const colour of ['#2d3f80', '#d81f26']) {
    assert.equal(bannerTone(colour), 'light', colour);
    assert.equal(bannerForeground(colour), 'white', colour);
  }
  // Light brands take ink text and the 10% ink layer.
  for (const colour of ['#ffcc00', '#3186ff', '#c7daff']) {
    assert.equal(bannerTone(colour), 'ink', colour);
    assert.equal(bannerForeground(colour), 'ink', colour);
  }
  // The near-black boundary sits at a luminance of 0.03.
  assert.ok(relativeLuminance('#303030') < 0.03);
  assert.equal(bannerTone('#303030'), 'dark');
  assert.ok(relativeLuminance('#323232') > 0.03);
  assert.equal(bannerTone('#323232'), 'light');
});

test('an SVG logo reports its declared size; one without a size reports none', () => {
  assert.deepEqual(
    svgIntrinsicSize('<svg width="1024" height="277" viewBox="0 0 1 1">'),
    { width: 1024, height: 277 },
  );
  assert.equal(svgIntrinsicSize('<svg viewBox="0 0 1 1">'), null);
  assert.equal(svgIntrinsicSize('<svg width="0" height="10">'), null);
});

test('the resolved hero gives each provider its stack shape in both views, its data colours and its logo size', () => {
  const sizes = new Map([
    ['/images/providers/chatgpt.svg', { width: 320, height: 320 }],
    ['/images/providers/microsoft-365.svg', { width: 40, height: 44 }],
  ]);
  const hero = resolveLandingHero(
    heroList,
    providers,
    (logo) => sizes.get(logo) ?? null,
  );
  const view = (banners: typeof hero.stack) =>
    banners.map(({ provider, shape, tone, foreground }) => [
      provider.name,
      shape,
      tone,
      foreground,
    ]);
  assert.deepEqual(view(hero.stack), [
    ['ChatGPT', 't3', 'dark', 'white'],
    ['Microsoft 365', 't1', 'light', 'white'],
    ['Netflix', 't2', 'light', 'white'],
  ]);
  assert.deepEqual(view(hero.strip), [
    ['ChatGPT', 't3', 'dark', 'white'],
    ['Netflix', 't2', 'light', 'white'],
    ['Microsoft 365', 't1', 'light', 'white'],
  ]);
  assert.deepEqual(
    hero.stack.map(({ logoWidth, logoHeight }) => [logoWidth, logoHeight]),
    [
      [320, 320],
      [40, 44],
      [1, 1],
    ],
  );
  // The provider object is the showcase entry itself, logo and colour included.
  const chatgpt = providers.find(
    (provider) => provider.name === 'ChatGPT',
  ) as Provider;
  assert.equal(hero.stack[0].provider, chatgpt);
});

test('swapping a hero provider in the list changes the resolved banner', () => {
  const hero = resolveLandingHero(
    {
      stack: ['ChatGPT', 'Microsoft 365', 'CyberGhost'],
      strip: ['ChatGPT', 'CyberGhost', 'Microsoft 365'],
    },
    providers,
    () => null,
  );
  assert.equal(hero.stack[2].provider.name, 'CyberGhost');
  assert.equal(hero.stack[2].shape, 't2');
  assert.equal(hero.stack[2].foreground, 'ink');
  assert.equal(hero.stack[2].tone, 'ink');
});
