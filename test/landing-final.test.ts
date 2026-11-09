import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  finalShapes,
  resolveLandingFinal,
  validateLandingFinal,
} from '../src/content/landing-final.ts';
import { validateProviderShowcase } from '../src/content/provider-showcase.ts';

// E11.5-11p: the final call to action's three logo-only banners come from
// the showcase file, named in src/content/landing-final.json.
const executeFile = promisify(execFile);
const finalList: unknown = JSON.parse(
  await readFile('src/content/landing-final.json', 'utf8'),
);
const providers = await validateProviderShowcase(
  JSON.parse(await readFile('src/content/provider-showcase.json', 'utf8')),
);

test('the final list names the canvas trio, left to right, with the canvas compositions', () => {
  assert.deepEqual(validateLandingFinal(finalList, providers), {
    banners: ['ChatGPT', 'Netflix', 'Microsoft 365'],
  });
  assert.deepEqual(finalShapes, ['t5', 't2', 't1']);
});

test('a provider outside the showcase, a short, long or repeated list, or a malformed file fails', () => {
  for (const [input, message] of [
    [
      { banners: ['ChatGPT', 'Netflix', 'Disney+'] },
      /not in the showcase: Disney\+/u,
    ],
    [{ banners: ['ChatGPT', 'Netflix'] }, /must list 3 providers/u],
    [
      { banners: ['ChatGPT', 'Netflix', 'Microsoft 365', 'Xbox'] },
      /must list 3 providers/u,
    ],
    [{ banners: ['ChatGPT', 'Netflix', ' '] }, /must list 3 providers/u],
    [{ banners: ['ChatGPT', 'ChatGPT', 'Netflix'] }, /repeat a provider/u],
    [{ banners: 'ChatGPT' }, /must list 3 providers/u],
    [['ChatGPT', 'Netflix', 'Microsoft 365'], /must be an object/u],
    [null, /must be an object/u],
  ] as const) {
    assert.throws(() => validateLandingFinal(input, providers), message);
  }
});

test('each resolved banner takes its showcase entry, its composition, its computed colours and its logo size', () => {
  const sizes = new Map([
    ['/images/providers/chatgpt.svg', { width: 320, height: 320 }],
    ['/images/providers/netflix.svg', { width: 111, height: 30 }],
  ]);
  const banners = resolveLandingFinal(
    finalList,
    providers,
    (logo) => sizes.get(logo) ?? null,
  );
  assert.deepEqual(
    banners.map(
      ({ provider, shape, tone, foreground, wordmarkHeight, logoWidth }) => [
        provider.name,
        shape,
        tone,
        foreground,
        wordmarkHeight,
        logoWidth,
      ],
    ),
    [
      ['ChatGPT', 't5', 'dark', 'white', null, 320],
      ['Netflix', 't2', 'light', 'white', 18, 111],
      // No declared size: drawn in a square.
      ['Microsoft 365', 't1', 'light', 'white', null, 1],
    ],
  );
  for (const banner of banners)
    assert.equal(
      banner.provider,
      providers.find((entry) => entry.name === banner.provider.name),
    );
});

test('the prebuild check fails the build on a final banner the showcase lacks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-landing-final-'));
  try {
    await cp('src', join(root, 'src'), { recursive: true });
    await cp('public/images/providers', join(root, 'public/images/providers'), {
      recursive: true,
    });
    const check = join(process.cwd(), 'scripts/ci/provider-showcase-check.ts');
    const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
    await executeFile(tsx, [check], { cwd: root });
    await writeFile(
      join(root, 'src/content/landing-final.json'),
      JSON.stringify({ banners: ['ChatGPT', 'Netflix', 'Microsoft 366'] }),
    );
    await assert.rejects(
      executeFile(tsx, [check], { cwd: root }),
      /not in the showcase: Microsoft 366/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
