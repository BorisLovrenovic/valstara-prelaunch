import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  coverageReportFileSchema,
  type CoverageReportFile,
} from '../../packages/price-index/src/schema/index.ts';
import { fakeClock } from '../helpers/price-index-fetcher.ts';
import { priceOverride } from '../helpers/price-index-merge.ts';
import {
  capturedServices,
  fixtureDriver,
  priceIndexWorkspace,
  siteReadDirectories,
  testEnvironment,
  treeDigest,
  type Workspace,
} from '../helpers/price-index-run.ts';

// E11.6-08: the coverage report on the command line. `scrape` writes the
// preview of its run, `build-data` the final report of its build (replacing
// that day's preview), and `report` the preview of the newest run against
// the founder's current data. A dry run writes none. Every run uses the fake
// browser driver over the founder's captured pages; no test reaches the
// source (epic rule 2).

const firstRun = '20261118T093000Z';
const afternoon = { now: () => new Date('2026-11-18T12:00:00.000Z') };

function workspace(): Promise<Workspace> {
  return priceIndexWorkspace({
    services: [...capturedServices, 'lovable'],
    markets: ['SE', 'US'],
  });
}

async function reportOf(
  space: Workspace,
  date: string,
): Promise<{ json: CoverageReportFile; markdown: string }> {
  const base = join(space.root, 'reports', `coverage-${date}`);
  return {
    json: coverageReportFileSchema.parse(
      JSON.parse(await readFile(`${base}.json`, 'utf8')),
    ),
    markdown: await readFile(`${base}.md`, 'utf8'),
  };
}

async function reportNames(space: Workspace): Promise<string[]> {
  try {
    return (await readdir(join(space.root, 'reports')))
      .filter((name) => name.startsWith('coverage-'))
      .sort();
  } catch {
    return [];
  }
}

