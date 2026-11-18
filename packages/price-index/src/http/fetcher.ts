import type { FetcherSettings } from '../schema/price-index-settings.ts';
import { backoffMilliseconds, retryAfterMilliseconds } from './backoff.ts';
import type { Clock } from './clock.ts';
import type { BrowserDriver, LoadResult } from './driver.ts';
import type { Random } from './random.ts';
import {
  createRun,
  openRun,
  readCheckpoint,
  readRobots,
  rotateRuns,
  writeCheckpoint,
  writePage,
  writeReport,
  writeRobots,
} from './raw-store.ts';
import { isPathOpenable, type RefusalReason } from './request-rule.ts';
import { noRobotsRules, parseRobots, type RobotsRules } from './robots.ts';

// The fetcher (E11.6-04). One run, one browser context, one page at a time:
// every load waits for the one before it, with a seeded jitter (or the
// source's Crawl-delay, if longer) between them. A refusal (403, 429, 5xx, a
// timeout, or the bot checkpoint still showing after its time to complete)
// backs off exponentially, honouring Retry-After, and the configured number
// of consecutive failures stops the run cleanly. A checkpoint after each
// unit (a market) lets a stopped or interrupted run resume where it stopped.
// It makes no conditional request (E11.6-04 founder decision 2 of 2026-11-18).

export type StopReason =
  'source_refused' | 'retry_after_too_long' | 'interrupted';

export type RunStatus = 'completed' | 'stopped_by_source' | 'interrupted';

/** The process exit codes the plan documents (E11.6-07 maps them). */
export const fetchExitCodes: Record<RunStatus, number> = {
  completed: 0,
  stopped_by_source: 2,
  interrupted: 4,
};

export class FetchStoppedError extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason, message: string) {
    super(message);
    this.name = 'FetchStoppedError';
    this.reason = reason;
  }
}

export type FetchedPage =
  | { outcome: 'ok'; url: string; status: number; file: string; html: string }
  | { outcome: 'not_found' | 'http_error'; url: string; status: number }
  | { outcome: 'refused'; url: string; reason: RefusalReason };

/** Loads one page of the current unit. Throws FetchStoppedError once the run stops. */
export type FetchPage = (pathOrUrl: string) => Promise<FetchedPage>;

export interface PageRecord {
  unit: string | null;
  url: string;
  outcome: FetchedPage['outcome'];
  status: number | null;
  attempts: number;
  file: string | null;
  reason: RefusalReason | null;
}

export interface StopRecord {
  reason: StopReason;
  url: string | null;
  consecutive_failures: number;
  detail: string;
}

export interface FetchReport {
  run_id: string;
  origin: string;
  status: RunStatus;
  exit_code: number;
  resumed: boolean;
  started_at: string;
  finished_at: string;
  crawl_delay_milliseconds: number | null;
  completed_units: string[];
  skipped_units: string[];
  pages: PageRecord[];
  refused_browser_requests: Partial<Record<RefusalReason, number>>;
  stop: StopRecord | null;
}

export interface FetchSessionOptions {
  /** The source's origin: `settings.source_origin` in a real run. */
  origin: string;
  settings: FetcherSettings;
  driver: BrowserDriver;
  clock: Clock;
  random: Random;
  /** The raw store's root, `<repository>/data/raw` in a real run. */
  rawRoot: string;
  /** An earlier run to resume; a new run is created without one. */
  resumeRunId?: string;
  /** Aborting it stops the run cleanly, as `interrupted`. */
  signal?: AbortSignal;
}

export interface FetchSession {
  readonly runId: string;
  readonly robots: RobotsRules;
  /** Units completed by this run, including those before a resume. */
  isCompleted(unitId: string): boolean;
  /**
   * Runs one unit's work. A unit already checkpointed is skipped without a
   * request. Once `work` finishes, the unit is checkpointed. If the run stops
   * inside it, it is not, so a resume fetches it again.
   */
  runUnit(
    unitId: string,
    work: (fetchPage: FetchPage) => Promise<void>,
  ): Promise<'completed' | 'skipped' | 'stopped'>;
  /** Writes the run's report into the raw store and returns it. */
  finish(): Promise<FetchReport>;
}

function isFailure(result: LoadResult): boolean {
  if (result.kind !== 'loaded') {
    return true;
  }
  return (
    result.checkpoint ||
    result.status === 403 ||
    result.status === 429 ||
    result.status >= 500
  );
}

function describe(result: LoadResult): string {
  if (result.kind !== 'loaded') {
    return `${result.kind}: ${result.message}`;
  }
  return result.checkpoint
    ? `${result.status}, still the bot checkpoint`
    : `HTTP ${result.status}`;
}

