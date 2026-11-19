import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { validateDataFiles } from '../../packages/price-index/src/cli/validate.ts';
import { record } from '../helpers/price-index-merge.ts';
import {
  priceIndexWorkspace,
  projectRoot,
} from '../helpers/price-index-run.ts';

// E11.6-07: `price-index validate` extends to every data file: latest.json,
// each snapshot, manual-overrides.json, approvals.json and each run log;
// E11.6-09 adds changes.json and the monthly reports. It
// runs first in `npm run check`, so a planted invalid data file fails it.

const validLatest = {
  built_at: '2026-11-18T12:00:00.000Z',
  records: [record({})],
};

const validLog = {
  run_id: '20261118T093000Z',
  source: 'scraper:youfundceo.com',
  fetch_status: 'completed',
  market_scope: null,
  observed_at: '2026-11-18T09:30:00.000Z',
  built_at: '2026-11-18T12:00:00.000Z',
  snapshot: '2026-11-18.json',
  coverage_percent: 100,
  counts: {
    fetched: 3,
    matched: 1,
    unmatched: 0,
    records_by_status: {
      ok: 1,
      missing: 0,
      not_offered: 0,
      needs_review: 0,
      manual_override: 0,
      stale: 0,
      conflict: 0,
    },
    failed_markets: 0,
    changed: 0,
  },
  failed_markets: [],
  failures: [],
};

