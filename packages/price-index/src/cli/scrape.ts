import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { systemClock, type Clock } from '../http/clock.ts';
import type { BrowserDriver } from '../http/driver.ts';
import {
  fetchExitCodes,
  openFetchSession,
  type FetchedPage,
  type FetchPage,
} from '../http/fetcher.ts';
import {
  createPlaywrightDriver,
  launchChromium,
} from '../http/playwright-driver.ts';
import { freshRandom, type Random } from '../http/random.ts';
import {
  pageFileName,
  RawStoreError,
  readCheckpoint,
  runDirectory,
} from '../http/raw-store.ts';
import { MergeError } from '../pipeline/index.ts';
import {
  describeChanges,
  formatSummary,
  runFigures,
} from '../reports/index.ts';
import type { ConfigSet } from '../schema/config.ts';
import type { MarketsFile } from '../schema/markets.ts';
import type {
  FetcherSettings,
  PriceIndexSettingsFile,
} from '../schema/price-index-settings.ts';
import {
  runIdPattern,
  runStatuses,
  type RunObservationsFile,
  type RunStatus,
} from '../schema/run-files.ts';
import type {
  RawPage,
  RunUnit,
  SourceAdapter,
  SourceContext,
} from '../sources/source-adapter.ts';
import { youfundceoAdapter } from '../sources/youfundceo/adapter.ts';
import {
  DataFileError,
  directoryPageLoader,
  listRunIds,
  maxRequestRounds,
  mergeRun,
  rawRootOf,
  readDataInputs,
  replayUnit,
  runStartedAt,
  writePreview,
  writeRunObservations,
  type PageLoader,
} from './run-files.ts';
import { formatIssues, loadConfig } from './validate.ts';

// `price-index scrape [--market SE] [--dry-run [--from-fixtures]] [--resume <run_id>]`
// (E11.6-07). A real run fetches the pages the source adapter asks for
// through the browser fetcher (E11.6-04), one at a time, storing each in the
// raw store; reads them (E11.6-05); and writes the run's observations and a
// preview merge (E11.6-06) to data/raw/<run_id>/. **It never writes under
// data/price-index/**: only `build-data` does. A dry run fetches nothing and
// writes nothing at all: it replays the latest raw run, or the founder's
// captured fixtures, and prints what a build would change.

export const scrapeExitCodes = {
  done: 0,
  /** Bad flags, an unknown or disabled market, or no run to replay or resume. */
  refused: 1,
  stoppedBySource: fetchExitCodes.stopped_by_source,
  /** A configuration or data file fails its schema, or the merge refuses it. */
  validationFailure: 3,
  interrupted: fetchExitCodes.interrupted,
} as const;

/** The founder's captured pages (E11.6-01), named as the raw store names pages. */
export const fixturePagesDirectory = fileURLToPath(
  new URL('../../test/fixtures/youfundceo/pages', import.meta.url),
);

export interface OpenedBrowser {
  driver: BrowserDriver;
  /** Closes the driver and the browser. Called once, whatever happened. */
  close(): Promise<void>;
}

/**
 * What a real run needs from outside. The founder's run uses the defaults:
 * the source's own origin, headless Chromium, the system clock, a fresh
 * random source and the process's SIGINT and SIGTERM. Tests inject them.
 */
export interface ScrapeEnvironment {
  /** Where pages are loaded from. `settings.source_origin` in a real run. */
  origin?: string;
  openBrowser?: (
    settings: FetcherSettings,
    origin: string,
  ) => Promise<OpenedBrowser>;
  clock?: Clock;
  random?: Random;
  /** Aborting it stops the run cleanly, as interrupted. */
  signal?: AbortSignal;
}

export interface ScrapeIo {
  root: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  environment?: ScrapeEnvironment;
}

export interface ScrapeRequest {
  market: string | null;
  dryRun: boolean;
  fromFixtures: boolean;
  resume: string | null;
}

export const scrapeUsage = `Usage: npm run price-index -- scrape [--market <code>] [--resume <run_id>]
       npm run price-index -- scrape --dry-run [--from-fixtures] [--market <code>]
`;

