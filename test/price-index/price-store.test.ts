import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import * as prettier from 'prettier';

import type {
  LatestFile,
  PriceRecord,
} from '../../packages/price-index/src/schema/index.ts';
import {
  createJsonFileStore,
  PriceStoreError,
  serialisePriceIndexFile,
  writeFileAtomic,
  type AtomicWriteFs,
  type PriceStoreErrorCode,
} from '../../packages/price-index/src/storage/index.ts';

// E11.6-03: the JSON-file PriceStore. Writes are atomic, output is
// deterministic and passes Prettier, snapshots are never replaced, and the
// source's price text survives storage unchanged.

function record(overrides: Partial<PriceRecord> = {}): PriceRecord {
  return {
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    price_local: '149.00',
    price_source_text: 'kr\u00a0149',
    currency: 'SEK',
    price_usd_source: '15.79',
    source: 'scraper:youfundceo.com',
    source_url: 'https://www.youfundceo.com/services/spotify/sweden',
    observed_at: '2026-11-17T14:02:11Z',
    source_verified_at: '2026-11-04',
    status: 'ok',
    missing_reason: null,
    notes: null,
    ...overrides,
  };
}

function index(
  records: PriceRecord[],
  builtAt = '2026-12-01T09:30:00Z',
): LatestFile {
  return { built_at: builtAt, records };
}

const v1 = index([
  record(),
  record({
    market: 'US',
    price_local: '19.99',
    price_source_text: '$19.99 + tax',
    currency: 'USD',
    price_usd_source: '19.99',
    source_url: 'https://www.youfundceo.com/services/spotify/united-states',
  }),
  record({
    market: 'PL',
    service_id: 'adobe',
    plan_id: 'individual',
    price_local: '80.61',
    price_source_text: '€80.61 EUR',
    currency: 'EUR',
    price_usd_source: '93.97',
    status: 'needs_review',
    source_url: 'https://www.youfundceo.com/services/adobe/poland',
  }),
  record({
    market: 'IS',
    price_local: '1190',
    price_source_text: 'kr\u00a01,190',
    currency: 'ISK',
    price_usd_source: '9.46',
  }),
  record({
    market: 'FR',
    price_local: '11.99',
    price_source_text: '11,99\u202f€',
    currency: 'EUR',
    price_usd_source: '13.98',
  }),
  record({
    service_id: 'canva',
    plan_id: 'pro',
    price_local: null,
    price_source_text: null,
    currency: null,
    price_usd_source: null,
    source_url: null,
    source_verified_at: null,
    status: 'missing',
    missing_reason: 'not_on_source',
  }),
]);

const v2 = index(
  [record({ price_local: '159.00', price_source_text: 'kr\u00a0159' })],
  '2027-01-02T08:00:00Z',
);

async function scratch(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'price-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: PriceStoreErrorCode,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof PriceStoreError && error.code === code,
  );
}

const realFs: AtomicWriteFs = {
  open: fs.open,
  rename: fs.rename,
  link: fs.link,
  unlink: fs.unlink,
};

test('readLatest is null before the first write, then returns what was written', async (t) => {
  const directory = await scratch(t);
  const store = createJsonFileStore({ directory: join(directory, 'data') });
  assert.equal(await store.readLatest(), null);
  await store.writeLatest(v1);
  const read = await store.readLatest();
  assert.deepEqual(
    new Set(read?.records.map((r) => JSON.stringify(r))),
    new Set(v1.records.map((r) => JSON.stringify(r))),
  );
  assert.equal(read?.built_at, v1.built_at);
});

test('price_source_text round-trips the source text unchanged', async (t) => {
  const directory = await scratch(t);
  const store = createJsonFileStore({ directory });
  await store.writeLatest(v1);
  await store.writeSnapshot(v1, '2026-12-01');
  const texts = (file: LatestFile | null) =>
    new Map(
      file?.records.map((r) => [
        `${r.market}/${r.service_id}`,
        r.price_source_text,
      ]),
    );
  const expected = texts(v1);
  assert.deepEqual(texts(await store.readLatest()), expected);
  const snapshot = JSON.parse(
    await fs.readFile(join(directory, 'snapshots', '2026-12-01.json'), 'utf8'),
  ) as LatestFile;
  assert.deepEqual(texts(snapshot), expected);
  // The exact code points, including the no-break and narrow no-break spaces.
  assert.equal(expected.get('SE/spotify'), 'kr\u00a0149');
  assert.equal(expected.get('FR/spotify'), '11,99\u202f€');
  assert.equal(expected.get('US/spotify'), '$19.99 + tax');
});

