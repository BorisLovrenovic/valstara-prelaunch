import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  BrowserDriver,
  LoadRequest,
  LoadResult,
} from '../../packages/price-index/src/http/driver.ts';
import {
  fetchUnits,
  openFetchSession,
  type FetchReport,
  type FetchSessionOptions,
} from '../../packages/price-index/src/http/fetcher.ts';
import { seededRandom } from '../../packages/price-index/src/http/random.ts';
import { readCheckpoint } from '../../packages/price-index/src/http/raw-store.ts';
import type { FetcherSettings } from '../../packages/price-index/src/schema/price-index-settings.ts';
import {
  fakeClock,
  fetcherSettings,
  type FakeClock,
} from '../helpers/price-index-fetcher.ts';

// E11.6-04: the fetcher's politeness, backoff, stop and resume, with an
// injected fake driver, an injected clock and a seeded random source. The
// real browser against a local fake server is in fetcher-browser.test.ts.

const origin = 'https://www.youfundceo.com';
const robotsUrl = `${origin}/robots.txt`;
const pageLoadMilliseconds = 1_500;

type Answer = Partial<Extract<LoadResult, { kind: 'loaded' }>> | LoadResult;

interface LoadLog {
  url: string;
  read: LoadRequest['read'];
  startedAt: number;
  endedAt: number;
}

/**
 * A driver that answers from a script: per URL, a list of answers used in
 * turn (the last one repeats). Unlisted URLs answer 200. It records every
 * load with the clock's time, and fails the test on a second load in flight.
 */
function fakeDriver(
  clock: FakeClock,
  script: Record<string, Answer[]> = {},
  robots = 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /go/\n',
) {
  const loads: LoadLog[] = [];
  const served = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const driver: BrowserDriver = {
    async load(request): Promise<LoadResult> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const startedAt = clock.now().getTime();
      await Promise.resolve();
      clock.advance(pageLoadMilliseconds);
      inFlight -= 1;
      loads.push({
        url: request.url,
        read: request.read,
        startedAt,
        endedAt: clock.now().getTime(),
      });
      const answers = script[request.url];
      const index = served.get(request.url) ?? 0;
      served.set(request.url, index + 1);
      const answer = answers?.[Math.min(index, answers.length - 1)];
      if (
        answer !== undefined &&
        'kind' in answer &&
        answer.kind !== 'loaded'
      ) {
        return answer as LoadResult;
      }
      return {
        kind: 'loaded',
        status: 200,
        finalUrl: request.url,
        checkpoint: false,
        retryAfter: null,
        content:
          request.url === robotsUrl
            ? robots
            : `<html><title>${request.url}</title></html>`,
        refused: [],
        ...answer,
      } as LoadResult;
    },
    async close() {},
  };
  return {
    driver,
    loads,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

async function withRawRoot<T>(
  work: (rawRoot: string) => Promise<T>,
): Promise<T> {
  const rawRoot = await mkdtemp(join(tmpdir(), 'valstara-price-index-raw-'));
  try {
    return await work(rawRoot);
  } finally {
    await rm(rawRoot, { recursive: true, force: true });
  }
}

function options(
  rawRoot: string,
  clock: FakeClock,
  driver: BrowserDriver,
  overrides: Partial<FetchSessionOptions> & { settings?: FetcherSettings } = {},
): FetchSessionOptions {
  return {
    origin,
    settings: fetcherSettings(),
    driver,
    clock,
    random: seededRandom(20261118),
    rawRoot,
    ...overrides,
  };
}

const units = [
  { id: 'SE', paths: ['/countries/sweden', '/services/netflix/sweden'] },
  { id: 'NO', paths: ['/countries/norway', '/services/netflix/norway'] },
  { id: 'DK', paths: ['/countries/denmark', '/services/netflix/denmark'] },
  { id: 'FI', paths: ['/countries/finland', '/services/netflix/finland'] },
];

function gaps(loads: LoadLog[]): number[] {
  return loads
    .slice(1)
    .map((load, index) => load.startedAt - loads[index]!.endedAt);
}

test('robots.txt is read first, as sent, and pages are stored as rendered with a report', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(clock);
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver),
    );
    const report = await fetchUnits(session, units.slice(0, 1));

    assert.deepEqual(
      fake.loads.map(({ url, read }) => [url, read]),
      [
        [robotsUrl, 'body'],
        [`${origin}/countries/sweden`, 'rendered'],
        [`${origin}/services/netflix/sweden`, 'rendered'],
      ],
    );
    const run = join(rawRoot, session.runId);
    assert.match(
      await readFile(join(run, 'robots.txt'), 'utf8'),
      /Disallow: \/api\//,
    );
    assert.equal(
      await readFile(
        join(run, 'pages', 'services__netflix__sweden.html'),
        'utf8',
      ),
      `<html><title>${origin}/services/netflix/sweden</title></html>`,
    );
    assert.equal(report.status, 'completed');
    assert.equal(report.exit_code, 0);
    assert.deepEqual(report.completed_units, ['SE']);
    assert.deepEqual(
      JSON.parse(await readFile(join(run, 'fetch-report.json'), 'utf8')),
      report,
    );
    assert.equal(session.runId, '20261118T093000Z');
  });
});

