import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  buildMonthlyReport,
  crossCheckPriceMoves,
  renderMonthlyMarkdown,
  serialiseMonthlyReport,
} from '../reports/index.ts';
import { changesFile } from '../schema/changes.ts';
import {
  monthlyDataDirectory,
  monthlyReportDirectory,
  monthPattern,
} from '../schema/monthly-report.ts';
import {
  runIdPattern,
  runLogDirectory,
  runLogFileSchema,
} from '../schema/run-files.ts';
import { writeFileAtomic } from '../storage/atomic-write.ts';
import { readChanges } from '../storage/changes-file.ts';
import { createJsonFileStore } from '../storage/json-file-store.ts';
import { DataFileError, rawRootOf, readRunObservations } from './run-files.ts';
import {
  formatIssues,
  loadConfig,
  priceIndexDataDirectory,
  validateDataFiles,
} from './validate.ts';

// `price-index monthly-report --month YYYY-MM` (E11.6-09). Writes, each
// atomically and replacing an earlier report of the same month:
//
//   data/price-index/monthly/YYYY-MM.json   the figures, for the page
//   reports/monthly/YYYY-MM.md              the same figures for outreach,
//                                           plus the founder-only
//                                           cross-check against the
//                                           source's "Price moves"
//
// The figures are read from the month's last snapshot and from changes.json,
// through the publish gate. The cross-check reads the price moves of the
// runs built that month from the raw store, when it still holds them. It
// writes nothing else, and changes no value.

export const monthlyReportExitCodes = {
  done: 0,
  /** A malformed flag, or no build in that month to report on. */
  refused: 1,
  /** A configuration or data file fails its schema. */
  validationFailure: 3,
} as const;

export interface MonthlyReportIo {
  root: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const usage = 'Usage: npm run price-index -- monthly-report --month YYYY-MM\n';

/** The month of `--month YYYY-MM`, or null for anything else. */
export function parseMonthArgument(args: readonly string[]): string | null {
  if (args.length !== 2 || args[0] !== '--month') {
    return null;
  }
  const month = args[1]!;
  return monthPattern.test(month) ? month : null;
}

/** The runs whose builds wrote a snapshot dated in `month`, by run id. */
async function runsBuiltIn(root: string, month: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(resolve(root, runLogDirectory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const runs: string[] = [];
  for (const name of names.sort()) {
    const runId = name.replace(/\.json$/u, '');
    if (!name.endsWith('.json') || !runIdPattern.test(runId)) {
      continue;
    }
    const log = runLogFileSchema.parse(
      JSON.parse(
        await readFile(resolve(root, runLogDirectory, name), 'utf8'),
      ) as unknown,
    );
    if (log.snapshot.startsWith(`${month}-`)) {
      runs.push(log.run_id);
    }
  }
  return runs;
}

export async function runMonthlyReport(
  args: readonly string[],
  io: MonthlyReportIo,
): Promise<number> {
  const month = parseMonthArgument(args);
  if (month === null) {
    io.stderr(
      `price-index monthly-report: refused: it takes exactly --month YYYY-MM.\n${usage}`,
    );
    return monthlyReportExitCodes.refused;
  }
  const fail = (message: string) => {
    io.stderr(
      `price-index monthly-report: ${message}\nNo report was written.\n`,
    );
    return monthlyReportExitCodes.validationFailure;
  };

  const { config, issues } = await loadConfig(io.root);
  if (config === undefined || issues.length > 0) {
    return fail(`the configuration is invalid\n${formatIssues(issues)}`);
  }
  const dataIssues = await validateDataFiles(io.root);
  if (dataIssues.length > 0) {
    return fail(`a data file is invalid\n${formatIssues(dataIssues)}`);
  }

  const store = createJsonFileStore({
    directory: resolve(io.root, priceIndexDataDirectory),
  });
  const snapshotRef = (await store.listSnapshots())
    .filter((ref) => ref.date.startsWith(`${month}-`))
    .at(-1);
  if (snapshotRef === undefined) {
    io.stderr(
      `price-index monthly-report: refused: there is no build in ${month}, so there are no published prices to report. Run build-data first.\n`,
    );
    return monthlyReportExitCodes.refused;
  }
  const snapshot = await store.readSnapshot(snapshotRef);
  const changes = await readChanges(resolve(io.root, changesFile));
  if (changes === null) {
    return fail(`${changesFile} does not exist`);
  }

  const runs = [];
  try {
    for (const runId of await runsBuiltIn(io.root, month)) {
      const observations = await readRunObservations(rawRootOf(io.root), runId);
      runs.push({ runId, priceMoves: observations?.price_moves ?? null });
    }
  } catch (error) {
    if (error instanceof DataFileError) {
      return fail(`a raw run is invalid\n${error.message}`);
    }
    throw error;
  }

  const report = buildMonthlyReport({
    month,
    snapshot: { name: snapshotRef.name, file: snapshot },
    changes: changes.changes,
    catalogue: config.catalogue,
    markets: config.markets,
  });
  const crossCheck = crossCheckPriceMoves({
    month,
    runs,
    changes: changes.changes,
    catalogue: config.catalogue,
    markets: config.markets,
  });

  const json = join(monthlyDataDirectory, `${month}.json`);
  const markdown = join(monthlyReportDirectory, `${month}.md`);
  await mkdir(resolve(io.root, monthlyDataDirectory), { recursive: true });
  await mkdir(resolve(io.root, monthlyReportDirectory), { recursive: true });
  await writeFileAtomic(
    resolve(io.root, json),
    serialiseMonthlyReport(report),
    { mode: 'replace' },
  );
  await writeFileAtomic(
    resolve(io.root, markdown),
    renderMonthlyMarkdown(report, config, crossCheck),
    { mode: 'replace' },
  );

  io.stdout(
    [
      `price-index monthly-report: ${month}, from snapshot ${snapshotRef.name}.`,
      `  Changes: ${report.changes.length}`,
      `  Plans compared: ${report.plans.length}`,
      `  Cross-check (Markdown only): ${
        crossCheck.readRuns.length === 0
          ? 'unavailable, no price moves in the raw store'
          : `${crossCheck.undetected.length} undetected move(s), ${crossCheck.unlisted.length} change(s) the source does not list`
      }`,
      '  Reports:',
      `    ${json}`,
      `    ${markdown}`,
    ].join('\n') + '\n',
  );
  return monthlyReportExitCodes.done;
}
