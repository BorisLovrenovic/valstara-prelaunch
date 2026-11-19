import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import * as prettier from 'prettier';

import {
  latestFileSchema,
  runLogFileSchema,
  runObservationsFileSchema,
  type LatestFile,
  type PriceRecord,
  type RunObservationsFile,
} from '../../packages/price-index/src/schema/index.ts';
import { fakeClock } from '../helpers/price-index-fetcher.ts';
import { record } from '../helpers/price-index-merge.ts';
import {
  capturedServices,
  fixtureDriver,
  priceIndexWorkspace,
  siteReadDirectories,
  testEnvironment,
  treeDigest,
  type Workspace,
} from '../helpers/price-index-run.ts';

// E11.6-07: `scrape` fetches through the fetcher, reads the pages with the
// source adapter, and writes the run's observations and a preview merge to
// data/raw/<run_id>/. It never writes latest.json. `build-data` merges the
// latest run and, only on full validation, writes latest.json, a snapshot
// and reports/runs/<run_id>.json. Every run here uses a fake browser driver
// that answers from the founder's captured pages, an injected clock and a
// seeded source; no test reaches the source (epic rule 2).

const firstRun = '20261118T093000Z';
const services = [...capturedServices, 'lovable'];

function workspace(): Promise<Workspace> {
  return priceIndexWorkspace({ services, markets: ['SE', 'US'] });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function observationsOf(
  space: Workspace,
  runId: string,
): Promise<RunObservationsFile> {
  return runObservationsFileSchema.parse(
    await readJson(join(space.rawRoot, runId, 'observations.json')),
  );
}

async function latestOf(space: Workspace): Promise<LatestFile> {
  return latestFileSchema.parse(
    await readJson(join(space.dataDirectory, 'latest.json')),
  );
}

function find(
  latest: LatestFile,
  market: string,
  service: string,
  plan: string,
): PriceRecord {
  const found = latest.records.find(
    (candidate) =>
      candidate.market === market &&
      candidate.service_id === service &&
      candidate.plan_id === plan,
  );
  assert.ok(found, `no record ${market}/${service}/${plan}`);
  return found;
}

/** A latest.json from an earlier month: Spotify in Sweden at 129 SEK. */
const earlier: LatestFile = {
  built_at: '2026-10-18T09:00:00.000Z',
  records: [
    record({
      price_local: '129.00',
      price_source_text: 'kr 129',
      observed_at: '2026-10-18T09:00:00.000Z',
      source_verified_at: '2026-10-15',
    }),
  ],
};

test('scrape writes the observations and a preview, and never touches latest.json', async () => {
  const space = await workspace();
  try {
    await space.writeLatest(earlier, '2026-10-18');
    const before = await treeDigest(space.root, siteReadDirectories);
    const driver = fixtureDriver();
    const result = await space.cli(['scrape'], {
      environment: testEnvironment(driver, fakeClock()),
    });

    assert.equal(result.status, 0, result.err);
    assert.deepEqual(
      await treeDigest(space.root, siteReadDirectories),
      before,
      'scrape changed a file the site reads',
    );
    assert.equal(driver.closed, 1, 'the browser was not closed once');

    // The observations, written by hand from the captured pages.
    const observations = await observationsOf(space, firstRun);
    assert.equal(observations.fetch_status, 'completed');
    assert.equal(observations.market_scope, null);
    assert.equal(observations.observed_at, '2026-11-18T09:30:00.000Z');
    assert.equal(observations.pages_fetched, 15);
    assert.deepEqual(
      observations.observations.map((observation) => [
        observation.market,
        observation.service_id,
        observation.plan_id,
        observation.price_local,
        observation.currency,
        observation.price_usd_source,
        observation.source_verified_at,
      ]),
      [
        [
          'SE',
          'apple-music',
          'individual',
          '119.00',
          'SEK',
          '11.82',
          '2026-10-30',
        ],
        [
          'US',
          'apple-music',
          'individual',
          '11.99',
          'USD',
          '11.99',
          '2026-11-16',
        ],
        ['SE', 'chatgpt', 'plus', '249.00', 'SEK', '24.73', '2026-10-28'],
        ['US', 'chatgpt', 'plus', '20.00', 'USD', '20.00', '2026-11-16'],
        ['SE', 'netflix', 'basic', '129.00', 'SEK', '12.81', '2026-11-04'],
        ['SE', 'netflix', 'premium', '219.00', 'SEK', '21.75', '2026-11-04'],
        ['US', 'netflix', 'premium', '26.99', 'USD', '26.99', '2026-10-28'],
        ['SE', 'netflix', 'standard', '169.00', 'SEK', '16.78', '2026-11-04'],
        ['US', 'netflix', 'standard', '19.99', 'USD', '19.99', '2026-10-28'],
        ['SE', 'spotify', 'individual', '149.00', 'SEK', '14.80', '2026-11-04'],
        ['US', 'spotify', 'individual', '12.99', 'USD', '12.99', '2026-11-16'],
        [
          'SE',
          'youtube-premium',
          'individual',
          '169.00',
          'SEK',
          '16.78',
          '2026-11-04',
        ],
        [
          'US',
          'youtube-premium',
          'individual',
          '15.99',
          'USD',
          '15.99',
          '2026-11-04',
        ],
      ],
    );
    assert.deepEqual(
      observations.gaps.map((gap) => [
        gap.market,
        gap.service_id,
        gap.plan_id,
        gap.reason,
      ]),
      [
        ['SE', 'lovable', 'pro', 'not_on_source'],
        ['US', 'lovable', 'pro', 'not_on_source'],
        ['US', 'netflix', 'basic', 'not_on_source'],
      ],
    );
    assert.deepEqual(observations.failures, []);
    assert.ok(observations.price_moves !== null);

    // The preview is the latest.json a build would write: Spotify's rise
    // from 129 to 149 SEK is within 40%, so it would publish.
    const preview = latestFileSchema.parse(
      await readJson(join(space.rawRoot, firstRun, 'preview.json')),
    );
    assert.equal(preview.records.length, 16);
    const spotify = find(preview, 'SE', 'spotify', 'individual');
    assert.equal(spotify.status, 'ok');
    assert.equal(spotify.price_local, '149.00');

    // The console summary: coverage, the counts and every report's path.
    assert.match(result.out, /run 20261118T093000Z completed \(exit 0\)/);
    assert.match(
      result.out,
      /Coverage: 81\.2% \(13 of 16 records publishable\)/,
    );
    assert.match(
      result.out,
      // E11.6-09: Spotify SE 129 → 149 SEK is the build's one real change.
      /Fetched 15 · matched 13 · unmatched 49 · changed 1/,
    );
    assert.match(result.out, /ok 13 · missing 3 ·/);
    assert.match(result.out, /Failed markets: none/);
    for (const file of [
      'observations.json',
      'preview.json',
      'fetch-report.json',
    ]) {
      assert.ok(
        result.out.includes(`data/raw/${firstRun}/${file}`),
        `the summary does not name ${file}`,
      );
    }
    assert.doesNotMatch(result.out, /not modified/i);
  } finally {
    await space.dispose();
  }
});

test('build-data writes latest.json, a snapshot and the run log of the latest run', async () => {
  const space = await workspace();
  try {
    await space.writeLatest(earlier, '2026-10-18');
    const scraped = await space.cli(['scrape'], {
      environment: testEnvironment(fixtureDriver(), fakeClock()),
    });
    assert.equal(scraped.status, 0, scraped.err);

    const clock = { now: () => new Date('2026-11-18T12:00:00.000Z') };
    const built = await space.cli(['build-data'], { clock });
    assert.equal(built.status, 0, built.err);

    const latest = await latestOf(space);
    assert.equal(latest.built_at, '2026-11-18T12:00:00.000Z');
    assert.equal(
      find(latest, 'SE', 'spotify', 'individual').price_local,
      '149.00',
    );
    const preview = await readFile(
      join(space.rawRoot, firstRun, 'preview.json'),
      'utf8',
    );
    assert.deepEqual(
      (await latestOf(space)).records,
      latestFileSchema.parse(JSON.parse(preview)).records,
      'the build differs from the preview of the same run and data',
    );

    // The snapshot is the build's latest.json; the earlier one is untouched.
    assert.equal(
      await readFile(
        join(space.dataDirectory, 'snapshots/2026-11-18.json'),
        'utf8',
      ),
      await readFile(join(space.dataDirectory, 'latest.json'), 'utf8'),
    );

    const logPath = join(space.root, 'reports/runs', `${firstRun}.json`);
    const logText = await readFile(logPath, 'utf8');
    const log = runLogFileSchema.parse(JSON.parse(logText));
    assert.deepEqual(log, {
      run_id: firstRun,
      source: 'scraper:youfundceo.com',
      fetch_status: 'completed',
      market_scope: null,
      observed_at: '2026-11-18T09:30:00.000Z',
      built_at: '2026-11-18T12:00:00.000Z',
      snapshot: '2026-11-18.json',
      coverage_percent: 81.2,
      counts: {
        fetched: 15,
        matched: 13,
        unmatched: 49,
        records_by_status: {
          ok: 13,
          missing: 3,
          not_offered: 0,
          needs_review: 0,
          manual_override: 0,
          stale: 0,
          conflict: 0,
        },
        failed_markets: 0,
        changed: 1,
      },
      failed_markets: [],
      failures: [],
    });
    assert.ok(!('not_modified' in log.counts));
    // Deterministic and in the repository's format (epic rule 8).
    const options = (await prettier.resolveConfig(logPath)) ?? {};
    assert.ok(await prettier.check(logText, { ...options, filepath: logPath }));

    assert.match(built.out, /built run 20261118T093000Z/);
    assert.match(built.out, /Coverage: 81\.2%/);
    for (const path of [
      'data/price-index/latest.json',
      'data/price-index/snapshots/2026-11-18.json',
      `reports/runs/${firstRun}.json`,
    ]) {
      assert.ok(built.out.includes(path), `the summary does not name ${path}`);
    }

    // A second build of the same run adds a snapshot and replaces nothing.
    const again = await space.cli(['build-data'], { clock });
    assert.equal(again.status, 0, again.err);
    assert.match(again.out, /snapshots\/2026-11-18-2\.json/);
    assert.ok(
      (
        await readFile(
          join(space.dataDirectory, 'snapshots/2026-10-18.json'),
          'utf8',
        )
      ).includes('129.00'),
    );
  } finally {
    await space.dispose();
  }
});

test('a run stopped by the source leaves the site data byte-identical, and builds as a partial run', async () => {
  const space = await workspace();
  try {
    // November: a full run, built.
    const first = await space.cli(['scrape'], {
      environment: testEnvironment(fixtureDriver(), fakeClock()),
    });
    assert.equal(first.status, 0, first.err);
    const novemberBuild = { now: () => new Date('2026-11-18T12:00:00.000Z') };
    assert.equal(
      (await space.cli(['build-data'], { clock: novemberBuild })).status,
      0,
    );
    const november = await latestOf(space);
    const before = await treeDigest(space.root, siteReadDirectories);

    // December: the source refuses the United States page.
    const driver = fixtureDriver({
      status: (path) => (path === '/countries/united-states' ? 429 : undefined),
    });
    const stopped = await space.cli(['scrape'], {
      environment: testEnvironment(
        driver,
        fakeClock('2026-12-18T09:30:00.000Z'),
      ),
    });
    assert.equal(stopped.status, 2, stopped.out + stopped.err);
    assert.match(stopped.out, /was stopped by the source \(exit 2\)/);
    assert.match(stopped.out, /scrape --resume 20261218T093000Z/);
    assert.deepEqual(
      await treeDigest(space.root, siteReadDirectories),
      before,
      'a stopped run changed a file the site reads',
    );
    assert.equal(driver.closed, 1);
    assert.deepEqual(
      driver.loads.filter((path) => path === '/countries/united-states').length,
      3,
      'the fetcher did not stop after the configured three failures',
    );
    const december = await observationsOf(space, '20261218T093000Z');
    assert.equal(december.fetch_status, 'stopped_by_source');

    // The partial run builds: Sweden is new, the United States keeps
    // November's values, and the run log names it.
    const built = await space.cli(['build-data'], {
      clock: { now: () => new Date('2026-12-18T12:00:00.000Z') },
    });
    assert.equal(built.status, 0, built.err);
    assert.match(built.out, /Failed markets: US \(8\)/);
    assert.match(built.out, /was partial \(stopped_by_source\)/);
    const latest = await latestOf(space);
    for (const [service, plan] of [
      ['spotify', 'individual'],
      ['netflix', 'standard'],
      ['chatgpt', 'plus'],
    ]) {
      const kept = find(latest, 'US', service!, plan!);
      const old = find(november, 'US', service!, plan!);
      assert.equal(kept.status, 'ok');
      assert.equal(kept.price_local, old.price_local);
      assert.equal(kept.observed_at, '2026-11-18T09:30:00.000Z');
      assert.match(kept.notes ?? '', /kept/i);
    }
    assert.equal(
      find(latest, 'SE', 'spotify', 'individual').observed_at,
      '2026-12-18T09:30:00.000Z',
    );
    const log = runLogFileSchema.parse(
      await readJson(join(space.root, 'reports/runs/20261218T093000Z.json')),
    );
    assert.equal(log.fetch_status, 'stopped_by_source');
    assert.deepEqual(log.failed_markets, [{ market: 'US', failed_records: 8 }]);
    assert.equal(log.counts.failed_markets, 1);
    assert.equal(log.counts.records_by_status.ok, 13);
  } finally {
    await space.dispose();
  }
});

test('a resumed run fetches only what is not checkpointed, and reads the rest from the raw store', async () => {
  const space = await workspace();
  try {
    const refusing = fixtureDriver({
      status: (path) => (path.endsWith('/united-states') ? 503 : undefined),
    });
    const stopped = await space.cli(['scrape'], {
      environment: testEnvironment(refusing, fakeClock()),
    });
    assert.equal(stopped.status, 2);

    const driver = fixtureDriver();
    const resumed = await space.cli(['scrape', '--resume', firstRun], {
      environment: testEnvironment(
        driver,
        fakeClock('2026-11-18T11:00:00.000Z'),
      ),
    });
    assert.equal(resumed.status, 0, resumed.err);
    assert.deepEqual(driver.loads, [
      '/countries/united-states',
      '/services/apple-music/united-states',
      '/services/chatgpt/united-states',
      '/services/netflix/united-states',
      '/services/spotify/united-states',
      '/services/youtube-premium/united-states',
    ]);
    const observations = await observationsOf(space, firstRun);
    assert.equal(observations.fetch_status, 'completed');
    assert.equal(observations.observed_at, '2026-11-18T09:30:00.000Z');
    assert.equal(observations.pages_fetched, 15);
    assert.equal(observations.observations.length, 13);
    assert.deepEqual(observations.failures, []);
  } finally {
    await space.dispose();
  }
});

test('scrape --market reads only that market, and a build keeps every other market', async () => {
  const space = await workspace();
  try {
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

    const driver = fixtureDriver();
    const result = await space.cli(['scrape', '--market', 'se'], {
      environment: testEnvironment(
        driver,
        fakeClock('2026-11-25T09:30:00.000Z'),
      ),
    });
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /Markets: SE/);
    assert.ok(
      driver.loads.every((path) => !path.includes('united-states')),
      driver.loads.join(', '),
    );
    const observations = await observationsOf(space, '20261125T093000Z');
    assert.equal(observations.market_scope, 'SE');
    assert.ok(observations.observations.every((item) => item.market === 'SE'));
    assert.ok(observations.gaps.every((gap) => gap.market === 'SE'));

    const built = await space.cli(['build-data'], {
      clock: { now: () => new Date('2026-11-25T12:00:00.000Z') },
    });
    assert.equal(built.status, 0, built.err);
    assert.match(built.out, /Failed markets: none/);
    const latest = await latestOf(space);
    assert.equal(
      find(latest, 'US', 'spotify', 'individual').observed_at,
      '2026-11-18T09:30:00.000Z',
    );
    assert.equal(
      find(latest, 'SE', 'spotify', 'individual').observed_at,
      '2026-11-25T09:30:00.000Z',
    );
  } finally {
    await space.dispose();
  }
});

