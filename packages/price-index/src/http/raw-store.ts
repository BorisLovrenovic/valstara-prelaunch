import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { runIdPattern } from '../schema/run-files.ts';
import { writeFileAtomic } from '../storage/atomic-write.ts';

// The raw store (E11.6-04): `data/raw/<run_id>/` holds what one run fetched.
// It is gitignored and rotated to the last N runs.
//
//   <run_id>/robots.txt           the source's robots.txt as sent
//   <run_id>/pages/<name>.html    each page as the browser rendered it
//   <run_id>/checkpoint.json      the units (markets) completed so far
//   <run_id>/fetch-report.json    the fetcher's report for the run

/** The raw store's directory, relative to the repository root. */
export const rawDirectory = 'data/raw';

/** `20261118T093000Z`, with `-2`, `-3`, … for a second run in that second. */
export { runIdPattern };

export class RawStoreError extends Error {
  readonly code: 'invalid_run_id' | 'run_not_found' | 'invalid_checkpoint';
  constructor(code: RawStoreError['code'], message: string) {
    super(message);
    this.name = 'RawStoreError';
    this.code = code;
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function runDirectory(rawRoot: string, runId: string): string {
  if (!runIdPattern.test(runId)) {
    throw new RawStoreError('invalid_run_id', `not a run id: ${runId}`);
  }
  return join(rawRoot, runId);
}

/** Creates a new, empty run directory named from the clock's time. */
export async function createRun(rawRoot: string, now: Date): Promise<string> {
  await mkdir(rawRoot, { recursive: true });
  const base = now
    .toISOString()
    .replace(/\.\d{3}Z$/u, 'Z')
    .replace(/[-:]/gu, '');
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const runId = suffix === 1 ? base : `${base}-${suffix}`;
    try {
      await mkdir(join(rawRoot, runId));
      await mkdir(join(rawRoot, runId, 'pages'));
      return runId;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
    }
  }
  throw new Error(`no free run id for ${base}`);
}

/** Confirms that an earlier run's directory exists, for a resume. */
export async function openRun(rawRoot: string, runId: string): Promise<void> {
  const directory = runDirectory(rawRoot, runId);
  const found = await stat(directory).catch(() => null);
  if (found === null || !found.isDirectory()) {
    throw new RawStoreError('run_not_found', `no raw run ${runId} to resume`);
  }
  await mkdir(join(directory, 'pages'), { recursive: true });
}

/**
 * The file a page is stored under: its path with `/` as `__`, the home page
 * as `home`, and a query kept after `__q-`. Characters outside
 * `[A-Za-z0-9._-]` become `_`.
 */
export function pageFileName(url: string): string {
  const { pathname, search } = new URL(url);
  const trimmed = pathname.replace(/^\/+|\/+$/gu, '');
  const path = trimmed === '' ? 'home' : trimmed.replaceAll('/', '__');
  const query = search === '' ? '' : `__q-${search.slice(1)}`;
  return `${`${path}${query}`.replace(/[^A-Za-z0-9._-]/gu, '_')}.html`;
}

/** Stores a page's rendered HTML; returns its path inside the run. */
export async function writePage(
  rawRoot: string,
  runId: string,
  url: string,
  html: string,
): Promise<string> {
  const file = `pages/${pageFileName(url)}`;
  await writeFileAtomic(join(runDirectory(rawRoot, runId), file), html, {
    mode: 'replace',
  });
  return file;
}

export async function writeRobots(
  rawRoot: string,
  runId: string,
  text: string,
): Promise<void> {
  await writeFileAtomic(
    join(runDirectory(rawRoot, runId), 'robots.txt'),
    text,
    {
      mode: 'replace',
    },
  );
}

/** The run's stored robots.txt, or null if the run has not read it yet. */
export async function readRobots(
  rawRoot: string,
  runId: string,
): Promise<string | null> {
  try {
    return await readFile(
      join(runDirectory(rawRoot, runId), 'robots.txt'),
      'utf8',
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export const checkpointSchema = z.strictObject({
  run_id: z.string().regex(runIdPattern),
  origin: z.url(),
  completed_units: z.array(z.string().min(1)),
  updated_at: z.iso.datetime(),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

export async function readCheckpoint(
  rawRoot: string,
  runId: string,
): Promise<Checkpoint | null> {
  let text: string;
  try {
    text = await readFile(
      join(runDirectory(rawRoot, runId), 'checkpoint.json'),
      'utf8',
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RawStoreError('invalid_checkpoint', `${runId}: not JSON`);
  }
  const parsed = checkpointSchema.safeParse(value);
  if (!parsed.success || parsed.data.run_id !== runId) {
    throw new RawStoreError(
      'invalid_checkpoint',
      `${runId}: not a checkpoint of this run`,
    );
  }
  return parsed.data;
}

/** Replaces the checkpoint atomically, so a crash leaves the previous one. */
export async function writeCheckpoint(
  rawRoot: string,
  checkpoint: Checkpoint,
): Promise<void> {
  await writeFileAtomic(
    join(runDirectory(rawRoot, checkpoint.run_id), 'checkpoint.json'),
    json(checkpointSchema.parse(checkpoint)),
    { mode: 'replace' },
  );
}

export async function writeReport(
  rawRoot: string,
  runId: string,
  report: unknown,
): Promise<string> {
  const file = join(runDirectory(rawRoot, runId), 'fetch-report.json');
  await writeFileAtomic(file, json(report), { mode: 'replace' });
  return file;
}

/**
 * Deletes the oldest runs so that `keep` remain, the current run always among
 * them. Only directories named like a run are counted or deleted. Returns the
 * deleted run ids.
 */
export async function rotateRuns(
  rawRoot: string,
  keep: number,
  currentRunId: string,
): Promise<string[]> {
  const entries = await readdir(rawRoot, { withFileTypes: true });
  const others = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        runIdPattern.test(entry.name) &&
        entry.name !== currentRunId,
    )
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const deleted = others.slice(0, Math.max(0, others.length - (keep - 1)));
  for (const runId of deleted) {
    await rm(join(rawRoot, runId), { recursive: true, force: true });
  }
  return deleted;
}