test('the delay between pages is a seeded 8–20 s jitter when there is no Crawl-delay', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(clock);
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver),
    );
    await fetchUnits(session, units);
    const between = gaps(fake.loads);
    assert.equal(between.length, 8);
    for (const gap of between) {
      assert.ok(gap >= 8_000 && gap <= 20_000, `gap ${gap}`);
    }
    assert.ok(new Set(between).size > 1, 'the delay is randomised');

    // The same seed draws the same delays.
    const again = fakeClock();
    const replay = fakeDriver(again);
    await fetchUnits(
      await openFetchSession(options(rawRoot, again, replay.driver)),
      units,
    );
    assert.deepEqual(gaps(replay.loads), between);
  });
});

for (const [crawlDelay, floor] of [
  ['12', 12_000],
  ['30', 30_000],
  ['2.5', 8_000],
] as const) {
  test(`with Crawl-delay ${crawlDelay}, every gap is at least ${floor / 1000} s, the larger of it and the jitter floor`, async () => {
    await withRawRoot(async (rawRoot) => {
      const clock = fakeClock();
      const fake = fakeDriver(
        clock,
        {},
        `User-agent: *\nDisallow: /api/\nCrawl-delay: ${crawlDelay}\n`,
      );
      const session = await openFetchSession(
        options(rawRoot, clock, fake.driver),
      );
      const report = await fetchUnits(session, units);
      assert.equal(report.status, 'completed');
      const between = gaps(fake.loads);
      assert.equal(between.length, 8);
      for (const gap of between) {
        assert.ok(gap >= floor, `gap ${gap} < ${floor}`);
      }
      if (floor === 30_000) {
        // Longer than any jitter draw, so Crawl-delay is the delay.
        assert.deepEqual(new Set(between), new Set([30_000]));
      }
    });
  });
}

test('a 429 backs off exponentially from the configuration, then the page loads', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const target = `${origin}/countries/sweden`;
    const fake = fakeDriver(clock, {
      [target]: [{ status: 429 }, { status: 503 }, { status: 200 }],
    });
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver),
    );
    const report = await fetchUnits(session, units.slice(0, 1));
    assert.equal(report.status, 'completed');
    const [first, second] = gaps(fake.loads).slice(1, 3);
    assert.equal(first, 60_000, 'initial_seconds after the first failure');
    assert.equal(second, 120_000, 'times the multiplier after the second');
    assert.equal(report.pages[1]!.attempts, 3);
  });
});

test('the backoff is capped at max_seconds', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const target = `${origin}/countries/sweden`;
    const fake = fakeDriver(clock, {
      [target]: [
        { status: 500 },
        { status: 500 },
        { status: 500 },
        { status: 500 },
        { status: 200 },
      ],
    });
    const settings = fetcherSettings({
      backoff: {
        initial_seconds: 60,
        multiplier: 3,
        max_seconds: 200,
        retry_after_max_seconds: 3600,
      },
      max_consecutive_failures: 5,
    });
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver, { settings }),
    );
    await fetchUnits(session, units.slice(0, 1));
    assert.deepEqual(
      gaps(fake.loads).slice(1, 5),
      [60_000, 180_000, 200_000, 200_000],
    );
  });
});

