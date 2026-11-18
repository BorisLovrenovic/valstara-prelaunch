import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { MergeError } from '../pipeline/index.ts';
import {
  buildCoverageReport,
  coverageReportBaseName,
  renderCoverageMarkdown,
  serialiseCoverageReport,
  type CoverageReportInput,
} from '../reports/index.ts';
import { coverageReportDirectory } from '../schema/coverage-report.ts';
import { writeFileAtomic } from '../storage/atomic-write.ts';
import {
  DataFileError,
  latestRun,
  mergeRun,
  rawRootOf,
  readDataInputs,
} from './run-files.ts';
import { formatIssues, loadConfig } from './validate.ts';

// `price-index report` (E11.6-08). Writes reports/coverage-YYYY-MM-DD.md and
// .json, dated by the merge they report on. `scrape` writes one as a
// preview of its run, `build-data` the final one of its build, and this
// command, on demand, the preview of the newest run against the founder's
// current data: the same merge `review` reads and `build-data` would write
// now, so a report after an override or a decision shows its effect before
// the build. It writes nothing else, and never anything under
// data/price-index/.

export const reportExitCodes = {
  done: 0,
  /** A flag was given, or there is no run with observations to report on. */
  refused: 1,
  /** A configuration or data file fails its schema, or the merge refuses it. */
  validationFailure: 3,
} as const;

export interface ReportIo {
  root: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  clock: { now(): Date };
}

/**
 * Builds the coverage report and writes its JSON and Markdown under
 * reports/, each atomically. A report of the same date is replaced, so the
 * final report of a build replaces that day's preview. Returns the two
 * paths, relative to `root`.
 */
export async function writeCoverageReport(
  root: string,
  input: CoverageReportInput,
): Promise<string[]> {
  const report = buildCoverageReport(input);
  const base = join(coverageReportDirectory, coverageReportBaseName(report));
  await mkdir(resolve(root, coverageReportDirectory), { recursive: true });
  const json = `${base}.json`;
  const markdown = `${base}.md`;
  await writeFileAtomic(resolve(root, json), serialiseCoverageReport(report), {
    mode: 'replace',
  });
  await writeFileAtomic(
    resolve(root, markdown),
    renderCoverageMarkdown(report),
    { mode: 'replace' },
  );
  return [markdown, json];
}

export async function runReport(
  args: readonly string[],
  io: ReportIo,
): Promise<number> {
  if (args.length > 0) {
    io.stderr(
      'price-index report: refused: it takes no flags.\nUsage: npm run price-index -- report\n',
    );
    return reportExitCodes.refused;
  }
  const { config, settings, issues } = await loadConfig(io.root);
  if (config === undefined || settings === undefined || issues.length > 0) {
    io.stderr(
      `price-index report: the configuration is invalid\n${formatIssues(issues)}\n`,
    );
    return reportExitCodes.validationFailure;
  }

  let paths: string[];
  let runId: string;
  try {
    const run = await latestRun(rawRootOf(io.root));
    if (run === null) {
      io.stderr(
        'price-index report: refused: there is no scrape run to report on. Run scrape first.\n',
      );
      return reportExitCodes.refused;
    }
    if (run.observations === null) {
      io.stderr(
        `price-index report: refused: run ${run.runId} has no observations yet; it was stopped before it could write them. Finish it with scrape --resume ${run.runId}.\n`,
      );
      return reportExitCodes.refused;
    }
    runId = run.runId;
    const data = await readDataInputs(io.root);
    const latest = mergeRun({
      observations: run.observations,
      data,
      config,
      settings: settings.merge,
      clock: io.clock,
    });
    paths = await writeCoverageReport(io.root, {
      kind: 'preview',
      observations: run.observations,
      latest,
      overrides: data.overrides,
      catalogue: config.catalogue,
      markets: config.markets,
      spotChecks: settings.reports.spot_checks,
    });
  } catch (error) {
    if (error instanceof DataFileError || error instanceof MergeError) {
      io.stderr(
        `price-index report: the merge was refused: ${error.message}\n`,
      );
      return reportExitCodes.validationFailure;
    }
    throw error;
  }
  io.stdout(
    `price-index report: the coverage report of run ${runId}, as build-data would build it now:\n${paths.map((path) => `  ${path}`).join('\n')}\n`,
  );
  return reportExitCodes.done;
}