export async function openFetchSession(
  options: FetchSessionOptions,
): Promise<FetchSession> {
  const { origin, settings, driver, clock, random, rawRoot, signal } = options;
  const startedAt = clock.now();
  const resumed = options.resumeRunId !== undefined;

  const completed: string[] = [];
  let runId: string;
  if (options.resumeRunId !== undefined) {
    runId = options.resumeRunId;
    await openRun(rawRoot, runId);
    const checkpoint = await readCheckpoint(rawRoot, runId);
    if (checkpoint !== null) {
      if (checkpoint.origin !== origin) {
        throw new Error(
          `run ${runId} fetched ${checkpoint.origin}, not ${origin}`,
        );
      }
      completed.push(...checkpoint.completed_units);
    }
  } else {
    runId = await createRun(rawRoot, startedAt);
  }
  await rotateRuns(rawRoot, settings.raw_runs_kept, runId);

  const pages: PageRecord[] = [];
  const skipped: string[] = [];
  const refusedBrowserRequests: Partial<Record<RefusalReason, number>> = {};
  let stop: StopRecord | null = null;
  let consecutiveFailures = 0;
  let loadsMade = 0;
  let loading = false;
  let activeUnit: string | null = null;
  let robots: RobotsRules = noRobotsRules;
  let robotsKnown = false;

  function halt(reason: StopReason, url: string | null, detail: string): never {
    stop ??= { reason, url, consecutive_failures: consecutiveFailures, detail };
    throw new FetchStoppedError(stop.reason, stop.detail);
  }

  function checkInterrupted(url: string | null): void {
    if (signal?.aborted) {
      halt('interrupted', url, 'the run was interrupted');
    }
  }

  /** The randomised delay before a page: jitter, or Crawl-delay if longer. */
  function politeDelay(): number {
    const { min, max } = settings.jitter_seconds;
    const span = (max - min) * 1000;
    const jitter = min * 1000 + Math.floor(random() * (span + 1));
    return Math.max(jitter, robots.crawlDelayMilliseconds ?? 0);
  }

  async function pause(milliseconds: number, url: string): Promise<void> {
    try {
      await clock.sleep(milliseconds, signal);
    } catch (error) {
      if (signal?.aborted) {
        halt('interrupted', url, 'the run was interrupted');
      }
      throw error;
    }
  }

  /**
   * Loads one URL, retrying with backoff until it loads or the run stops.
   * Every load, the first of the session aside, waits for the delay first.
   */
  async function loadPolitely(
    url: string,
    read: 'rendered' | 'body',
  ): Promise<{
    result: Extract<LoadResult, { kind: 'loaded' }>;
    attempts: number;
  }> {
    let backoff = 0;
    let attempts = 0;
    for (;;) {
      checkInterrupted(url);
      if (loadsMade > 0) {
        await pause(Math.max(politeDelay(), backoff), url);
      }
      checkInterrupted(url);
      attempts += 1;
      loadsMade += 1;
      const result = await driver.load({
        url,
        read,
        isPathOpenable: (path) =>
          isPathOpenable(robotsKnown ? robots : null, path),
      });
      for (const refused of result.refused) {
        refusedBrowserRequests[refused.reason] =
          (refusedBrowserRequests[refused.reason] ?? 0) + 1;
      }
      checkInterrupted(url);
      if (!isFailure(result)) {
        consecutiveFailures = 0;
        return {
          result: result as Extract<LoadResult, { kind: 'loaded' }>,
          attempts,
        };
      }
      consecutiveFailures += 1;
      const retryAfter =
        result.kind === 'loaded'
          ? retryAfterMilliseconds(result.retryAfter, clock.now())
          : null;
      if (
        retryAfter !== null &&
        retryAfter > settings.backoff.retry_after_max_seconds * 1000
      ) {
        halt(
          'retry_after_too_long',
          url,
          `the source asked for a ${Math.ceil(retryAfter / 1000)} s wait, more than the configured ${settings.backoff.retry_after_max_seconds} s`,
        );
      }
      // The ceiling is checked first, so a failure that both reaches the
      // limit and asks for too long a wait records the wait it asked for.
      if (consecutiveFailures >= settings.max_consecutive_failures) {
        halt(
          'source_refused',
          url,
          `${consecutiveFailures} consecutive failures; the last was ${describe(result)}`,
        );
      }
      backoff = Math.max(
        backoffMilliseconds(settings.backoff, consecutiveFailures),
        retryAfter ?? 0,
      );
    }
  }

  // robots.txt first. A resumed run keeps the robots.txt it started with.
  const storedRobots = resumed ? await readRobots(rawRoot, runId) : null;
  if (storedRobots !== null) {
    robots = parseRobots(storedRobots);
    robotsKnown = true;
  } else {
    const robotsUrl = new URL('/robots.txt', origin).href;
    try {
      const { result, attempts } = await loadPolitely(robotsUrl, 'body');
      // A missing robots.txt (any other 4xx) means no rules (RFC 9309); the
      // always-refused paths still apply.
      const text = result.status < 300 ? result.content : '';
      robots = parseRobots(text);
      robotsKnown = true;
      await writeRobots(rawRoot, runId, text);
      pages.push({
        unit: null,
        url: robotsUrl,
        outcome: result.status < 300 ? 'ok' : 'not_found',
        status: result.status,
        attempts,
        file: 'robots.txt',
        reason: null,
      });
    } catch (error) {
      if (!(error instanceof FetchStoppedError)) {
        throw error;
      }
    }
  }

  async function fetchPage(pathOrUrl: string): Promise<FetchedPage> {
    if (activeUnit === null) {
      throw new Error('fetchPage is only available inside runUnit');
    }
    if (loading) {
      throw new Error(
        'A page is already loading; the fetcher opens one at a time.',
      );
    }
    if (stop !== null) {
      throw new FetchStoppedError(stop.reason, stop.detail);
    }
    const url = new URL(pathOrUrl, origin);
    url.hash = '';
    const refuse = (reason: RefusalReason): FetchedPage => {
      pages.push({
        unit: activeUnit,
        url: url.href,
        outcome: 'refused',
        status: null,
        attempts: 0,
        file: null,
        reason,
      });
      return { outcome: 'refused', url: url.href, reason };
    };
    // Refused before a page is opened: another host, or a disallowed path.
    if (url.origin !== origin) {
      return refuse('other_host');
    }
    if (!isPathOpenable(robots, `${url.pathname}${url.search}`)) {
      return refuse('disallowed_path');
    }

    loading = true;
    let loaded: Awaited<ReturnType<typeof loadPolitely>>;
    try {
      loaded = await loadPolitely(url.href, 'rendered');
    } finally {
      loading = false;
    }
    const { result, attempts } = loaded;
    if (result.status >= 400) {
      const outcome =
        result.status === 404 || result.status === 410
          ? 'not_found'
          : 'http_error';
      pages.push({
        unit: activeUnit,
        url: url.href,
        outcome,
        status: result.status,
        attempts,
        file: null,
        reason: null,
      });
      return { outcome, url: url.href, status: result.status };
    }
    const file = await writePage(rawRoot, runId, url.href, result.content);
    pages.push({
      unit: activeUnit,
      url: url.href,
      outcome: 'ok',
      status: result.status,
      attempts,
      file,
      reason: null,
    });
    return {
      outcome: 'ok',
      url: url.href,
      status: result.status,
      file,
      html: result.content,
    };
  }

  return {
    runId,
    get robots() {
      return robots;
    },
    isCompleted: (unitId) => completed.includes(unitId),

    async runUnit(unitId, work) {
      if (activeUnit !== null) {
        throw new Error('Units run one at a time.');
      }
      if (stop !== null) {
        return 'stopped';
      }
      if (completed.includes(unitId)) {
        skipped.push(unitId);
        return 'skipped';
      }
      activeUnit = unitId;
      try {
        await work(fetchPage);
      } catch (error) {
        if (error instanceof FetchStoppedError) {
          return 'stopped';
        }
        throw error;
      } finally {
        activeUnit = null;
      }
      if (stop !== null) {
        return 'stopped';
      }
      completed.push(unitId);
      await writeCheckpoint(rawRoot, {
        run_id: runId,
        origin,
        completed_units: [...completed],
        updated_at: clock.now().toISOString(),
      });
      return 'completed';
    },

    async finish() {
      const status: RunStatus =
        stop === null
          ? 'completed'
          : stop.reason === 'interrupted'
            ? 'interrupted'
            : 'stopped_by_source';
      const report: FetchReport = {
        run_id: runId,
        origin,
        status,
        exit_code: fetchExitCodes[status],
        resumed,
        started_at: startedAt.toISOString(),
        finished_at: clock.now().toISOString(),
        crawl_delay_milliseconds: robots.crawlDelayMilliseconds,
        completed_units: [...completed],
        skipped_units: [...skipped],
        pages: [...pages],
        refused_browser_requests: { ...refusedBrowserRequests },
        stop,
      };
      await writeReport(rawRoot, runId, report);
      return report;
    },
  };
}

/** A fixed plan: each unit's pages, in order. Stops at the first stop. */
export async function fetchUnits(
  session: FetchSession,
  units: readonly { id: string; paths: readonly string[] }[],
): Promise<FetchReport> {
  for (const unit of units) {
    const outcome = await session.runUnit(unit.id, async (fetchPage) => {
      for (const path of unit.paths) {
        await fetchPage(path);
      }
    });
    if (outcome === 'stopped') {
      break;
    }
  }
  return session.finish();
}
