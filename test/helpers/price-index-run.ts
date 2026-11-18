import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../../packages/price-index/src/cli/main.ts';
import type { ScrapeEnvironment } from '../../packages/price-index/src/cli/scrape.ts';
import type {
  BrowserDriver,
  LoadResult,
} from '../../packages/price-index/src/http/driver.ts';
import type { Clock } from '../../packages/price-index/src/http/clock.ts';
import { seededRandom } from '../../packages/price-index/src/http/random.ts';
import { pageFileName } from '../../packages/price-index/src/http/raw-store.ts';
import type {
  CatalogueFile,
  LatestFile,
  MarketsFile,
} from '../../packages/price-index/src/schema/index.ts';
import { createJsonFileStore } from '../../packages/price-index/src/storage/index.ts';

// Shared by the E11.6-07 run suites: a workspace that is a small copy of the
// repository's price-index files, a fake browser driver that serves the
// founder's captured pages (no test reaches the source, epic rule 2), and a
// digest of a directory tree for byte-identical assertions. A module of
// exports only, so running it bare (node --test discovers every file under
// test/) does nothing.

export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
export const sourceOrigin = 'https://www.youfundceo.com';
const fixtureRoot = join(
  projectRoot,
  'packages/price-index/test/fixtures/youfundceo',
);
const robotsText = readFileSync(join(fixtureRoot, 'raw/robots.txt'), 'utf8');

/** Every captured service × country pair is for one of these, in SE and US. */
export const capturedServices = [
  'apple-music',
  'chatgpt',
  'netflix',
  'spotify',
  'youtube-premium',
];

export interface FixtureDriver extends BrowserDriver {
  /** Every path loaded, in order. */
  readonly loads: string[];
  /** How many times the run closed its browser. */
  closed: number;
}

/**
 * A browser driver that answers from the captured pages: robots.txt, then
 * each page under its raw-store name, else 404. `status` overrides the
 * answer for a path (a 429, say); `onLoad` sees each path before it loads.
 */
export function fixtureDriver(
  options: {
    status?: (path: string) => number | undefined;
    onLoad?: (path: string) => void;
  } = {},
): FixtureDriver {
  const loads: string[] = [];
  const loaded = (
    url: string,
    status: number,
    content: string,
  ): LoadResult => ({
    kind: 'loaded',
    status,
    finalUrl: url,
    checkpoint: false,
    retryAfter: null,
    content,
    refused: [],
  });
  const driver: FixtureDriver = {
    loads,
    closed: 0,
    async load({ url }) {
      const { pathname, search } = new URL(url);
      const path = `${pathname}${search}`;
      loads.push(path);
      options.onLoad?.(path);
      const status = options.status?.(path);
      if (status !== undefined) {
        return loaded(url, status, '<title>Refused</title>');
      }
      if (path === '/robots.txt') {
        return loaded(url, 200, robotsText);
      }
      try {
        return loaded(
          url,
          200,
          await readFile(join(fixtureRoot, 'pages', pageFileName(url)), 'utf8'),
        );
      } catch {
        return loaded(url, 404, '<title>Not found</title>');
      }
    },
    async close() {
      driver.closed += 1;
    },
  };
  return driver;
}

/** The scrape environment of a test: the fake driver, a clock and a seed. */
export function testEnvironment(
  driver: BrowserDriver,
  clock: Clock,
  signal?: AbortSignal,
): ScrapeEnvironment {
  return {
    origin: sourceOrigin,
    openBrowser: async () => ({
      driver,
      close: () => driver.close(),
    }),
    clock,
    random: seededRandom(7),
    ...(signal === undefined ? {} : { signal }),
  };
}

export interface CliResult {
  status: number;
  out: string;
  err: string;
}

export interface Workspace {
  root: string;
  dataDirectory: string;
  rawRoot: string;
  cli(
    args: readonly string[],
    options?: { clock?: { now(): Date }; environment?: ScrapeEnvironment },
  ): Promise<CliResult>;
  writeLatest(latest: LatestFile, snapshotDate?: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * A temporary copy of the price-index configuration and the seeded data
 * files, with the catalogue cut to `services` and only `markets` enabled.
 */
export async function priceIndexWorkspace(
  options: {
    services?: readonly string[];
    markets?: readonly string[];
  } = {},
): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'valstara-price-run-'));
  await cp(join(projectRoot, 'config'), join(root, 'config'), {
    recursive: true,
  });
  const dataDirectory = join(root, 'data/price-index');
  await mkdir(dataDirectory, { recursive: true });
  for (const name of ['approvals.json', 'manual-overrides.json']) {
    await cp(
      join(projectRoot, 'data/price-index', name),
      join(dataDirectory, name),
    );
  }
  if (options.services !== undefined) {
    const path = join(root, 'config/catalogue.json');
    const catalogue = JSON.parse(await readFile(path, 'utf8')) as CatalogueFile;
    catalogue.services = catalogue.services.filter((service) =>
      options.services!.includes(service.service_id),
    );
    await writeFile(path, `${JSON.stringify(catalogue, null, 2)}\n`);
  }
  if (options.markets !== undefined) {
    const path = join(root, 'config/markets.json');
    const markets = JSON.parse(await readFile(path, 'utf8')) as MarketsFile;
    for (const market of markets.markets) {
      market.enabled = options.markets.includes(market.code);
    }
    await writeFile(path, `${JSON.stringify(markets, null, 2)}\n`);
  }
  return {
    root,
    dataDirectory,
    rawRoot: join(root, 'data/raw'),
    async cli(args, cliOptions = {}) {
      let out = '';
      let err = '';
      const status = await runCli(args, {
        root,
        stdout: (text) => {
          out += text;
        },
        stderr: (text) => {
          err += text;
        },
        ...(cliOptions.clock === undefined ? {} : { clock: cliOptions.clock }),
        ...(cliOptions.environment === undefined
          ? {}
          : { scrape: cliOptions.environment }),
      });
      return { status, out, err };
    },
    async writeLatest(latest, snapshotDate) {
      const store = createJsonFileStore({ directory: dataDirectory });
      await store.writeLatest(latest);
      if (snapshotDate !== undefined) {
        await store.writeSnapshot(latest, snapshotDate);
      }
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** Every file under `directories` (relative to `root`) with its SHA-256. */
export async function treeDigest(
  root: string,
  directories: readonly string[] = ['.'],
): Promise<Record<string, string>> {
  const digest: Record<string, string> = {};
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(join(root, directory), {
        recursive: true,
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        digest[relative(root, path)] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
      }
    }
  }
  return Object.fromEntries(
    Object.entries(digest).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** The files the site reads: the committed data, and the configuration. */
export const siteReadDirectories = ['data/price-index', 'config'];