test('Retry-After is honoured when longer than the backoff, as seconds or an HTTP date', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const target = `${origin}/countries/sweden`;
    const fake = fakeDriver(clock, {
      [target]: [
        { status: 429, retryAfter: '300' },
        // The clock reads 09:36:xx here; ten minutes on, as an HTTP date.
        { status: 429, retryAfter: 'Wed, 18 Nov 2026 09:50:00 GMT' },
        { status: 429, retryAfter: '5' },
        { status: 200 },
      ],
    });
    const settings = fetcherSettings({ max_consecutive_failures: 4 });
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver, { settings }),
    );
    await fetchUnits(session, units.slice(0, 1));
    const waits = gaps(fake.loads).slice(1, 4);
    assert.equal(waits[0], 300_000, 'Retry-After 300 beats a 60 s backoff');
    const secondEnded = fake.loads[2]!.endedAt;
    assert.equal(
      waits[1],
      Date.parse('2026-11-18T09:50:00Z') - secondEnded,
      'an HTTP date is waited for',
    );
    assert.equal(
      waits[2],
      240_000,
      'a short Retry-After never shortens the backoff',
    );
  });
});

test('a Retry-After longer than the configured maximum stops the run instead of waiting', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(clock, {
      [`${origin}/countries/norway`]: [{ status: 429, retryAfter: '86400' }],
    });
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver),
    );
    const report = await fetchUnits(session, units);
    assert.equal(report.status, 'stopped_by_source');
    assert.equal(report.exit_code, 2);
    assert.equal(report.stop?.reason, 'retry_after_too_long');
    assert.equal(fake.loads.at(-1)!.url, `${origin}/countries/norway`);
    assert.deepEqual(report.completed_units, ['SE']);
  });
});

test('a too-long Retry-After on the failure that reaches the limit still stops as retry_after_too_long', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const target = `${origin}/countries/sweden`;
    const fake = fakeDriver(clock, {
      [target]: [
        { status: 429, retryAfter: '5' },
        { status: 429, retryAfter: '5' },
        { status: 429, retryAfter: '86400' },
      ],
    });
    const settings = fetcherSettings({ max_consecutive_failures: 3 });
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver, { settings }),
    );
    const report = await fetchUnits(session, units);
    assert.equal(report.status, 'stopped_by_source');
    assert.deepEqual(report.stop, {
      reason: 'retry_after_too_long',
      url: target,
      consecutive_failures: 3,
      detail:
        'the source asked for a 86400 s wait, more than the configured 3600 s',
    });
    assert.equal(fake.loads.filter((load) => load.url === target).length, 3);
  });
});

test('a page still showing the checkpoint counts as a failure, and three in a row stop the run, leaving the checkpoint', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const stuck = `${origin}/services/netflix/norway`;
    const fake = fakeDriver(clock, {
      [stuck]: [{ status: 200, checkpoint: true }],
    });
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver),
    );
    const report: FetchReport = await fetchUnits(session, units);

    assert.equal(report.status, 'stopped_by_source');
    assert.equal(report.exit_code, 2);
    assert.deepEqual(report.stop, {
      reason: 'source_refused',
      url: stuck,
      consecutive_failures: 3,
      detail:
        '3 consecutive failures; the last was 200, still the bot checkpoint',
    });
    assert.equal(fake.loads.filter((load) => load.url === stuck).length, 3);
    assert.equal(fake.loads.at(-1)!.url, stuck, 'nothing loads after the stop');
    // SE is checkpointed; NO, stopped part-way, is not.
    assert.deepEqual(report.completed_units, ['SE']);
    const checkpoint = await readCheckpoint(rawRoot, session.runId);
    assert.deepEqual(checkpoint?.completed_units, ['SE']);
    assert.equal(
      await session.runUnit('DK', async () => {}),
      'stopped',
      'no unit runs once the run has stopped',
    );
  });
});

test('every refusal kind counts as a failure: 403, 429, 5xx, timeout, browser error, checkpoint', async () => {
  for (const answer of [
    { status: 403 },
    { status: 429 },
    { status: 500 },
    { status: 502 },
    { kind: 'timeout', message: 'Timeout 60000ms exceeded', refused: [] },
    { kind: 'error', message: 'net::ERR_CONNECTION_RESET', refused: [] },
    { status: 429, checkpoint: true },
  ] as Answer[]) {
    await withRawRoot(async (rawRoot) => {
      const clock = fakeClock();
      const fake = fakeDriver(clock, {
        [`${origin}/countries/sweden`]: [answer],
      });
      const report = await fetchUnits(
        await openFetchSession(options(rawRoot, clock, fake.driver)),
        units,
      );
      assert.equal(report.status, 'stopped_by_source', JSON.stringify(answer));
      assert.deepEqual(report.completed_units, []);
    });
  }
});