test('an interrupted run stops cleanly with exit 4 and leaves the site data byte-identical', async () => {
  const space = await workspace();
  try {
    await space.writeLatest(earlier, '2026-10-18');
    const before = await treeDigest(space.root, siteReadDirectories);
    const controller = new AbortController();
    const driver = fixtureDriver({
      onLoad: (path) => {
        if (path === '/services/chatgpt/sweden') {
          controller.abort();
        }
      },
    });
    const result = await space.cli(['scrape'], {
      environment: testEnvironment(driver, fakeClock(), controller.signal),
    });
    assert.equal(result.status, 4, result.out + result.err);
    assert.match(result.out, /was interrupted \(exit 4\)/);
    assert.equal(driver.closed, 1);
    assert.deepEqual(await treeDigest(space.root, siteReadDirectories), before);
    const observations = await observationsOf(space, firstRun);
    assert.equal(observations.fetch_status, 'interrupted');
    assert.ok(!driver.loads.includes('/countries/united-states'));
  } finally {
    await space.dispose();
  }
});

test('a build that fails validation writes nothing', async (t) => {
  const space = await workspace();
  try {
    await space.writeLatest(earlier, '2026-10-18');
    assert.equal(
      (
        await space.cli(['scrape'], {
          environment: testEnvironment(fixtureDriver(), fakeClock()),
        })
      ).status,
      0,
    );
    const overridesPath = join(space.dataDirectory, 'manual-overrides.json');
    const seed = await readFile(overridesPath, 'utf8');
    const clock = { now: () => new Date('2026-11-18T12:00:00.000Z') };

    const cases: [string, string, RegExp][] = [
      [
        'an override in another currency than its market',
        JSON.stringify({
          overrides: [
            {
              kind: 'price',
              market: 'SE',
              service_id: 'spotify',
              plan_id: 'individual',
              billing_period: 'month',
              source_url: 'https://www.spotify.com/se/premium/',
              verified_at: '2026-11-17',
              verified_by: 'founder',
              note: 'Planted.',
              price_local: '14.99',
              currency: 'EUR',
              price_usd_source: null,
            },
          ],
        }),
        /is in EUR, but SE uses SEK/,
      ],
      ['a file that is not JSON', '{ "overrides": [', /not valid JSON/],
      [
        'an unknown key',
        '{ "overrides": [], "extra": true }',
        /manual-overrides\.json/,
      ],
    ];
    for (const [name, content, pattern] of cases) {
      await t.test(name, async () => {
        const before = await treeDigest(space.root, [
          ...siteReadDirectories,
          'reports',
        ]);
        await writeFile(overridesPath, `${content}\n`);
        try {
          const planted = await treeDigest(space.root, [
            ...siteReadDirectories,
            'reports',
          ]);
          const result = await space.cli(['build-data'], { clock });
          assert.equal(result.status, 3, result.out + result.err);
          assert.match(result.err, pattern);
          assert.match(result.err, /Nothing was written/);
          assert.deepEqual(
            await treeDigest(space.root, [...siteReadDirectories, 'reports']),
            planted,
          );
        } finally {
          await writeFile(overridesPath, seed);
        }
        assert.deepEqual(
          await treeDigest(space.root, [...siteReadDirectories, 'reports']),
          before,
        );
      });
    }

    await t.test('an invalid observations file', async () => {
      const path = join(space.rawRoot, firstRun, 'observations.json');
      const original = await readFile(path, 'utf8');
      const before = await treeDigest(space.root, siteReadDirectories);
      const broken = JSON.parse(original);
      broken.observations[0].price_local = 149;
      await writeFile(path, JSON.stringify(broken));
      const result = await space.cli(['build-data'], { clock });
      assert.equal(result.status, 3);
      assert.match(result.err, /observations\.json/);
      assert.deepEqual(
        await treeDigest(space.root, siteReadDirectories),
        before,
      );
      await writeFile(path, original);
    });
  } finally {
    await space.dispose();
  }
});