test('serialising the same data twice gives byte-identical files that pass Prettier', async (t) => {
  const directory = await scratch(t);
  const store = createJsonFileStore({ directory });

  // The same data built in another order, with its keys in another order.
  const shuffled = index(
    [...v1.records]
      .reverse()
      .map(
        (r) =>
          Object.fromEntries(
            Object.entries(r).reverse(),
          ) as unknown as PriceRecord,
      ),
  );
  assert.equal(serialisePriceIndexFile(shuffled), serialisePriceIndexFile(v1));

  await store.writeLatest(v1);
  const first = await fs.readFile(join(directory, 'latest.json'));
  await store.writeLatest(shuffled);
  const second = await fs.readFile(join(directory, 'latest.json'));
  assert.ok(first.equals(second), 'latest.json changed with unchanged data');

  await store.writeSnapshot(v1, '2026-12-01');
  await store.writeSnapshot(shuffled, '2026-12-01');
  const snapshotA = await fs.readFile(
    join(directory, 'snapshots', '2026-12-01.json'),
  );
  const snapshotB = await fs.readFile(
    join(directory, 'snapshots', '2026-12-01-2.json'),
  );
  assert.ok(snapshotA.equals(first) && snapshotB.equals(first));

  const text = first.toString('utf8');
  assert.ok(
    text.endsWith('}\n') && !text.endsWith('\n\n'),
    'one trailing newline',
  );
  assert.match(
    text,
    /^\{\n {2}"built_at"/,
    'two-space indentation, built_at first',
  );
  // Records in identity order: service, plan, period, then market.
  const parsed = JSON.parse(text) as LatestFile;
  assert.deepEqual(
    parsed.records.map((r) => `${r.service_id}/${r.market}`),
    [
      'adobe/PL',
      'canva/SE',
      'spotify/FR',
      'spotify/IS',
      'spotify/SE',
      'spotify/US',
    ],
  );
  assert.deepEqual(Object.keys(parsed.records[0]).slice(0, 4), [
    'market',
    'service_id',
    'plan_id',
    'billing_period',
  ]);

  for (const path of [
    'data/price-index/latest.json',
    'data/price-index/snapshots/2026-12-01.json',
  ]) {
    const options = (await prettier.resolveConfig(path)) ?? {};
    assert.ok(
      await prettier.check(text, { ...options, filepath: path }),
      `${path} would fail npm run format`,
    );
  }
  for (const file of [index([]), v2]) {
    const options =
      (await prettier.resolveConfig('data/price-index/latest.json')) ?? {};
    assert.ok(
      await prettier.check(serialisePriceIndexFile(file), {
        ...options,
        filepath: 'data/price-index/latest.json',
      }),
    );
  }
});

test('a failure injected between the temporary write and the rename leaves latest.json byte-identical', async (t) => {
  const directory = await scratch(t);
  await createJsonFileStore({ directory }).writeLatest(v1);
  const before = await fs.readFile(join(directory, 'latest.json'));

  let renamed = 0;
  const crashing = createJsonFileStore({
    directory,
    fs: {
      ...realFs,
      rename: async (from, to) => {
        renamed += 1;
        // The flushed temporary file is complete when the crash comes.
        assert.equal(
          await fs.readFile(from, 'utf8'),
          serialisePriceIndexFile(v2),
        );
        assert.equal(String(to), join(directory, 'latest.json'));
        throw Object.assign(new Error('injected crash'), { code: 'EIO' });
      },
    },
  });
  await assert.rejects(crashing.writeLatest(v2), /injected crash/);
  assert.equal(renamed, 1);
  assert.ok((await fs.readFile(join(directory, 'latest.json'))).equals(before));
  assert.deepEqual(
    await fs.readdir(directory),
    ['latest.json'],
    'temporary file removed',
  );

  // A failure while flushing the temporary file is no different.
  const failingSync = createJsonFileStore({
    directory,
    fs: {
      ...realFs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        handle.sync = async () => {
          throw new Error('injected flush failure');
        };
        return handle;
      },
    },
  });
  await assert.rejects(failingSync.writeLatest(v2), /injected flush failure/);
  assert.ok((await fs.readFile(join(directory, 'latest.json'))).equals(before));
  assert.deepEqual(await fs.readdir(directory), ['latest.json']);
});

