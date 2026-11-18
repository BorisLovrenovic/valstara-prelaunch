import assert from 'node:assert/strict';
import { chmod, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { ScrapeEnvironment } from '../../packages/price-index/src/cli/scrape.ts';
import type { BrowserDriver } from '../../packages/price-index/src/http/driver.ts';
import { fakeClock } from '../helpers/price-index-fetcher.ts';
import { record } from '../helpers/price-index-merge.ts';
import {
  capturedServices,
  fixtureDriver,
  priceIndexWorkspace,
  testEnvironment,
  treeDigest,
  type Workspace,
} from '../helpers/price-index-run.ts';

// E11.6-07: `scrape --dry-run` makes no network request. It replays the
// latest raw run, or the founder's captured fixtures with --from-fixtures,
// writes nothing at all, and prints what a build would change. Each case
// runs with a transport that throws on any request and a read-only
// data/price-index/, and checks every file of the workspace byte for byte.

const services = [...capturedServices, 'lovable'];

/** A scrape environment in which any request, or opening a browser, throws. */
function throwingEnvironment(): {
  environment: ScrapeEnvironment;
  attempts: string[];
} {
  const attempts: string[] = [];
  const driver: BrowserDriver = {
    async load({ url }) {
      attempts.push(`load ${url}`);
      throw new Error(`a dry run made a request: ${url}`);
    },
    async close() {
      attempts.push('close');
    },
  };
  return {
    attempts,
    environment: {
      ...testEnvironment(driver, fakeClock('2026-11-20T08:00:00.000Z')),
      openBrowser: async () => {
        attempts.push('open');
        throw new Error('a dry run opened a browser');
      },
    },
  };
}

/** Makes data/price-index/ and everything in it read-only; returns the undo. */
async function readOnlyData(space: Workspace): Promise<() => Promise<void>> {
  const entries = await readdir(space.dataDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const directories = [
    space.dataDirectory,
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(entry.parentPath, entry.name)),
  ];
  for (const file of files) {
    await chmod(file, 0o444);
  }
  for (const directory of directories) {
    await chmod(directory, 0o555);
  }
  return async () => {
    for (const directory of directories) {
      await chmod(directory, 0o755);
    }
    for (const file of files) {
      await chmod(file, 0o644);
    }
  };
}

const earlier = {
  built_at: '2026-10-18T09:00:00.000Z',
  records: [
    record({
      price_local: '129.00',
      price_source_text: 'kr 129',
      observed_at: '2026-10-18T09:00:00.000Z',
    }),
    record({
      service_id: 'netflix',
      plan_id: 'standard',
      price_local: '99.00',
      price_source_text: 'kr 99',
      observed_at: '2026-10-18T09:00:00.000Z',
    }),
  ],
};

test('a dry run replays the latest raw run with no request and no write', async () => {
  const space = await priceIndexWorkspace({
    services,
    markets: ['SE', 'US'],
  });
  let restore = async () => {};
  try {
    await space.writeLatest(earlier, '2026-10-18');
    const scraped = await space.cli(['scrape'], {
      environment: testEnvironment(fixtureDriver(), fakeClock()),
    });
    assert.equal(scraped.status, 0, scraped.err);

    const before = await treeDigest(space.root);
    restore = await readOnlyData(space);
    const { environment, attempts } = throwingEnvironment();
    const result = await space.cli(['scrape', '--dry-run'], { environment });

    assert.equal(result.status, 0, result.out + result.err);
    assert.deepEqual(attempts, [], 'the dry run touched the transport');
    await restore();
    restore = async () => {};
    assert.deepEqual(
      await treeDigest(space.root),
      before,
      'the dry run changed or added a file',
    );

    assert.match(
      result.out,
      /replayed raw run 20261118T093000Z\. Nothing was fetched and nothing was written\./,
    );
    // What would change: Spotify within 40% publishes, Netflix Standard
    // from 99 to 169 SEK is flagged, and new plans appear.
    assert.match(
      result.out,
      /~ SE\/spotify\/individual\/month: ok 129\.00 SEK from scraper:youfundceo\.com → ok 149\.00 SEK from scraper:youfundceo\.com/,
    );
    assert.match(
      result.out,
      /~ SE\/netflix\/standard\/month: ok 99\.00 SEK from scraper:youfundceo\.com → needs_review 169\.00 SEK from scraper:youfundceo\.com/,
    );
    assert.match(
      result.out,
      /\+ US\/netflix\/basic\/month: missing \(not_on_source\)/,
    );
    assert.match(result.out, /A build would change 16 record\(s\)/);
    assert.match(result.out, /Coverage: 75% \(12 of 16 records publishable\)/);
    assert.match(
      result.out,
      /Fetched 15 · matched 13 · unmatched 49 · changed 0/,
    );
  } finally {
    await restore();
    await space.dispose();
  }
});

test('a dry run from the fixtures needs no raw run, and writes nothing', async () => {
  const space = await priceIndexWorkspace({ services, markets: ['SE', 'US'] });
  let restore = async () => {};
  try {
    await space.writeLatest(earlier, '2026-10-18');
    const before = await treeDigest(space.root);
    restore = await readOnlyData(space);
    const { environment, attempts } = throwingEnvironment();
    const result = await space.cli(
      ['scrape', '--dry-run', '--from-fixtures', '--market', 'SE'],
      { environment },
    );
    assert.equal(result.status, 0, result.out + result.err);
    assert.deepEqual(attempts, []);
    await restore();
    restore = async () => {};
    assert.deepEqual(await treeDigest(space.root), before);
    assert.match(result.out, /replayed the founder's captured fixtures/);
    assert.match(result.out, /Markets: SE/);
    assert.match(
      result.out,
      /~ SE\/spotify\/individual\/month: ok 129\.00 SEK .*→ ok 149\.00 SEK/,
    );
    // US was not asked for: a build would keep it as it is (here, absent
    // before and missing after, as a market with no value yet).
    assert.doesNotMatch(result.out, /~ US\//);
  } finally {
    await restore();
    await space.dispose();
  }
});

test('a dry run with nothing to replay is refused, and with no change says so', async () => {
  const space = await priceIndexWorkspace({ services, markets: ['SE'] });
  try {
    const { environment, attempts } = throwingEnvironment();
    const before = await treeDigest(space.root);
    const refused = await space.cli(['scrape', '--dry-run'], { environment });
    assert.equal(refused.status, 1);
    assert.match(refused.err, /no raw run to replay/);
    assert.deepEqual(await treeDigest(space.root), before);

    // Build the fixtures once; replaying them again changes nothing.
    assert.equal(
      (
        await space.cli(['scrape'], {
          environment: testEnvironment(fixtureDriver(), fakeClock()),
        })
      ).status,
      0,
    );
    assert.equal(
      (
        await space.cli(['build-data'], {
          clock: { now: () => new Date('2026-11-18T12:00:00.000Z') },
        })
      ).status,
      0,
    );
    const unchanged = await space.cli(['scrape', '--dry-run'], {
      environment,
    });
    assert.equal(unchanged.status, 0, unchanged.err);
    assert.match(
      unchanged.out,
      /A build would change no record in latest\.json\./,
    );
    assert.deepEqual(attempts, []);
  } finally {
    await space.dispose();
  }
});

test('a replayed page that did not load stays failed, with or without a readable fetch report', async () => {
  const space = await priceIndexWorkspace({ services, markets: ['SE'] });
  try {
    const scraped = await space.cli(['scrape'], {
      environment: testEnvironment(
        fixtureDriver({
          status: (path) =>
            path === '/services/chatgpt/sweden' ? 404 : undefined,
        }),
        fakeClock(),
      ),
    });
    assert.equal(scraped.status, 0, scraped.err);
    assert.match(scraped.out, /Failed markets: SE \(1\)/);

    const { environment } = throwingEnvironment();
    const replayed = await space.cli(['scrape', '--dry-run'], { environment });
    assert.equal(replayed.status, 0, replayed.err);
    assert.match(replayed.out, /Failed markets: SE \(1\)/);
    assert.match(
      replayed.out,
      /\+ SE\/chatgpt\/plus\/month: missing \(market_failed\)/,
    );

    // A fetch report a crash left unreadable only loses the detail.
    await writeFile(
      join(space.rawRoot, '20261118T093000Z', 'fetch-report.json'),
      '{ "pages": [',
    );
    const unreadable = await space.cli(['scrape', '--dry-run'], {
      environment,
    });
    assert.equal(unreadable.status, 0, unreadable.err);
    assert.match(unreadable.out, /Failed markets: SE \(1\)/);
  } finally {
    await space.dispose();
  }
});