test('a run killed before it wrote its observations cannot be built or reviewed', async () => {
  const space = await workspace();
  try {
    await space.writeLatest(earlier, '2026-10-18');
    // What a killed process leaves: a run directory with pages and a
    // checkpoint, and no observations.
    const runId = '20261119T080000Z';
    await mkdir(join(space.rawRoot, runId, 'pages'), { recursive: true });
    await writeFile(
      join(space.rawRoot, runId, 'checkpoint.json'),
      `${JSON.stringify({ run_id: runId, origin: 'https://www.youfundceo.com', completed_units: ['index'], updated_at: '2026-11-19T08:05:00.000Z' })}\n`,
    );
    const before = await treeDigest(space.root, siteReadDirectories);
    const built = await space.cli(['build-data'], {
      clock: { now: () => new Date('2026-11-19T12:00:00.000Z') },
    });
    assert.equal(built.status, 1);
    assert.match(built.err, /scrape --resume 20261119T080000Z/);
    const reviewed = await space.cli([
      'review',
      'approve',
      '--market',
      'SE',
      '--service',
      'spotify',
      '--plan',
      'individual',
      '--actor',
      'founder',
    ]);
    assert.equal(reviewed.status, 1);
    assert.match(reviewed.err, /scrape --resume 20261119T080000Z/);
    assert.deepEqual(await treeDigest(space.root, siteReadDirectories), before);
  } finally {
    await space.dispose();
  }
});