test('a process killed before the rename leaves latest.json byte-identical', async (t) => {
  const directory = await scratch(t);
  const store = createJsonFileStore({ directory });
  await store.writeLatest(v1);
  await store.writeSnapshot(v1, '2026-12-01');
  const before = await fs.readFile(join(directory, 'latest.json'));
  const snapshotBefore = await fs.readFile(
    join(directory, 'snapshots', '2026-12-01.json'),
  );

  for (const kind of ['latest', 'snapshot']) {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/helpers/price-index-crash-write.ts',
        directory,
        kind,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL', `${kind}: ${child.stderr}`);
  }

  assert.ok((await fs.readFile(join(directory, 'latest.json'))).equals(before));
  assert.deepEqual(
    await store.readLatest(),
    JSON.parse(before.toString('utf8')),
  );
  assert.ok(
    (await fs.readFile(join(directory, 'snapshots', '2026-12-01.json'))).equals(
      snapshotBefore,
    ),
  );
  assert.deepEqual(
    (await store.listSnapshots()).map((ref) => ref.name),
    ['2026-12-01.json'],
    'the crashed snapshot never took a name',
  );

  // The crash left its flushed temporary files behind; git ignores them.
  const leftovers = [
    ...(await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')),
    ...(await fs.readdir(join(directory, 'snapshots')))
      .filter((name) => name.endsWith('.tmp'))
      .map((name) => `snapshots/${name}`),
  ];
  assert.equal(leftovers.length, 2, JSON.stringify(leftovers));
  for (const leftover of leftovers) {
    execFileSync('git', ['check-ignore', '-q', `data/price-index/${leftover}`]);
  }
});

test('invalid data is refused before anything is written', async (t) => {
  const directory = await scratch(t);
  const store = createJsonFileStore({ directory });
  await store.writeLatest(v1);
  const before = await fs.readFile(join(directory, 'latest.json'));

  const withFx = index([
    { ...record(), fx: '0.094' } as unknown as PriceRecord,
  ]);
  const withFloat = index([record({ price_local: 149 as unknown as string })]);
  for (const bad of [withFx, withFloat, index([record(), record()])]) {
    await rejectsWith(store.writeLatest(bad), 'invalid_data');
    await rejectsWith(store.writeSnapshot(bad, '2026-12-01'), 'invalid_data');
  }
  assert.ok((await fs.readFile(join(directory, 'latest.json'))).equals(before));
  assert.deepEqual(await fs.readdir(directory), ['latest.json']);
});

test('readLatest refuses a file that is not JSON or not valid', async (t) => {
  const directory = await scratch(t);
  const store = createJsonFileStore({ directory });
  await fs.writeFile(join(directory, 'latest.json'), '{"built_at":');
  await rejectsWith(store.readLatest(), 'not_json');
  await fs.writeFile(
    join(directory, 'latest.json'),
    JSON.stringify({ ...v1, records: [{ ...record(), fx: '1' }] }),
  );
  await rejectsWith(store.readLatest(), 'invalid_data');
});

test('an existing snapshot is never replaced, and an overwrite attempt fails', async (t) => {
  const directory = await scratch(t);
  const store = createJsonFileStore({ directory });
  const first = await store.writeSnapshot(v1, '2026-12-01');
  assert.deepEqual(first, {
    name: '2026-12-01.json',
    date: '2026-12-01',
    sequence: 1,
  });
  const path = join(directory, 'snapshots', '2026-12-01.json');
  const before = await fs.readFile(path);

  // A same-date second build takes the next suffix.
  const second = await store.writeSnapshot(v2, '2026-12-01');
  assert.deepEqual(second, {
    name: '2026-12-01-2.json',
    date: '2026-12-01',
    sequence: 2,
  });
  assert.ok((await fs.readFile(path)).equals(before));

  // Writing over the snapshot's own name fails and changes nothing.
  await assert.rejects(
    writeFileAtomic(path, serialisePriceIndexFile(v2), { mode: 'create' }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'EEXIST',
  );
  assert.ok((await fs.readFile(path)).equals(before));
  assert.deepEqual(
    (await fs.readdir(join(directory, 'snapshots'))).sort(),
    ['2026-12-01-2.json', '2026-12-01.json'],
    'no temporary file left behind',
  );

  // Another writer takes the free number between this writer's listing and
  // its link. The exclusive link refuses, the rival's file is kept, and this
  // writer takes the next number.
  const rival = join(directory, 'snapshots', '2026-12-01-3.json');
  let linked = 0;
  const raced = createJsonFileStore({
    directory,
    fs: {
      ...realFs,
      link: async (from, to) => {
        linked += 1;
        if (String(to) === rival) {
          await fs.writeFile(rival, 'rival\n');
        }
        return fs.link(from, to);
      },
    },
  });
  const third = await raced.writeSnapshot(v2, '2026-12-01');
  assert.equal(third.name, '2026-12-01-4.json');
  assert.equal(linked, 2);
  assert.equal(await fs.readFile(rival, 'utf8'), 'rival\n');
  assert.ok((await fs.readFile(path)).equals(before));
});

test('concurrent snapshots on one date each get their own file', async (t) => {
  const directory = await scratch(t);
  const writers = Array.from({ length: 6 }, (_, i) =>
    createJsonFileStore({ directory }).writeSnapshot(
      index([record({ price_local: `${150 + i}.00` })]),
      '2026-12-01',
    ),
  );
  const refs = await Promise.all(writers);
  assert.deepEqual(
    refs.map((ref) => ref.sequence).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6],
  );
  const prices = await Promise.all(
    refs.map(async (ref) => {
      const file = JSON.parse(
        await fs.readFile(join(directory, 'snapshots', ref.name), 'utf8'),
      ) as LatestFile;
      return file.records[0].price_local;
    }),
  );
  assert.equal(new Set(prices).size, 6, 'one writer replaced another');
});

test('listSnapshots lists snapshots oldest first and ignores everything else', async (t) => {
  const directory = await scratch(t);
  const store = createJsonFileStore({ directory });
  assert.deepEqual(await store.listSnapshots(), []);
  const snapshots = join(directory, 'snapshots');
  await fs.mkdir(snapshots);
  for (const name of [
    '2027-01-02.json',
    '2026-12-01-10.json',
    '2026-12-01.json',
    '2026-12-01-2.json',
    '2026-12-01-1.json',
    '2026-12-01-02.json',
    '2026-02-30.json',
    'notes.md',
    '.2026-12-01.json.77-1.tmp',
  ]) {
    await fs.writeFile(join(snapshots, name), '{}');
  }
  assert.deepEqual(
    (await store.listSnapshots()).map((ref) => [ref.name, ref.sequence]),
    [
      ['2026-12-01.json', 1],
      ['2026-12-01-2.json', 2],
      ['2026-12-01-10.json', 10],
      ['2027-01-02.json', 1],
    ],
  );
  const next = await store.writeSnapshot(v1, '2026-12-01');
  assert.equal(next.name, '2026-12-01-11.json');
});

test('a snapshot date must be a real YYYY-MM-DD date', async (t) => {
  const directory = await scratch(t);
  const store = createJsonFileStore({ directory });
  for (const date of [
    '2026-12-1',
    '2026-13-01',
    '2026-02-30',
    '01-12-2026',
    '2026-12-01T00:00:00Z',
    '../x',
  ]) {
    await rejectsWith(store.writeSnapshot(v1, date), 'invalid_date');
  }
  assert.deepEqual(await store.listSnapshots(), []);
});
