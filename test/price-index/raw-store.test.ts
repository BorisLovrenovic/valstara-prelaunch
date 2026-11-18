import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRun,
  pageFileName,
  readCheckpoint,
  rotateRuns,
  writeCheckpoint,
} from '../../packages/price-index/src/http/raw-store.ts';
import { openFetchSession } from '../../packages/price-index/src/http/fetcher.ts';
import { seededRandom } from '../../packages/price-index/src/http/random.ts';
import { fakeClock, fetcherSettings } from '../helpers/price-index-fetcher.ts';

// E11.6-04: the raw store under data/raw/<run_id>/, rotated to the last N
// runs, with an atomic checkpoint.

async function withRawRoot(work: (rawRoot: string) => Promise<void>) {
  const rawRoot = await mkdtemp(join(tmpdir(), 'valstara-price-index-rotate-'));
  try {
    await work(rawRoot);
  } finally {
    await rm(rawRoot, { recursive: true, force: true });
  }
}

const runIds = [
  '20260518T090000Z',
  '20260618T090000Z',
  '20260718T090000Z',
  '20260818T090000Z',
  '20260918T090000Z',
  '20261018T090000Z',
  '20261018T090000Z-2',
  '20261118T090000Z',
];

for (const keep of [1, 3, 6]) {
  test(`rotation keeps exactly ${keep} runs: the newest, the current among them`, async () => {
    await withRawRoot(async (rawRoot) => {
      for (const runId of runIds) {
        await mkdir(join(rawRoot, runId, 'pages'), { recursive: true });
      }
      const deleted = await rotateRuns(rawRoot, keep, '20261118T090000Z');
      const left = (await readdir(rawRoot)).sort();
      assert.equal(left.length, keep);
      assert.deepEqual(left, runIds.slice(-keep));
      assert.deepEqual(deleted, runIds.slice(0, runIds.length - keep));
    });
  });
}

test('rotation never deletes the current run, even an old one being resumed', async () => {
  await withRawRoot(async (rawRoot) => {
    for (const runId of runIds) {
      await mkdir(join(rawRoot, runId));
    }
    await rotateRuns(rawRoot, 3, '20260518T090000Z');
    assert.deepEqual((await readdir(rawRoot)).sort(), [
      '20260518T090000Z',
      '20261018T090000Z-2',
      '20261118T090000Z',
    ]);
  });
});

test('rotation counts and deletes only run directories', async () => {
  await withRawRoot(async (rawRoot) => {
    for (const runId of runIds.slice(0, 4)) {
      await mkdir(join(rawRoot, runId));
    }
    await mkdir(join(rawRoot, 'notes'));
    await writeFile(join(rawRoot, '20250101T000000Z'), 'a file, not a run');
    await rotateRuns(rawRoot, 2, runIds[3]!);
    assert.deepEqual((await readdir(rawRoot)).sort(), [
      '20250101T000000Z',
      runIds[2]!,
      runIds[3]!,
      'notes',
    ]);
  });
});

test('a new run rotates the store to raw_runs_kept from the configuration', async () => {
  await withRawRoot(async (rawRoot) => {
    for (const runId of runIds) {
      await mkdir(join(rawRoot, runId));
    }
    const clock = fakeClock('2026-12-18T09:00:00.000Z');
    const session = await openFetchSession({
      origin: 'https://www.youfundceo.com',
      settings: fetcherSettings({
        raw_runs_kept: 6,
        max_consecutive_failures: 1,
      }),
      driver: {
        load: async () => ({ kind: 'error', message: 'offline', refused: [] }),
        close: async () => {},
      },
      clock,
      random: seededRandom(1),
      rawRoot,
    });
    assert.equal(session.runId, '20261218T090000Z');
    assert.deepEqual((await readdir(rawRoot)).sort(), [
      ...runIds.slice(-5),
      '20261218T090000Z',
    ]);
  });
});

test('run ids come from the clock, with a suffix for a second run in the same second', async () => {
  await withRawRoot(async (rawRoot) => {
    const now = new Date('2026-11-18T09:30:00.250Z');
    assert.equal(await createRun(rawRoot, now), '20261118T093000Z');
    assert.equal(await createRun(rawRoot, now), '20261118T093000Z-2');
    assert.equal(await createRun(rawRoot, now), '20261118T093000Z-3');
  });
});

test('the checkpoint round-trips and a corrupt one is refused, not trusted', async () => {
  await withRawRoot(async (rawRoot) => {
    const runId = await createRun(rawRoot, new Date('2026-11-18T09:30:00Z'));
    assert.equal(await readCheckpoint(rawRoot, runId), null);
    const checkpoint = {
      run_id: runId,
      origin: 'https://www.youfundceo.com',
      completed_units: ['SE', 'NO'],
      updated_at: '2026-11-18T09:45:00.000Z',
    };
    await writeCheckpoint(rawRoot, checkpoint);
    assert.deepEqual(await readCheckpoint(rawRoot, runId), checkpoint);
    await writeFile(join(rawRoot, runId, 'checkpoint.json'), '{"run_id":');
    await assert.rejects(readCheckpoint(rawRoot, runId), /not JSON/);
    await writeFile(
      join(rawRoot, runId, 'checkpoint.json'),
      JSON.stringify({ ...checkpoint, run_id: '20200101T000000Z' }),
    );
    await assert.rejects(
      readCheckpoint(rawRoot, runId),
      /not a checkpoint of this run/,
    );
  });
});

test('page file names follow the path, safely', () => {
  const origin = 'https://www.youfundceo.com';
  assert.equal(pageFileName(`${origin}/`), 'home.html');
  assert.equal(pageFileName(`${origin}/countries`), 'countries.html');
  assert.equal(
    pageFileName(`${origin}/services/netflix/sweden`),
    'services__netflix__sweden.html',
  );
  assert.equal(pageFileName(`${origin}/countries/`), 'countries.html');
  assert.equal(
    pageFileName(`${origin}/a/b?page=2&x=y`),
    'a__b__q-page_2_x_y.html',
  );
  // Dot segments are resolved by the URL parser, so nothing leaves pages/.
  assert.equal(pageFileName(`${origin}/%2e%2e/etc`), 'etc.html');
  assert.equal(pageFileName(`${origin}/a%2Fb`), 'a_2Fb.html');
});
