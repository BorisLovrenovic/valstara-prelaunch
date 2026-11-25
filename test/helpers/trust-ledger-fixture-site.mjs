import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { inputDigest, inputPaths } from '../../scripts/ci/app-build.mjs';

// E11.8-01: the site built with Trust Ledger entries committed. The
// repository commits no entry until December 2026 (D-076 Q2), so the page,
// its links and its sitemap are proven on a copy of the build inputs
// (scripts/ci/app-build.mjs inputPaths) with the test fixtures in
// src/content/trust-ledger/: P11 Part 2 word for word as 2026-12.json, and a
// synthetic 2027-01.json for the ordering and archive. The repository's own
// files are never touched. The build is keyed by the repository's build
// inputs and the fixture files, so the test files that need it share one
// build in a run. Exports only: node --test runs every file under test/,
// helpers included.

const executeFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
export const trustLedgerFixtureDirectory = join(
  projectRoot,
  'test/fixtures/trust-ledger',
);
export const trustLedgerFixtureMonths = ['2027-01', '2026-12'];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The fixture entries, parsed, keyed by file name. */
export async function trustLedgerFixtureEntries() {
  const entries = {};
  for (const month of trustLedgerFixtureMonths) {
    entries[`${month}.json`] = JSON.parse(
      await readFile(
        join(trustLedgerFixtureDirectory, `${month}.json`),
        'utf8',
      ),
    );
  }
  return entries;
}

/**
 * The root of a built copy of the site with the fixture entries committed.
 * Built once per distinct set of inputs; a later call reuses it.
 */
export async function trustLedgerFixtureSite() {
  const hash = createHash('sha256')
    .update(await inputDigest(projectRoot, process.env))
    .update(await readFile(fileURLToPath(import.meta.url)));
  for (const month of trustLedgerFixtureMonths) {
    hash
      .update(`${month}\0`)
      .update(
        await readFile(join(trustLedgerFixtureDirectory, `${month}.json`)),
      );
  }
  const root = join(
    tmpdir(),
    `valstara-trust-ledger-fixture-${hash.digest('hex').slice(0, 16)}`,
  );
  const marker = join(root, '.trust-ledger-fixture-built');
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
      ...inputPaths,
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
  // Exactly the fixture entries, whatever the repository commits.
  const entryDirectory = join(root, 'src/content/trust-ledger');
  await mkdir(entryDirectory, { recursive: true });
  for (const name of await readdir(entryDirectory))
    if (name.endsWith('.json')) await rm(join(entryDirectory, name));
  for (const month of trustLedgerFixtureMonths)
    await copyFile(
      join(trustLedgerFixtureDirectory, `${month}.json`),
      join(entryDirectory, `${month}.json`),
    );
  // The rendered social cards are reused from the repository's cache when it
  // has one, so the copy renders only what changed.
  const cards = join(projectRoot, '.cache/social-cards');
  if (await exists(cards))
    await cp(cards, join(root, '.cache/social-cards'), { recursive: true });
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
      `The Trust Ledger fixture site did not build:\n${failed.stdout ?? ''}\n${failed.stderr ?? ''}`,
      { cause: error },
    );
  }
  await writeFile(marker, 'built\n');
  return { root };
}
