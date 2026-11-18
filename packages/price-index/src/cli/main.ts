import { systemClock } from '../http/clock.ts';
import { runReview } from './review.ts';
import { formatIssues, validateConfig } from './validate.ts';

// `npm run price-index -- <command>`. The tool runs only when the founder (or
// `npm run check`, for `validate`) types this, does its work and exits. It has
// no daemon, timer, watcher or server (ADR-033).

export const exitCodes = {
  done: 0,
  usage: 1,
  validationFailure: 3,
} as const;

const usage = `Usage: npm run price-index -- <command>

Commands:
  validate   Check config/markets.json, config/catalogue.json,
             config/valstara-prices.json and config/price-index.json
             against their schemas.
  review approve|reject --market <code> --service <service_id>
             --plan <plan_id> --actor <name>
             Decide on the value a needs_review or conflict record in
             data/price-index/latest.json shows, and record the decision
             in data/price-index/approvals.json.
`;

export interface CliIo {
  root: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The time decisions are stamped with. Tests inject a fixed one. */
  clock?: { now(): Date };
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;

  if (command === 'validate' && rest.length === 0) {
    const issues = await validateConfig(io.root);
    if (issues.length > 0) {
      io.stderr(
        `price-index validate: ${issues.length} problem(s)\n${formatIssues(issues)}\n`,
      );
      return exitCodes.validationFailure;
    }
    io.stdout('price-index validate: configuration is valid.\n');
    return exitCodes.done;
  }

  if (command === 'review') {
    return runReview(rest, { ...io, clock: io.clock ?? systemClock });
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