test('failures must be consecutive: a success in between resets the count', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(clock, {
      [`${origin}/countries/sweden`]: [
        { status: 503 },
        { status: 503 },
        { status: 200 },
      ],
      [`${origin}/services/netflix/sweden`]: [
        { status: 503 },
        { status: 503 },
        { status: 200 },
      ],
    });
    const report = await fetchUnits(
      await openFetchSession(options(rawRoot, clock, fake.driver)),
      units.slice(0, 1),
    );
    assert.equal(report.status, 'completed');
    // Each page backs off from the start again: 60 s, then 120 s.
    assert.deepEqual(gaps(fake.loads).slice(4, 6), [60_000, 120_000]);
  });
});

test('a 404 is recorded as not found, is not a failure, and stores no page', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(clock, {
      [`${origin}/countries/sweden`]: [{ status: 404 }],
      [`${origin}/countries/norway`]: [{ status: 404 }],
      [`${origin}/countries/denmark`]: [{ status: 404 }],
    });
    const report = await fetchUnits(
      await openFetchSession(options(rawRoot, clock, fake.driver)),
      units,
    );
    assert.equal(report.status, 'completed');
    assert.equal(
      report.pages.filter((page) => page.outcome === 'not_found').length,
      3,
    );
    const files = await readdir(join(rawRoot, report.run_id, 'pages'));
    assert.ok(!files.includes('countries__sweden.html'));
    assert.ok(files.includes('services__netflix__sweden.html'));
  });
});

test('a resumed run fetches only what is not yet checkpointed, with the robots.txt it started with', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const stuck = `${origin}/services/netflix/denmark`;
    const first = fakeDriver(clock, { [stuck]: [{ status: 429 }] });
    const stopped = await fetchUnits(
      await openFetchSession(options(rawRoot, clock, first.driver)),
      units,
    );
    assert.deepEqual(stopped.completed_units, ['SE', 'NO']);

    const later = fakeClock('2026-11-18T12:00:00.000Z');
    const second = fakeDriver(later);
    const session = await openFetchSession(
      options(rawRoot, later, second.driver, { resumeRunId: stopped.run_id }),
    );
    const report = await fetchUnits(session, units);

    assert.deepEqual(
      second.loads.map((load) => load.url),
      [
        `${origin}/countries/denmark`,
        `${origin}/services/netflix/denmark`,
        `${origin}/countries/finland`,
        `${origin}/services/netflix/finland`,
      ],
      'no robots.txt, no SE and no NO page is requested again',
    );
    assert.equal(report.run_id, stopped.run_id);
    assert.equal(report.resumed, true);
    assert.equal(report.status, 'completed');
    assert.deepEqual(report.skipped_units, ['SE', 'NO']);
    assert.deepEqual(report.completed_units, ['SE', 'NO', 'DK', 'FI']);
    assert.deepEqual(
      (await readCheckpoint(rawRoot, stopped.run_id))?.completed_units,
      ['SE', 'NO', 'DK', 'FI'],
    );
    // The first page of a resumed run is the session's first load: no wait.
    assert.equal(later.sleeps.length, 3);
  });
});

test('a resume of an unknown run, or of another origin’s run, is refused', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(clock);
    await assert.rejects(
      openFetchSession(
        options(rawRoot, clock, fake.driver, {
          resumeRunId: '20261101T000000Z',
        }),
      ),
      /no raw run 20261101T000000Z/,
    );
    await assert.rejects(
      openFetchSession(
        options(rawRoot, clock, fake.driver, { resumeRunId: '../escape' }),
      ),
      /not a run id/,
    );
    const done = await fetchUnits(
      await openFetchSession(options(rawRoot, clock, fake.driver)),
      units.slice(0, 1),
    );
    await assert.rejects(
      openFetchSession(
        options(rawRoot, clock, fake.driver, {
          origin: 'http://127.0.0.1:9',
          resumeRunId: done.run_id,
        }),
      ),
      /fetched https:\/\/www\.youfundceo\.com/,
    );
  });
});

