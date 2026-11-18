import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { MergeError } from '../pipeline/index.ts';
import {
  buildRunLog,
  formatSummary,
  runFigures,
  serialiseRunLog,
} from '../reports/index.ts';
import { runLogDirectory } from '../schema/run-files.ts';
import { writeFileAtomic } from '../storage/atomic-write.ts';
import { createJsonFileStore } from '../storage/json-file-store.ts';
import {
  DataFileError,
  latestRun,
  mergeRun,
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
// values, and the run log names the markets whose pages failed. The changed
// count is zero until E11.6-09 adds change detection.

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
  const dataIssues = await validateDataFiles(io.root);
  if (dataIssues.length > 0) {
    return fail(`a data file is invalid\n${formatIssues(dataIssues)}`);
  }

  let merged;
  let observations;
  let data;
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
  } catch (error) {
    if (error instanceof DataFileError || error instanceof MergeError) {
      return fail(`the merge was refused: ${error.message}`);
    }
    throw error;
  }

  // Everything is valid; only now is anything written. latest.json first,
  // then its snapshot, then the run log that names the snapshot.
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
      figures: runFigures(observations, merged),
      reports: [
        latestFile,
        join(snapshotsDirectory, snapshot.name),
        relative(io.root, runLogPath),
        ...coverageReport,
      ],
    }) + partial,
  );
  return buildDataExitCodes.done;
}
