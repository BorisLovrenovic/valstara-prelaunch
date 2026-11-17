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
  validate   Check config/markets.json, config/catalogue.json and
             config/valstara-prices.json against their schemas.
`;

export interface CliIo {
  root: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
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