test('another host, /api/, /go/ and a robots-disallowed path are refused before a page is opened', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(
      clock,
      {},
      'User-agent: *\nAllow: /\nDisallow: /private/\n',
    );
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver),
    );
    const outcomes: unknown[] = [];
    await session.runUnit('SE', async (fetchPage) => {
      for (const target of [
        'https://example.com/countries/sweden',
        'http://www.youfundceo.com/countries/sweden',
        'https://youfundceo.com/countries/sweden',
        '/api/prices',
        '/go/netflix',
        `${origin}/go/netflix?x=1`,
        '/private/page',
      ]) {
        outcomes.push(await fetchPage(target));
      }
    });
    assert.deepEqual(
      outcomes.map((outcome) => (outcome as { reason: string }).reason),
      [
        'other_host',
        'other_host',
        'other_host',
        'disallowed_path',
        'disallowed_path',
        'disallowed_path',
        'disallowed_path',
      ],
    );
    assert.deepEqual(
      fake.loads.map((load) => load.url),
      [robotsUrl],
      'only robots.txt was ever opened',
    );
    assert.deepEqual(clock.sleeps, [], 'a refusal waits for nothing');
  });
});

test('one page at a time, by construction: a second load in flight is refused', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(clock);
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver),
    );
    await session.runUnit('SE', async (fetchPage) => {
      const results = await Promise.allSettled([
        fetchPage('/countries/sweden'),
        fetchPage('/countries/norway'),
      ]);
      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[1].status, 'rejected');
      assert.match(
        String((results[1] as PromiseRejectedResult).reason),
        /one at a time/,
      );
    });
    await assert.rejects(
      session.runUnit('NO', () =>
        session.runUnit('DK', async () => {}).then(() => {}),
      ),
      /one at a time/,
    );
    assert.equal(fake.maxInFlight, 1);
  });
});

test('fetchPage outside a unit is refused', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(clock);
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver),
    );
    let escaped: ((path: string) => Promise<unknown>) | undefined;
    await session.runUnit('SE', async (fetchPage) => {
      escaped = fetchPage;
    });
    await assert.rejects(
      escaped!('/countries/sweden'),
      /only available inside runUnit/,
    );
  });
});

test('an interrupt stops the run cleanly as interrupted, leaving the checkpoint', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const controller = new AbortController();
    const fake = fakeDriver(clock);
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver, { signal: controller.signal }),
    );
    await session.runUnit('SE', async (fetchPage) => {
      await fetchPage('/countries/sweden');
      await fetchPage('/services/netflix/sweden');
    });
    await session.runUnit('NO', async (fetchPage) => {
      await fetchPage('/countries/norway');
      controller.abort();
      await fetchPage('/services/netflix/norway');
    });
    const report: FetchReport = await session.finish();
    assert.equal(report.status, 'interrupted');
    assert.equal(report.exit_code, 4);
    assert.equal(report.stop?.reason, 'interrupted');
    assert.deepEqual(report.completed_units, ['SE']);
    assert.equal(fake.loads.at(-1)!.url, `${origin}/countries/norway`);
  });
});

test('a missing robots.txt means no rules, but /api/ and /go/ stay refused', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(clock, {
      [robotsUrl]: [{ status: 404, content: 'Not found' }],
    });
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver),
    );
    assert.deepEqual(session.robots.rules, []);
    await session.runUnit('SE', async (fetchPage) => {
      assert.equal((await fetchPage('/api/x')).outcome, 'refused');
      assert.equal((await fetchPage('/anything')).outcome, 'ok');
    });
    assert.equal(
      await readFile(join(rawRoot, session.runId, 'robots.txt'), 'utf8'),
      '',
    );
  });
});

test('a robots.txt the source refuses three times stops the run before any page', async () => {
  await withRawRoot(async (rawRoot) => {
    const clock = fakeClock();
    const fake = fakeDriver(clock, { [robotsUrl]: [{ status: 429 }] });
    const session = await openFetchSession(
      options(rawRoot, clock, fake.driver),
    );
    const report = await fetchUnits(session, units);
    assert.equal(report.status, 'stopped_by_source');
    assert.equal(report.stop?.url, robotsUrl);
    assert.deepEqual(
      fake.loads.map((load) => load.url),
      [robotsUrl, robotsUrl, robotsUrl],
    );
    await assert.rejects(stat(join(rawRoot, session.runId, 'checkpoint.json')));
  });
});