test('build-data with no run, or with a flag, is refused', async () => {
  const space = await workspace();
  try {
    const none = await space.cli(['build-data']);
    assert.equal(none.status, 1);
    assert.match(none.err, /no scrape run to build/);
    const flagged = await space.cli(['build-data', '--force']);
    assert.equal(flagged.status, 1);
    assert.match(flagged.err, /takes no flags/);
  } finally {
    await space.dispose();
  }
});

test('scrape refuses bad requests before it opens a browser', async (t) => {
  const space = await workspace();
  try {
    const cases: [string, string[], number, RegExp][] = [
      ['an unknown flag', ['--everything'], 1, /not a flag of scrape/],
      [
        'a flag given twice',
        ['--market', 'SE', '--market', 'US'],
        1,
        /given twice/,
      ],
      ['a market without a code', ['--market'], 1, /needs a value/],
      [
        '--from-fixtures without --dry-run',
        ['--from-fixtures'],
        1,
        /only in a --dry-run/,
      ],
      [
        '--dry-run with --resume',
        ['--dry-run', '--resume', firstRun],
        1,
        /cannot --resume/,
      ],
      ['a malformed run id', ['--resume', 'yesterday'], 1, /not a run id/],
      [
        'an unknown market',
        ['--market', 'XX'],
        1,
        /XX is not an enabled market/,
      ],
      [
        'a disabled market',
        ['--market', 'DE'],
        1,
        /DE is not an enabled market/,
      ],
    ];
    for (const [name, args, status, pattern] of cases) {
      await t.test(name, async () => {
        const driver = fixtureDriver();
        let opened = 0;
        const result = await space.cli(['scrape', ...args], {
          environment: {
            ...testEnvironment(driver, fakeClock()),
            openBrowser: async () => {
              opened += 1;
              return { driver, close: () => driver.close() };
            },
          },
        });
        assert.equal(result.status, status, result.err);
        assert.match(result.err, pattern);
        assert.equal(opened, 0);
      });
    }

    await t.test('a run to resume that does not exist', async () => {
      const driver = fixtureDriver();
      const result = await space.cli(
        ['scrape', '--resume', '20200101T000000Z'],
        {
          environment: testEnvironment(driver, fakeClock()),
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.err, /no raw run 20200101T000000Z/);
      assert.equal(driver.closed, 1, 'the browser was left open');
      assert.deepEqual(driver.loads, []);
    });

    await t.test(
      'an invalid data file stops the run before any page',
      async () => {
        const path = join(space.dataDirectory, 'approvals.json');
        const seed = await readFile(path, 'utf8');
        await writeFile(path, '{ "approvals": "none" }\n');
        const driver = fixtureDriver();
        const result = await space.cli(['scrape'], {
          environment: testEnvironment(driver, fakeClock()),
        });
        await writeFile(path, seed);
        assert.equal(result.status, 3);
        assert.match(result.err, /approvals\.json/);
        assert.deepEqual(driver.loads, []);
        assert.equal(driver.closed, 0);
      },
    );

    await t.test(
      'an invalid configuration stops the run before any page',
      async () => {
        const path = join(space.root, 'config/price-index.json');
        const seed = await readFile(path, 'utf8');
        await writeFile(
          path,
          seed.replace('"raw_runs_kept": 6', '"raw_runs_kept": 0'),
        );
        const driver = fixtureDriver();
        const result = await space.cli(['scrape'], {
          environment: testEnvironment(driver, fakeClock()),
        });
        await writeFile(path, seed);
        assert.equal(result.status, 3);
        assert.match(result.err, /raw_runs_kept/);
        assert.deepEqual(driver.loads, []);
      },
    );
  } finally {
    await space.dispose();
  }
});

test('review decides on the preview of the latest run, before build-data (D-028 Q4)', async () => {
  const space = await workspace();
  try {
    // October published 99 SEK; the run reads 149 SEK, beyond 40%.
    await space.writeLatest({
      built_at: '2026-10-18T09:00:00.000Z',
      records: [
        record({
          price_local: '99.00',
          price_source_text: 'kr 99',
          observed_at: '2026-10-18T09:00:00.000Z',
        }),
      ],
    });
    assert.equal(
      (
        await space.cli(['scrape'], {
          environment: testEnvironment(fixtureDriver(), fakeClock()),
        })
      ).status,
      0,
    );
    // latest.json has no flag; only the preview does.
    const review = (decision: string, service: string, plan: string) =>
      space.cli(
        [
          'review',
          decision,
          '--market',
          'SE',
          '--service',
          service,
          '--plan',
          plan,
          '--actor',
          'founder',
        ],
        { clock: { now: () => new Date('2026-11-18T11:00:00.000Z') } },
      );
    const notFlagged = await review('approve', 'netflix', 'basic');
    assert.equal(notFlagged.status, 1);
    assert.match(notFlagged.err, /is ok; only needs_review and conflict/);

    const approved = await review('approve', 'spotify', 'individual');
    assert.equal(approved.status, 0, approved.err);
    assert.match(
      approved.out,
      /approved 149\.00 SEK \(scraper:youfundceo\.com\) for SE\/spotify\/individual\/month, which was needs_review in the preview of run 20261118T093000Z/,
    );
    const approvals = (await readJson(
      join(space.dataDirectory, 'approvals.json'),
    )) as { approvals: { price_local: string; actor: string }[] };
    assert.deepEqual(
      approvals.approvals.map((entry) => [entry.price_local, entry.actor]),
      [['149.00', 'founder']],
    );
    assert.equal(
      find(await latestOf(space), 'SE', 'spotify', 'individual').price_local,
      '99.00',
      'review wrote latest.json',
    );

    // The approval applies to the preview at once, and to the build.
    const twice = await review('approve', 'spotify', 'individual');
    assert.equal(twice.status, 1);
    assert.match(twice.err, /is ok/);
    const built = await space.cli(['build-data'], {
      clock: { now: () => new Date('2026-11-18T12:00:00.000Z') },
    });
    assert.equal(built.status, 0, built.err);
    const spotify = find(await latestOf(space), 'SE', 'spotify', 'individual');
    assert.equal(spotify.status, 'ok');
    assert.equal(spotify.price_local, '149.00');
  } finally {
    await space.dispose();
  }
});