test('scrape writes the preview coverage report, and build-data replaces it with the final one', async () => {
  const space = await workspace();
  try {
    const before = await treeDigest(space.root, siteReadDirectories);
    const scraped = await space.cli(['scrape'], {
      environment: testEnvironment(fixtureDriver(), fakeClock()),
    });
    assert.equal(scraped.status, 0, scraped.err);
    assert.deepEqual(await treeDigest(space.root, siteReadDirectories), before);
    for (const path of [
      'reports/coverage-2026-11-18.md',
      'reports/coverage-2026-11-18.json',
    ]) {
      assert.ok(scraped.out.includes(path), `scrape does not name ${path}`);
    }

    const preview = await reportOf(space, '2026-11-18');
    assert.equal(preview.json.kind, 'preview');
    assert.equal(preview.json.run_id, firstRun);
    assert.match(preview.markdown, /^# Coverage report 2026-11-18 \(preview\)/);
    // Six services, eight plans, two markets: sixteen cells, the run's 81.2%.
    assert.equal(preview.json.matrix.flatMap((row) => row.cells).length, 16);
    assert.deepEqual(preview.json.coverage.overall, {
      publishable: 13,
      records: 16,
      percent: 81.2,
    });
    // Lovable is not on the source; Netflix Basic is not listed in the US.
    assert.deepEqual(
      preview.json.missing.map((group) => [
        group.reason,
        group.service_id,
        group.combinations.map((entry) => `${entry.market}/${entry.plan_id}`),
      ]),
      [
        ['not_on_source', 'lovable', ['SE/pro', 'US/pro']],
        ['not_on_source', 'netflix', ['US/basic']],
      ],
    );
    assert.equal(preview.json.untracked.length, 49);
    assert.equal(preview.json.spot_checks.records.length, 5);
    assert.ok(
      preview.json.spot_checks.records.every((entry) =>
        entry.official_url.startsWith('https://'),
      ),
    );

    const built = await space.cli(['build-data'], { clock: afternoon });
    assert.equal(built.status, 0, built.err);
    assert.ok(built.out.includes('reports/coverage-2026-11-18.json'));
    const final = await reportOf(space, '2026-11-18');
    assert.equal(final.json.kind, 'final');
    assert.equal(final.json.built_at, '2026-11-18T12:00:00.000Z');
    assert.match(final.markdown, /\(final\)/);
    // The same run draws the same spot checks in the preview and the build.
    assert.deepEqual(final.json.spot_checks, preview.json.spot_checks);
    assert.deepEqual(await reportNames(space), [
      'coverage-2026-11-18.json',
      'coverage-2026-11-18.md',
    ]);

    // Both are data files `validate` checks.
    const validated = await space.cli(['validate']);
    assert.equal(validated.status, 0, validated.err);
  } finally {
    await space.dispose();
  }
});

test('report writes the preview of the newest run against the current overrides, and touches no site data', async () => {
  const space = await workspace();
  try {
    const scraped = await space.cli(['scrape'], {
      environment: testEnvironment(fixtureDriver(), fakeClock()),
    });
    assert.equal(scraped.status, 0, scraped.err);
    // The founder fills Lovable in Sweden by hand after reading the preview.
    await writeFile(
      join(space.dataDirectory, 'manual-overrides.json'),
      `${JSON.stringify(
        {
          overrides: [
            priceOverride({
              service_id: 'lovable',
              plan_id: 'pro',
              price_local: '250.00',
              source_url: 'https://lovable.dev/pricing',
            }),
          ],
        },
        null,
        2,
      )}\n`,
    );
    const before = await treeDigest(space.root, siteReadDirectories);
    const clock = { now: () => new Date('2026-11-19T08:00:00.000Z') };
    const result = await space.cli(['report'], { clock });
    assert.equal(result.status, 0, result.err);
    assert.deepEqual(await treeDigest(space.root, siteReadDirectories), before);
    assert.ok(result.out.includes('reports/coverage-2026-11-19.md'));

    const { json } = await reportOf(space, '2026-11-19');
    assert.equal(json.kind, 'preview');
    assert.equal(json.run_id, firstRun);
    assert.deepEqual(json.coverage.overall, {
      publishable: 14,
      records: 16,
      percent: 87.5,
    });
    assert.deepEqual(
      json.unranked.map((entry) => entry.service_id),
      ['lovable'],
    );
    assert.ok(
      !json.missing.some(
        (group) =>
          group.service_id === 'lovable' &&
          group.combinations.some((entry) => entry.market === 'SE'),
      ),
    );
  } finally {
    await space.dispose();
  }
});

test('report refuses with no run, or with a flag, and a dry run writes no report', async () => {
  const space = await workspace();
  try {
    const none = await space.cli(['report'], { clock: afternoon });
    assert.equal(none.status, 1);
    assert.match(none.err, /no scrape run to report on/);
    const flagged = await space.cli(['report', '--market', 'SE'], {
      clock: afternoon,
    });
    assert.equal(flagged.status, 1);
    assert.match(flagged.err, /takes no flags/);

    const dry = await space.cli(['scrape', '--dry-run', '--from-fixtures'], {
      environment: testEnvironment(fixtureDriver(), fakeClock()),
    });
    assert.equal(dry.status, 0, dry.err);
    assert.deepEqual(await reportNames(space), []);
  } finally {
    await space.dispose();
  }
});

test('validate refuses a coverage report that fails its schema or is misdated', async () => {
  const space = await workspace();
  try {
    const scraped = await space.cli(['scrape'], {
      environment: testEnvironment(fixtureDriver(), fakeClock()),
    });
    assert.equal(scraped.status, 0, scraped.err);
    const path = join(space.root, 'reports/coverage-2026-11-18.json');
    const good = JSON.parse(await readFile(path, 'utf8'));

    await writeFile(
      join(space.root, 'reports/coverage-2026-11-17.json'),
      `${JSON.stringify(good, null, 2)}\n`,
    );
    const misdated = await space.cli(['validate']);
    assert.equal(misdated.status, 3);
    assert.match(misdated.err, /coverage-2026-11-17\.json \(built_at\)/);
    await writeFile(
      join(space.root, 'reports/coverage-2026-11-17.json'),
      `${JSON.stringify({ ...good, built_at: '2026-11-17T09:00:00.000Z', price_usd_source: '1.00' }, null, 2)}\n`,
    );
    const extra = await space.cli(['validate']);
    assert.equal(extra.status, 3);
    assert.match(extra.err, /coverage-2026-11-17\.json/);
  } finally {
    await space.dispose();
  }
});
