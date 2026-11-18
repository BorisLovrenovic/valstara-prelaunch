import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { z } from 'zod';

import { rawDirectory, pageFileName, runDirectory } from '../http/raw-store.ts';
import { mergePriceIndex } from '../pipeline/index.ts';
import { approvalsFile, approvalsFileSchema } from '../schema/approvals.ts';
import type { ConfigSet, ConfigIssue } from '../schema/config.ts';
import {
  manualOverridesFile,
  manualOverridesFileSchema,
  type ManualOverridesFile,
} from '../schema/manual-overrides.ts';
import type { LatestFile } from '../schema/price-index-files.ts';
import type { MergeSettings } from '../schema/price-index-settings.ts';
import {
  runIdPattern,
  runObservationsFileSchema,
  type RunObservationsFile,
} from '../schema/run-files.ts';
import type { ApprovalsFile } from '../schema/approvals.ts';
import type {
  RawPage,
  RunUnit,
  SourceAdapter,
  SourceContext,
} from '../sources/source-adapter.ts';
import { writeFileAtomic } from '../storage/atomic-write.ts';
import { createJsonFileStore } from '../storage/json-file-store.ts';
import { PriceStoreError } from '../storage/price-store.ts';
import { serialisePriceIndexFile } from '../storage/serialise.ts';
import { formatIssues, priceIndexDataDirectory } from './validate.ts';

// The files a scrape run reads and writes (E11.6-07). A run's own files stay
// in the gitignored raw store, data/raw/<run_id>/:
//
//   pages/<name>.html     each page as the browser rendered it (E11.6-04)
//   fetch-report.json     the fetcher's report (E11.6-04)
//   observations.json     what the run read, normalised (this ticket)
//   preview.json          the preview merge: the latest.json a build of this
//                         run would write today, for the founder to read
//
// Nothing here writes under data/price-index/. Only `build-data` does, and
// only through the PriceStore.

export const observationsFileName = 'observations.json';
export const previewFileName = 'preview.json';

/** A data file failed its schema or is unreadable. The CLI exits 3. */
export class DataFileError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(formatIssues(issues));
    this.name = 'DataFileError';
    this.issues = issues;
  }
}

export function rawRootOf(root: string): string {
  return resolve(root, rawDirectory);
}