const validMonthly = {
  month: '2026-11',
  snapshot: '2026-11-18.json',
  built_at: '2026-11-18T12:00:00.000Z',
  markets: 20,
  changes: [],
  plans: [],
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

test('the committed data files are valid', async () => {
  assert.deepEqual(await validateDataFiles(projectRoot), []);
});

test('valid latest.json, snapshots and run logs pass, and a crashed write is ignored', async () => {
  const space = await priceIndexWorkspace();
  try {
    await space.writeLatest(validLatest, '2026-11-18');
    await space.writeLatest(validLatest, '2026-11-18');
    await writeFile(
      join(space.dataDirectory, 'snapshots/.2026-11-19.json.4242-1.tmp'),
      '{',
    );
    await mkdir(join(space.root, 'reports/runs'), { recursive: true });
    await writeFile(
      join(space.root, 'reports/runs/20261118T093000Z.json'),
      json(validLog),
    );
    assert.deepEqual(await validateDataFiles(space.root), []);
    const result = await space.cli(['validate']);
    assert.equal(result.status, 0, result.err);
    assert.match(
      result.out,
      /configuration is valid, and so is every data file/,
    );
  } finally {
    await space.dispose();
  }
});

test('validate refuses each planted invalid data file, naming it', async (t) => {
  const cases: [string, string, string, RegExp][] = [
    [
      'latest.json with an fx field',
      'data/price-index/latest.json',
      json({ ...validLatest, records: [{ ...record({}), fx: '1.00' }] }),
      /data\/price-index\/latest\.json \(records\.0\)/,
    ],
    [
      'latest.json that is not JSON',
      'data/price-index/latest.json',
      '{ "built_at": ',
      /data\/price-index\/latest\.json: not valid JSON/,
    ],
    [
      'a snapshot with a float price',
      'data/price-index/snapshots/2026-11-18.json',
      json({ ...validLatest, records: [{ ...record({}), price_local: 149 }] }),
      /snapshots\/2026-11-18\.json \(records\.0\.price_local\)/,
    ],
    [
      'a file in snapshots/ not named like a snapshot',
      'data/price-index/snapshots/latest-copy.json',
      json(validLatest),
      /latest-copy\.json: is not named like a snapshot/,
    ],
    [
      'an override without verified_by',
      'data/price-index/manual-overrides.json',
      json({
        overrides: [
          {
            kind: 'not_offered',
            market: 'US',
            service_id: 'netflix',
            plan_id: 'basic',
            billing_period: 'month',
            source_url: 'https://help.netflix.com/en/node/24926',
            verified_at: '2026-11-17',
            verified_by: '',
            note: 'Planted.',
          },
        ],
      }),
      /manual-overrides\.json \(overrides\.0\.verified_by\)/,
    ],
    [
      'an approval without an actor',
      'data/price-index/approvals.json',
      json({ approvals: [{ decision: 'approve' }] }),
      /approvals\.json \(approvals\.0/,
    ],
    [
      'a run log with a not-modified count',
      'reports/runs/20261118T093000Z.json',
      json({ ...validLog, counts: { ...validLog.counts, not_modified: 2 } }),
      /reports\/runs\/20261118T093000Z\.json \(counts\)/,
    ],
    [
      'a run log under another run id',
      'reports/runs/20261118T093000Z.json',
      json({ ...validLog, run_id: '20261117T093000Z' }),
      /reports\/runs\/20261118T093000Z\.json \(run_id\): must be 20261118T093000Z/,
    ],
    [
      'a change with a float price (E11.6-09)',
      'data/price-index/changes.json',
      json({
        changes: [
          {
            market: 'SE',
            service_id: 'spotify',
            plan_id: 'individual',
            billing_period: 'month',
            old_price_local: 129,
            new_price_local: '149.00',
            currency: 'SEK',
            change_percent: '15.5',
            detected_on: '2026-12-01',
            source: 'scraper:youfundceo.com',
          },
        ],
      }),
      /changes\.json \(changes\.0\.old_price_local\)/,
    ],
    [
      'a change carrying a USD figure (E11.6-09)',
      'data/price-index/changes.json',
      json({
        changes: [
          {
            market: 'SE',
            service_id: 'spotify',
            plan_id: 'individual',
            billing_period: 'month',
            old_price_local: '129.00',
            new_price_local: '149.00',
            currency: 'SEK',
            change_percent: '15.5',
            detected_on: '2026-12-01',
            source: 'scraper:youfundceo.com',
            price_usd_source: '15.79',
          },
        ],
      }),
      /changes\.json \(changes\.0\)/,
    ],
    [
      'a monthly report not named by its month (E11.6-09)',
      'data/price-index/monthly/november.json',
      json(validMonthly),
      /monthly\/november\.json: is not named like a monthly report/,
    ],
    [
      'a monthly report under another month (E11.6-09)',
      'data/price-index/monthly/2026-12.json',
      json(validMonthly),
      /monthly\/2026-12\.json \(month\): must be 2026-12/,
    ],
    [
      'a monthly report holding the cross-check (E11.6-09)',
      'data/price-index/monthly/2026-11.json',
      json({ ...validMonthly, cross_check: [] }),
      /monthly\/2026-11\.json/,
    ],
    [
      'a run log not named by its run id',
      'reports/runs/november.json',
      json(validLog),
      /reports\/runs\/november\.json: is not named like a run log/,
    ],
  ];
  for (const [name, file, content, pattern] of cases) {
    await t.test(name, async () => {
      const space = await priceIndexWorkspace();
      try {
        await mkdir(join(space.root, file, '..'), { recursive: true });
        await writeFile(join(space.root, file), content);
        const issues = await validateDataFiles(space.root);
        assert.ok(issues.length > 0, `${name} passed`);
        const result = await space.cli(['validate']);
        assert.equal(result.status, 3);
        assert.match(result.err, pattern);
      } finally {
        await space.dispose();
      }
    });
  }

  await t.test('a missing changes.json (E11.6-09)', async () => {
    const space = await priceIndexWorkspace();
    try {
      await rm(join(space.dataDirectory, 'changes.json'));
      const result = await space.cli(['validate']);
      assert.equal(result.status, 3);
      assert.match(result.err, /changes\.json: file not found/);
    } finally {
      await space.dispose();
    }
  });

  await t.test('a missing approvals.json', async () => {
    const space = await priceIndexWorkspace();
    try {
      await rm(join(space.dataDirectory, 'approvals.json'));
      const result = await space.cli(['validate']);
      assert.equal(result.status, 3);
      assert.match(result.err, /approvals\.json: file not found/);
    } finally {
      await space.dispose();
    }
  });
});
