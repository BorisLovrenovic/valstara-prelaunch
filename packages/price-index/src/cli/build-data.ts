import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { MergeError } from '../pipeline/index.ts';
import { generatedPages, publishedUrlsFor } from '../publish/pages.ts';
import {
  buildRunLog,
  formatSummary,
  runFigures,
  serialiseRunLog,
} from '../reports/index.ts';
import { changesFile, type ChangeEntry } from '../schema/changes.ts';
import {
  publishedUrlsFile,
  type PublishedUrl,
} from '../schema/published-urls.ts';
import { runLogDirectory } from '../schema/run-files.ts';
import { writeFileAtomic } from '../storage/atomic-write.ts';
import { appendChanges } from '../storage/changes-file.ts';
import { createJsonFileStore } from '../storage/json-file-store.ts';
import {
  appendPublishedUrls,
  newPublishedUrls,
  readPublishedUrls,
} from '../storage/published-urls-file.ts';
import {
  DataFileError,
  latestRun,
  mergeRun,
  pendingChanges,
  rawRootOf,
  readDataInputs,
} from './run-files.ts';
import { writeCoverageReport } from './report.ts';
import {
  formatIssues,
  latestFile,
  loadConfig,
  priceIndexDataDirectory,
  snapshotsDirectory,
  validateDataFiles,
} from './validate.ts';

// `price-index build-data` (E11.6-07). Merges the latest run's observations
// with the founder's overrides and decisions into the next latest.json
// (E11.6-06), and only when every input and the result validate, writes:
//
//   data/price-index/changes.json             the build's real price
//                                             changes, appended (E11.6-09)
//   data/price-index/published-urls.json      the URL of every page the
//                                             new latest.json generates for
//                                             the first time, appended
//                                             (E11.6-10)
//   data/price-index/latest.json              replaced atomically
//   data/price-index/snapshots/<date>.json    a new, immutable snapshot
//   reports/runs/<run_id>.json                the run log
//   reports/coverage-<date>.md and .json      the final coverage report
//                                             (E11.6-08), replacing that
//                                             day's preview
//
// A build that fails validation writes nothing, so latest.json and every
// snapshot stay byte-identical. A partial run (stopped by the source or
// interrupted) builds: the markets it did not read keep their previous
// values, and the run log names the markets whose pages failed.
//
// Change detection (E11.6-09) compares each value the new latest.json
// publishes with the value its record last published, and appends every
// real change to changes.json, before latest.json is replaced: a build cut
// short after the append is rebuilt to the same entries, which the log
// already holds and does not repeat. The run log counts them as `changed`.
//
// The published-URL ledger (E11.6-10) is appended the same way, after the
// changes and before latest.json: a page the new latest.json generates is in
// the ledger before it can be built and served, so a URL that was ever live
// never answers 404 (docs/features/price-index.md#edge-cases-and-error-states).

export const buildDataExitCodes = {
  done: 0,
  /** A flag was given, or there is no run with observations to build. */
  refused: 1,
  /** A configuration or data file fails its schema, or the merge refuses it. */
  validationFailure: 3,
} as const;

export interface BuildDataIo {
  root: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  clock: { now(): Date };
}

export async function runBuildData(
  args: readonly string[],
  io: BuildDataIo,
): Promise<number> {
  const fail = (message: string) => {
    io.stderr(
      `price-index build-data: ${message}\nNothing was written; latest.json and every snapshot are unchanged.\n`,
    );
    return buildDataExitCodes.validationFailure;
  };
  if (args.length > 0) {
    io.stderr(
      `price-index build-data: refused: it takes no flags.\nUsage: npm run price-index -- build-data\n`,
    );
    return buildDataExitCodes.refused;
  }

  const { config, settings, issues } = await loadConfig(io.root);
  if (config === undefined || settings === undefined || issues.length > 0) {
    return fail(`the configuration is invalid\n${formatIssues(issues)}`);
  }
  const dataIssues = await validateDataFiles(io.root, config);
  if (dataIssues.length > 0) {
    return fail(`a data file is invalid\n${formatIssues(dataIssues)}`);
  }

  let merged;
  let observations;
  let data;
  let changes: ChangeEntry[];
  let publishedUrls: PublishedUrl[];
  try {
    const run = await latestRun(rawRootOf(io.root));
    if (run === null) {
      io.stderr(
        'price-index build-data: refused: there is no scrape run to build. Run scrape first.\n',
      );
      return buildDataExitCodes.refused;
    }
    if (run.observations === null) {
      io.stderr(
        `price-index build-data: refused: run ${run.runId} has no observations yet; it was stopped before it could write them. Finish it with scrape --resume ${run.runId}.\n`,
      );
      return buildDataExitCodes.refused;
    }
    observations = run.observations;
    data = await readDataInputs(io.root);
    merged = mergeRun({
      observations,
      data,
      config,
      settings: settings.merge,
      clock: io.clock,
    });
    changes = await pendingChanges(io.root, merged);
    const ledger = await readPublishedUrls(resolve(io.root, publishedUrlsFile));
    publishedUrls = newPublishedUrls(
      ledger ?? { urls: [] },
      publishedUrlsFor(
        generatedPages(merged, config.catalogue, config.markets),
        merged.built_at.slice(0, 10),
      ),
    );
  } catch (error) {
    if (error instanceof DataFileError || error instanceof MergeError) {
      return fail(`the merge was refused: ${error.message}`);
    }
    throw error;
  }

  // Everything is valid; only now is anything written. The changes first,
  // then the newly published URLs, then latest.json, then its snapshot, then
  // the run log that names the snapshot.
  await appendChanges(resolve(io.root, changesFile), changes);
  await appendPublishedUrls(resolve(io.root, publishedUrlsFile), publishedUrls);
  const store = createJsonFileStore({
    directory: resolve(io.root, priceIndexDataDirectory),
  });
  await store.writeLatest(merged);
  const snapshot = await store.writeSnapshot(
    merged,
    merged.built_at.slice(0, 10),
  );
  const log = buildRunLog({
    observations,
    latest: merged,
    snapshot: snapshot.name,
    changed: changes.length,
  });
  const runLogPath = resolve(io.root, runLogDirectory, `${log.run_id}.json`);
  await mkdir(resolve(io.root, runLogDirectory), { recursive: true });
  await writeFileAtomic(runLogPath, serialiseRunLog(log), { mode: 'replace' });
  const coverageReport = await writeCoverageReport(io.root, {
    kind: 'final',
    observations,
    latest: merged,
    overrides: data.overrides,
    catalogue: config.catalogue,
    markets: config.markets,
    spotChecks: settings.reports.spot_checks,
  });

  const partial =
    observations.fetch_status === 'completed'
      ? ''
      : `Run ${log.run_id} was partial (${observations.fetch_status}): every market it did not read kept its previous values.\n`;
  io.stdout(
    formatSummary({
      heading: `price-index build-data: built run ${log.run_id}.`,
      marketScope: observations.market_scope,
      figures: runFigures(observations, merged, changes.length),
      reports: [
        ...(changes.length === 0 ? [] : [changesFile]),
        ...(publishedUrls.length === 0 ? [] : [publishedUrlsFile]),
        latestFile,
        join(snapshotsDirectory, snapshot.name),
        relative(io.root, runLogPath),
        ...coverageReport,
      ],
    }) + partial,
  );
  return buildDataExitCodes.done;
}