/** The run's start, from its id: `20261118T093000Z-2` → `2026-11-18T09:30:00.000Z`. */
export function runStartedAt(runId: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/u.exec(runId);
  if (match === null || !runIdPattern.test(runId)) {
    throw new Error(`not a run id: ${runId}`);
  }
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

/** The raw store's runs, oldest first. None when the store does not exist. */
export async function listRunIds(rawRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rawRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && runIdPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function readJson(path: string, file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new DataFileError([
      {
        file,
        path: '',
        message: code === 'ENOENT' ? 'file not found' : `unreadable (${code})`,
      },
    ]);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DataFileError([
      {
        file,
        path: '',
        message: `not valid JSON: ${(error as Error).message}`,
      },
    ]);
  }
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new DataFileError(
    result.error.issues.map((issue) => ({
      file,
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  );
}

function observationsPath(rawRoot: string, runId: string): string {
  return join(runDirectory(rawRoot, runId), observationsFileName);
}

/** A run's observations, validated, or null when the run wrote none. */
export async function readRunObservations(
  rawRoot: string,
  runId: string,
): Promise<RunObservationsFile | null> {
  const path = observationsPath(rawRoot, runId);
  const file = `${rawDirectory}/${runId}/${observationsFileName}`;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DataFileError([
      {
        file,
        path: '',
        message: `not valid JSON: ${(error as Error).message}`,
      },
    ]);
  }
  const observations = parsed(runObservationsFileSchema, value, file);
  if (observations.run_id !== runId) {
    throw new DataFileError([
      { file, path: 'run_id', message: `must be ${runId}, the run's id` },
    ]);
  }
  return observations;
}

export async function writeRunObservations(
  rawRoot: string,
  observations: RunObservationsFile,
): Promise<string> {
  const path = observationsPath(rawRoot, observations.run_id);
  await writeFileAtomic(
    path,
    `${JSON.stringify(runObservationsFileSchema.parse(observations), null, 2)}\n`,
    { mode: 'replace' },
  );
  return path;
}

export async function writePreview(
  rawRoot: string,
  runId: string,
  preview: LatestFile,
): Promise<string> {
  const path = join(runDirectory(rawRoot, runId), previewFileName);
  await writeFileAtomic(path, serialisePriceIndexFile(preview), {
    mode: 'replace',
  });
  return path;
}

/**
 * The newest run in the raw store with what it wrote, or null when the store
 * has no run. A run without observations.json was stopped before it could
 * write them (a killed process) and is waiting for `scrape --resume`.
 */
export async function latestRun(
  rawRoot: string,
): Promise<{ runId: string; observations: RunObservationsFile | null } | null> {
  const runIds = await listRunIds(rawRoot);
  const runId = runIds.at(-1);
  if (runId === undefined) {
    return null;
  }
  return { runId, observations: await readRunObservations(rawRoot, runId) };
}

/** The founder's data a merge reads besides the run, each validated. */
export interface DataInputs {
  previous: LatestFile | null;
  overrides: ManualOverridesFile;
  approvals: ApprovalsFile;
}

/** Reads latest.json, manual-overrides.json and approvals.json under `root`. */
export async function readDataInputs(root: string): Promise<DataInputs> {
  let previous: LatestFile | null;
  try {
    previous = await createJsonFileStore({
      directory: resolve(root, priceIndexDataDirectory),
    }).readLatest();
  } catch (error) {
    if (error instanceof PriceStoreError) {
      throw new DataFileError([
        {
          file: `${priceIndexDataDirectory}/latest.json`,
          path: '',
          message: error.message,
        },
      ]);
    }
    throw error;
  }
  const overrides = parsed(
    manualOverridesFileSchema,
    await readJson(resolve(root, manualOverridesFile), manualOverridesFile),
    manualOverridesFile,
  );
  const approvals = parsed(
    approvalsFileSchema,
    await readJson(resolve(root, approvalsFile), approvalsFile),
    approvalsFile,
  );
  return { previous, overrides, approvals };
}

/**
 * The merge of one run into the current data: the latest.json `build-data`
 * would write now. Pure apart from what it is given; writes nothing.
 */
export function mergeRun(input: {
  observations: RunObservationsFile;
  data: DataInputs;
  config: ConfigSet;
  settings: MergeSettings;
  clock: { now(): Date };
}): LatestFile {
  const { observations, data, config } = input;
  return mergePriceIndex({
    previous: data.previous,
    run: {
      source: observations.source,
      observedAt: observations.observed_at,
      observations: observations.observations,
      gaps: observations.gaps,
    },
    overrides: data.overrides,
    approvals: data.approvals,
    catalogue: config.catalogue,
    markets: config.markets,
    settings: input.settings,
    clock: input.clock,
  });
}

/** One stored page, or undefined when there is no stored copy of it. */
export type PageLoader = (url: string) => Promise<RawPage | undefined>;

/** Pages from a directory named like the raw store's `pages/` (and the fixtures). */
export function directoryPageLoader(directory: string): PageLoader {
  return async (url) => {
    try {
      const html = await readFile(join(directory, pageFileName(url)), 'utf8');
      return { url, outcome: 'ok', html };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  };
}

/** The most rounds of `requests` one unit may take before the run gives up. */
export const maxRequestRounds = 10;

/**
 * Rebuilds the pages a unit read from stored copies, asking the adapter
 * which pages the unit needs as each round is loaded. A URL with no stored
 * copy is given `missing(url)`: a page that did not load, for a unit the run
 * completed, or nothing (left out, "not fetched") otherwise. Fetches nothing.
 */
export async function replayUnit(input: {
  adapter: SourceAdapter;
  unit: RunUnit;
  context: SourceContext;
  pages: Map<string, RawPage>;
  load: PageLoader;
  missing: (url: string) => RawPage | undefined;
}): Promise<void> {
  const tried = new Set<string>();
  for (let round = 0; round < maxRequestRounds; round += 1) {
    const wanted = input.adapter
      .requests(input.unit, input.context, input.pages)
      .filter((url) => !tried.has(url));
    if (wanted.length === 0) {
      return;
    }
    for (const url of wanted) {
      tried.add(url);
      const page = (await input.load(url)) ?? input.missing(url);
      if (page !== undefined) {
        input.pages.set(url, page);
      }
    }
  }
  throw new Error(
    `the source adapter asked for more than ${maxRequestRounds} rounds of pages for ${input.unit.id}`,
  );
}