/** The request, or the reason it is refused. Reads and writes nothing. */
export function parseScrapeArguments(
  args: readonly string[],
): ScrapeRequest | { refusal: string } {
  const request: ScrapeRequest = {
    market: null,
    dryRun: false,
    fromFixtures: false,
    resume: null,
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (seen.has(flag)) {
      return { refusal: `${flag} is given twice.` };
    }
    seen.add(flag);
    if (flag === '--dry-run') {
      request.dryRun = true;
    } else if (flag === '--from-fixtures') {
      request.fromFixtures = true;
    } else if (flag === '--market' || flag === '--resume') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { refusal: `${flag} needs a value.` };
      }
      index += 1;
      if (flag === '--market') {
        request.market = value.toUpperCase();
      } else if (!runIdPattern.test(value)) {
        return { refusal: `${value} is not a run id (e.g. 20261118T093000Z).` };
      } else {
        request.resume = value;
      }
    } else {
      return { refusal: `${flag} is not a flag of scrape.` };
    }
  }
  if (request.fromFixtures && !request.dryRun) {
    return {
      refusal: '--from-fixtures replays the fixtures only in a --dry-run.',
    };
  }
  if (request.dryRun && request.resume !== null) {
    return {
      refusal: '--dry-run fetches nothing, so it cannot --resume a run.',
    };
  }
  return request;
}

/** The markets with only `code` enabled: the context of a `--market` run. */
function scopedMarkets(markets: MarketsFile, code: string | null): MarketsFile {
  if (code === null) {
    return markets;
  }
  return {
    markets: markets.markets.map((market) => ({
      ...market,
      enabled: market.enabled && market.code === code,
    })),
  };
}

function pathOf(adapter: SourceAdapter, url: string): string {
  const target = new URL(url);
  if (target.origin !== adapter.origin) {
    throw new Error(`the source adapter asked for ${url}, off its origin`);
  }
  return `${target.pathname}${target.search}`;
}

function rawPage(url: string, fetched: FetchedPage): RawPage {
  if (fetched.outcome === 'ok') {
    return { url, outcome: 'ok', html: fetched.html };
  }
  if (fetched.outcome === 'refused') {
    return { url, outcome: 'refused', detail: fetched.reason };
  }
  return { url, outcome: fetched.outcome, detail: `HTTP ${fetched.status}` };
}

