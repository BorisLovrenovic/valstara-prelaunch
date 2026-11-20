import { systemClock } from '../http/clock.ts';
import { runBuildData } from './build-data.ts';
import { runOverride } from './override.ts';
import { runMonthlyReport } from './monthly-report.ts';
import { linePrompt, type Prompt } from './prompt.ts';
import { runReport } from './report.ts';
import { runRetireUrl } from './retire-url.ts';
import { runReview } from './review.ts';
import { runScrape, type ScrapeEnvironment } from './scrape.ts';
import { formatIssues, loadConfig, validateDataFiles } from './validate.ts';

// `npm run price-index -- <command>`. The tool runs only when the founder (or
// `npm run check`, for `validate`) types this, does its work and exits. It has
// no daemon, timer, watcher or server (ADR-033). Nothing here calls
// process.exit: the process ends because nothing is left open, which
// test/price-index/cli-exit.test.ts proves for every command.

export const exitCodes = {
  done: 0,
  /** A usage error, or a request refused before anything was written. */
  usage: 1,
  /** The source refused the run: backoff ran out, or it asked too long a wait. */
  stoppedBySource: 2,
  /** A configuration or data file fails its schema, or the merge refuses it. */
  validationFailure: 3,
  /** SIGINT or SIGTERM stopped the run; it can be resumed. */
  interrupted: 4,
} as const;

const usage = `Usage: npm run price-index -- <command>

Commands:
  validate   Check the configuration (config/markets.json,
             config/catalogue.json, config/valstara-prices.json,
             config/price-index.json) and every data file
             (data/price-index/ and reports/runs/) against their schemas.
  scrape [--market <code>] [--resume <run_id>]
             Fetch the source politely, store the raw pages, and write the
             run's observations and a preview merge to data/raw/<run_id>/.
             Never writes data/price-index/latest.json.
  scrape --dry-run [--from-fixtures] [--market <code>]
             Replay the latest raw run (or the captured fixtures) and print
             what a build would change. Fetches nothing, writes nothing.
  review approve|reject --market <code> --service <service_id>
             --plan <plan_id> --actor <name>
             Decide on the value a needs_review or conflict record in the
             preview of the latest run shows, and record the decision in
             data/price-index/approvals.json.
  build-data Merge the latest run's observations with the overrides and
             approvals, and on full validation append the real price
             changes to data/price-index/changes.json and write
             latest.json, a snapshot, reports/runs/<run_id>.json and the
             final coverage report.
  monthly-report --month YYYY-MM
             Write the month's report from its last build and the change
             log: data/price-index/monthly/YYYY-MM.json for the page, and
             reports/monthly/YYYY-MM.md for outreach, with the founder-only
             cross-check against the source's price moves.
  report     Write the coverage report of the latest run, as build-data
             would build it now, to reports/coverage-YYYY-MM-DD.md and .json.
  override add|not-offered|retire
             Add a manual price, record a confirmed not_offered, or retire
             a manual entry in data/price-index/manual-overrides.json,
             answering one question per line.
  retire-url <url> --to <hub> --actor <name>
             Retire a published price page URL: append a retirement to
             data/price-index/published-urls.json, so the URL answers 301
             to the hub (/prices/{service} or /prices/countries/{country}).

Exit codes: 0 done, 1 usage or refused, 2 stopped by the source,
3 validation failure, 4 interrupted.
`;

export interface CliIo {
  root: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The time decisions and builds are stamped with. Tests inject a fixed one. */
  clock?: { now(): Date };
  /** What a real scrape needs from outside. Tests inject a fake browser. */
  scrape?: ScrapeEnvironment;
  /** Where `override` reads its answers. Defaults to standard input. */
  prompt?: Prompt;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;

  if (command === 'validate' && rest.length === 0) {
    const loaded = await loadConfig(io.root);
    const issues = [
      ...loaded.issues,
      ...(await validateDataFiles(io.root, loaded.config)),
    ];
    if (issues.length > 0) {
      io.stderr(
        `price-index validate: ${issues.length} problem(s)\n${formatIssues(issues)}\n`,
      );
      return exitCodes.validationFailure;
    }
    io.stdout(
      'price-index validate: configuration is valid, and so is every data file.\n',
    );
    return exitCodes.done;
  }

  if (command === 'scrape') {
    return runScrape(rest, {
      root: io.root,
      stdout: io.stdout,
      stderr: io.stderr,
      ...(io.scrape === undefined ? {} : { environment: io.scrape }),
    });
  }

  if (command === 'build-data') {
    return runBuildData(rest, { ...io, clock: io.clock ?? systemClock });
  }

  if (command === 'review') {
    return runReview(rest, { ...io, clock: io.clock ?? systemClock });
  }

  if (command === 'report') {
    return runReport(rest, { ...io, clock: io.clock ?? systemClock });
  }

  if (command === 'monthly-report') {
    return runMonthlyReport(rest, io);
  }

  if (command === 'retire-url') {
    return runRetireUrl(rest, { ...io, clock: io.clock ?? systemClock });
  }

  if (command === 'override') {
    // Standard input is opened only here, so no other command holds it.
    return runOverride(rest, {
      ...io,
      clock: io.clock ?? systemClock,
      prompt: io.prompt ?? linePrompt(process.stdin, io.stdout),
    });
  }

  io.stderr(usage);
  return exitCodes.usage;
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  process.exitCode = await runCli(process.argv.slice(2), {
    root: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
