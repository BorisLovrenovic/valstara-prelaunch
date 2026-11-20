import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { inputDigest } from '../../scripts/ci/app-build.mjs';

// E11.6-10: the site built over the price-page fixture dataset
// (test/fixtures/price-index/pages/). The rendered price-page tests assert
// pages of a known dataset, so they build a copy of the site's build inputs
// with the fixture catalogue, markets, latest.json, ledger, change log,
// monthly reports and Valstara prices in place of the real ones, and serve
// that. The copy takes nothing from the repository's data/price-index/: from
// the founder's first monthly run on (E11.6-15) it holds real data, and a
// real file the fixtures do not replace (a monthly report, say) would leak
// into the fixture site. The real data files are never touched.
//
// The build is keyed by the repository's build inputs and the fixture files,
// so the test files that need it share one build in a run. Exports only:
// node --test runs every file under test/, helpers included.

const executeFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
export const priceFixtureDirectory = join(
  projectRoot,
  'test/fixtures/price-index/pages',
);

// Everything `npm run build` reads (scripts/ci/app-build.mjs inputPaths),
// except the price data, which priceFixtureFiles supplies in full.
const buildInputs = [
  'src',
  'public',
  'astro.config.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'scripts/ci/seo-build-check.ts',
  'scripts/ci/provider-showcase-check.ts',
  'config',
  'packages/price-index/src/publish',
  'packages/price-index/src/schema',
];

/** The fixture files, and where each goes in the copy. */
export const priceFixtureFiles = {
  'catalogue.json': 'config/catalogue.json',
  'markets.json': 'config/markets.json',
  'latest.json': 'data/price-index/latest.json',
  'published-urls.json': 'data/price-index/published-urls.json',
  // E11.6-11: the price history and the Valstara prices.
  'changes.json': 'data/price-index/changes.json',
  'valstara-prices.json': 'config/valstara-prices.json',
  // E11.6-13: two monthly reports; 2026-11 has none, so it has no page.
  'monthly/2026-09.json': 'data/price-index/monthly/2026-09.json',
  'monthly/2026-10.json': 'data/price-index/monthly/2026-10.json',
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The fixture dataset's files, parsed, as `createPriceSite` takes them. */
export async function priceFixtureInputs() {
  const read = async (name) =>
    JSON.parse(await readFile(join(priceFixtureDirectory, name), 'utf8'));
  return {
    latest: await read('latest.json'),
    catalogue: await read('catalogue.json'),
    markets: await read('markets.json'),
    ledger: await read('published-urls.json'),
    changes: await read('changes.json'),
    valstaraPrices: await read('valstara-prices.json'),
    monthly: {
      '2026-09.json': await read('monthly/2026-09.json'),
      '2026-10.json': await read('monthly/2026-10.json'),
    },
  };
}

/**
 * The root of a built copy of the site over the fixture dataset. Built once
 * per distinct set of inputs; a later call with the same inputs reuses it.
 */
export async function priceFixtureSite() {
  // This module's own source is part of the key: a change to what the copy
  // takes from the repository must rebuild, never reuse an older tree.
  const hash = createHash('sha256')
    .update(await inputDigest(projectRoot, process.env))
    .update(await readFile(fileURLToPath(import.meta.url)));
  for (const name of Object.keys(priceFixtureFiles).sort()) {
    hash
      .update(`${name}\0`)
      .update(await readFile(join(priceFixtureDirectory, name)));
  }
  const root = join(
    tmpdir(),
    `valstara-price-fixture-${hash.digest('hex').slice(0, 16)}`,
  );
  const marker = join(root, '.price-fixture-built');
  if (await exists(marker)) return { root };

  await rm(root, { recursive: true, force: true });
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...buildInputs,
    ],
    { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    if (!(await exists(join(projectRoot, file)))) continue;
    await mkdir(dirname(join(root, file)), { recursive: true });
    await copyFile(join(projectRoot, file), join(root, file));
  }
  for (const [name, target] of Object.entries(priceFixtureFiles)) {
    await mkdir(dirname(join(root, target)), { recursive: true });
    await copyFile(join(priceFixtureDirectory, name), join(root, target));
  }
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
  try {
    await executeFile('npm', ['run', 'build'], {
      cwd: root,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const failed = /** @type {{ stdout?: string; stderr?: string }} */ (error);
    throw new Error(
      `The price fixture site did not build:\n${failed.stdout ?? ''}\n${failed.stderr ?? ''}`,
      { cause: error },
    );
  }
  await writeFile(marker, 'built\n');
  return { root };
}