const storedReportSchema = z.object({
  pages: z.array(
    z.object({
      url: z.string(),
      outcome: z.enum(['ok', 'not_found', 'http_error', 'refused']),
      status: z.int().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  status: z.enum(runStatuses),
});

/** The fetcher's report of a run, if it wrote one (a killed run did not). */
async function storedReport(
  rawRoot: string,
  runId: string,
): Promise<z.infer<typeof storedReportSchema> | null> {
  let text: string;
  try {
    text = await readFile(
      join(runDirectory(rawRoot, runId), 'fetch-report.json'),
      'utf8',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const parsed = storedReportSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : null;
}

/**
 * For a unit the run completed, a page with no stored copy did not load:
 * the fetcher stores only pages that did. Its outcome comes from the
 * fetcher's report when that names it.
 */
function failedPageFrom(
  report: z.infer<typeof storedReportSchema> | null,
): (url: string) => RawPage {
  const byFile = new Map(
    (report?.pages ?? []).map((page) => [pageFileName(page.url), page]),
  );
  return (url) => {
    const page = byFile.get(pageFileName(url));
    if (page !== undefined && page.outcome !== 'ok') {
      return {
        url,
        outcome: page.outcome,
        detail:
          page.outcome === 'refused'
            ? (page.reason ?? 'refused')
            : `HTTP ${page.status}`,
      };
    }
    return {
      url,
      outcome: 'http_error',
      detail: 'the run has no stored copy of the page',
    };
  };
}

function okPages(pages: ReadonlyMap<string, RawPage>): number {
  return [...pages.values()].filter((page) => page.outcome === 'ok').length;
}

/** A run id for a time, as the raw store names runs. */
function runIdAt(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/u, 'Z')
    .replace(/[-:]/gu, '');
}

function observationsFile(input: {
  adapter: SourceAdapter;
  context: SourceContext;
  runId: string;
  observedAt: string;
  status: RunStatus;
  marketScope: string | null;
  pages: ReadonlyMap<string, RawPage>;
}): RunObservationsFile {
  const result = input.adapter.parse(
    { observedAt: input.observedAt, pages: input.pages },
    input.context,
  );
  return {
    run_id: input.runId,
    source: result.source,
    observed_at: input.observedAt,
    fetch_status: input.status,
    market_scope: input.marketScope,
    pages_fetched: okPages(input.pages),
    observations: [...result.observations],
    gaps: [...result.gaps],
    untracked: result.untracked.map((entry) =>
      entry.kind === 'plan' ? { ...entry, markets: [...entry.markets] } : entry,
    ),
    price_moves: result.priceMoves === null ? null : [...result.priceMoves],
    failures: [...result.failures],
  };
}

/** The founder's run: headless Chromium, presenting as an ordinary browser. */
async function openChromium(
  settings: FetcherSettings,
  origin: string,
): Promise<OpenedBrowser> {
  const browser = await launchChromium(origin);
  try {
    const driver = await createPlaywrightDriver({
      browser,
      origin,
      pageTimeoutMilliseconds: settings.page_timeout_seconds * 1000,
      checkpointWaitMilliseconds: settings.checkpoint_wait_seconds * 1000,
    });
    return {
      driver,
      async close() {
        try {
          await driver.close();
        } finally {
          await browser.close();
        }
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/**
 * Runs `work` with an abort signal: the injected one, or one the process's
 * SIGINT and SIGTERM abort. The listeners are removed when `work` ends, so a
 * second signal after the run ends behaves as Node's default.
 */
async function withInterruptSignal<T>(
  injected: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (injected !== undefined) {
    return work(injected);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await work(controller.signal);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

interface Prepared {
  config: ConfigSet;
  settings: PriceIndexSettingsFile;
  context: SourceContext;
  units: RunUnit[];
}

/** Reads and checks everything a run needs before any page is read. */
async function prepare(
  request: ScrapeRequest,
  io: ScrapeIo,
  adapter: SourceAdapter,
): Promise<Prepared | number> {
  const { config, settings, issues } = await loadConfig(io.root);
  if (config === undefined || settings === undefined || issues.length > 0) {
    io.stderr(
      `price-index scrape: the configuration is invalid\n${formatIssues(issues)}\n`,
    );
    return scrapeExitCodes.validationFailure;
  }
  if (request.market !== null) {
    const market = config.markets.markets.find(
      (candidate) => candidate.code === request.market,
    );
    if (market === undefined || !market.enabled) {
      io.stderr(
        `price-index scrape: refused: ${request.market} is not an enabled market in config/markets.json.\n`,
      );
      return scrapeExitCodes.refused;
    }
  }
  // The founder's data is checked before the run starts, so a long run is
  // not wasted on a file the merge would refuse at the end.
  try {
    await readDataInputs(io.root);
  } catch (error) {
    if (error instanceof DataFileError) {
      io.stderr(
        `price-index scrape: a data file is invalid\n${error.message}\n`,
      );
      return scrapeExitCodes.validationFailure;
    }
    throw error;
  }
  const context: SourceContext = {
    catalogue: config.catalogue,
    markets: scopedMarkets(config.markets, request.market),
  };
  return { config, settings, context, units: adapter.units(context) };
}

/**
 * Merges the run into the current data without writing anything, or says
 * why it cannot. Returns the preview, or the exit code for a refusal.
 */
async function preview(
  observations: RunObservationsFile,
  prepared: Prepared,
  io: ScrapeIo,
  clock: Clock,
) {
  try {
    return mergeRun({
      observations,
      data: await readDataInputs(io.root),
      config: prepared.config,
      settings: prepared.settings.merge,
      clock,
    });
  } catch (error) {
    if (error instanceof DataFileError || error instanceof MergeError) {
      io.stderr(
        `price-index scrape: the preview merge was refused: ${error.message}\nFix the data before running build-data.\n`,
      );
      return null;
    }
    throw error;
  }
}

async function dryRun(
  request: ScrapeRequest,
  io: ScrapeIo,
  adapter: SourceAdapter,
  prepared: Prepared,
  clock: Clock,
): Promise<number> {
  let load: PageLoader;
  let missingFor: (unit: RunUnit) => (url: string) => RawPage | undefined;
  let runId: string;
  let status: RunStatus;
  let observedAt: string;
  let replayed: string;
  if (request.fromFixtures) {
    load = directoryPageLoader(fixturePagesDirectory);
    missingFor = () => () => undefined;
    runId = runIdAt(clock.now());
    status = 'completed';
    observedAt = clock.now().toISOString();
    replayed = "the founder's captured fixtures";
  } else {
    const rawRoot = rawRootOf(io.root);
    const runIds = await listRunIds(rawRoot);
    const latest = runIds.at(-1);
    if (latest === undefined) {
      io.stderr(
        'price-index scrape: refused: there is no raw run to replay. Run scrape first, or replay the fixtures with --dry-run --from-fixtures.\n',
      );
      return scrapeExitCodes.refused;
    }
    runId = latest;
    const checkpoint = await readCheckpoint(rawRoot, runId);
    const report = await storedReport(rawRoot, runId);
    const completed = new Set(checkpoint?.completed_units ?? []);
    const failedPage = failedPageFrom(report);
    load = directoryPageLoader(join(runDirectory(rawRoot, runId), 'pages'));
    missingFor = (unit) =>
      completed.has(unit.id) ? failedPage : () => undefined;
    status = report?.status ?? 'interrupted';
    observedAt = runStartedAt(runId);
    replayed = `raw run ${runId}`;
  }

  const pages = new Map<string, RawPage>();
  for (const unit of prepared.units) {
    await replayUnit({
      adapter,
      unit,
      context: prepared.context,
      pages,
      load,
      missing: missingFor(unit),
    });
  }
  const observations = observationsFile({
    adapter,
    context: prepared.context,
    runId,
    observedAt,
    status,
    marketScope: request.market,
    pages,
  });
  const merged = await preview(observations, prepared, io, clock);
  if (merged === null) {
    return scrapeExitCodes.validationFailure;
  }
  const { previous } = await readDataInputs(io.root);
  const changes = describeChanges(previous, merged);
  io.stdout(
    `price-index scrape --dry-run: replayed ${replayed}. Nothing was fetched and nothing was written.\n` +
      (changes.length === 0
        ? 'A build would change no record in latest.json.\n'
        : `A build would change ${changes.length} record(s) in latest.json:\n${changes.map((line) => `  ${line}`).join('\n')}\n`) +
      formatSummary({
        heading: 'Preview of the build:',
        marketScope: request.market,
        figures: runFigures(observations, merged),
        reports: [],
      }),
  );
  return scrapeExitCodes.done;
}

async function realRun(
  request: ScrapeRequest,
  io: ScrapeIo,
  adapter: SourceAdapter,
  prepared: Prepared,
  signal: AbortSignal,
): Promise<number> {
  const environment = io.environment ?? {};
  const fetcherSettings = prepared.settings.fetcher;
  const origin = environment.origin ?? fetcherSettings.source_origin;
  const clock = environment.clock ?? systemClock;
  const rawRoot = rawRootOf(io.root);
  const opened = await (environment.openBrowser ?? openChromium)(
    fetcherSettings,
    origin,
  );

  const pages = new Map<string, RawPage>();
  let runId: string;
  let status: RunStatus;
  try {
    let session;
    try {
      session = await openFetchSession({
        origin,
        settings: fetcherSettings,
        driver: opened.driver,
        clock,
        random: environment.random ?? freshRandom(),
        rawRoot,
        signal,
        ...(request.resume === null ? {} : { resumeRunId: request.resume }),
      });
    } catch (error) {
      if (error instanceof RawStoreError) {
        io.stderr(`price-index scrape: refused: ${error.message}.\n`);
        return scrapeExitCodes.refused;
      }
      throw error;
    }
    runId = session.runId;
    // A resumed run reads the pages of the units it already completed from
    // the raw store, so later units can be planned from them.
    const failedPage = failedPageFrom(await storedReport(rawRoot, runId));
    const load = directoryPageLoader(
      join(runDirectory(rawRoot, runId), 'pages'),
    );

    for (const unit of prepared.units) {
      if (session.isCompleted(unit.id)) {
        await replayUnit({
          adapter,
          unit,
          context: prepared.context,
          pages,
          load,
          missing: failedPage,
        });
      }
      const outcome = await session.runUnit(
        unit.id,
        async (fetchPage: FetchPage) => {
          for (let round = 0; ; round += 1) {
            const wanted = adapter.requests(unit, prepared.context, pages);
            if (wanted.length === 0) {
              return;
            }
            if (round >= maxRequestRounds) {
              throw new Error(
                `the source adapter asked for more than ${maxRequestRounds} rounds of pages for ${unit.id}`,
              );
            }
            for (const url of wanted) {
              pages.set(
                url,
                rawPage(url, await fetchPage(pathOf(adapter, url))),
              );
            }
          }
        },
      );
      if (outcome === 'stopped') {
        break;
      }
    }
    status = (await session.finish()).status;
  } finally {
    await opened.close();
  }

  const observations = observationsFile({
    adapter,
    context: prepared.context,
    runId,
    observedAt: runStartedAt(runId),
    status,
    marketScope: request.market,
    pages,
  });
  const observationsPath = await writeRunObservations(rawRoot, observations);
  const merged = await preview(observations, prepared, io, clock);
  const reports = [observationsPath];
  if (merged !== null) {
    reports.push(await writePreview(rawRoot, runId, merged));
  }
  reports.push(join(runDirectory(rawRoot, runId), 'fetch-report.json'));

  const exitCode =
    status === 'completed'
      ? merged === null
        ? scrapeExitCodes.validationFailure
        : scrapeExitCodes.done
      : fetchExitCodes[status];
  const verb = {
    completed: 'completed',
    stopped_by_source: 'was stopped by the source',
    interrupted: 'was interrupted',
  }[status];
  const next =
    status === 'completed'
      ? 'Read the preview, settle its flags, then run build-data.'
      : `It is partial. Resume it with scrape --resume ${runId}, or build it as it is: every market it did not read keeps its previous values.`;
  io.stdout(
    (merged === null
      ? `price-index scrape: run ${runId} ${verb} (exit ${exitCode}). Its observations are written; the preview merge was refused.\n`
      : formatSummary({
          heading: `price-index scrape: run ${runId} ${verb} (exit ${exitCode}). latest.json was not touched.`,
          marketScope: request.market,
          figures: runFigures(observations, merged),
          reports: reports.map((path) => relative(io.root, path)),
        })) + `${next}\n`,
  );
  return exitCode;
}

export async function runScrape(
  args: readonly string[],
  io: ScrapeIo,
  adapter: SourceAdapter = youfundceoAdapter,
): Promise<number> {
  const request = parseScrapeArguments(args);
  if ('refusal' in request) {
    io.stderr(
      `price-index scrape: refused: ${request.refusal}\n${scrapeUsage}`,
    );
    return scrapeExitCodes.refused;
  }
  const prepared = await prepare(request, io, adapter);
  if (typeof prepared === 'number') {
    return prepared;
  }
  if (request.dryRun) {
    return dryRun(
      request,
      io,
      adapter,
      prepared,
      io.environment?.clock ?? systemClock,
    );
  }
  return withInterruptSignal(io.environment?.signal, (signal) =>
    realRun(request, io, adapter, prepared, signal),
  );
}
