import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdminCommandError,
  runAdminCommandLine,
  type AdminCommandLine,
  type AdminCommandSet,
} from '../admin/cli.ts';

import { readTrustLedgerFigures, trustLedgerDraftSource } from './draft.ts';
import { isTrustLedgerMonth } from './month.ts';

// E11.8-01: the founder command `trust-ledger draft --month YYYY-MM`
// (`npm run trust-ledger -- draft --month YYYY-MM`). It reads the month's
// waitlist figures from GET /api/admin/trust-ledger/waitlist through the
// admin command line, so it passes the same E5-03a boundary with the secret
// key and a freshly typed authenticator code, and the route audits the read.
// It then writes a new entry file holding those counts and every other
// section empty for the founder to complete. It is the one founder command
// that writes a file, which is why it is not in the admin command line: it
// writes only the entry, never the key, the code or the raw response, and it
// never overwrites an entry. An existing entry is refused before anything is
// asked or sent; a file that appears meanwhile is refused at the write.

export const defaultTrustLedgerDirectory = fileURLToPath(
  new URL('../../content/trust-ledger/', import.meta.url),
);

const invocation = 'npm run trust-ledger -- <command>';

function draftMonth(args: readonly string[]): string {
  const month = args[1];
  if (
    args.length !== 2 ||
    args[0] !== '--month' ||
    month === undefined ||
    !isTrustLedgerMonth(month)
  ) {
    throw new AdminCommandError(
      'Name the month: --month YYYY-MM.\nUsage: npm run trust-ledger -- draft --month YYYY-MM',
    );
  }
  return month;
}

function entryExists(month: string): AdminCommandError {
  return new AdminCommandError(
    `An entry for ${month} already exists in src/content/trust-ledger/. A published entry never changes. Nothing was written.`,
  );
}

/** The Trust Ledger command set, writing entries into `directory`. */
export function trustLedgerCommands(
  directory: string = defaultTrustLedgerDirectory,
): AdminCommandSet {
  const entryPath = (month: string) => join(directory, `${month}.json`);
  return {
    'trust-ledger draft': {
      // Shown after the invocation, which already names the command set.
      usage: 'draft --month YYYY-MM',
      build(args) {
        return {
          method: 'GET',
          path: '/api/admin/trust-ledger/waitlist',
          query: { month: draftMonth(args) },
        };
      },
      async preflight(args) {
        const month = draftMonth(args);
        try {
          await access(entryPath(month));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw new AdminCommandError(
            'The entry folder could not be read. Nothing was sent.',
          );
        }
        throw entryExists(month);
      },
      async complete(body, args) {
        const month = draftMonth(args);
        const figures = readTrustLedgerFigures(body, month);
        if (figures === null) {
          throw new AdminCommandError(
            'The admin API returned unexpected figures. Nothing was written.',
          );
        }
        try {
          await mkdir(directory, { recursive: true });
          await writeFile(entryPath(month), trustLedgerDraftSource(figures), {
            flag: 'wx',
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw entryExists(month);
          throw new AdminCommandError(
            'The entry could not be written. Nothing was written.',
          );
        }
        return [
          `Wrote src/content/trust-ledger/${month}.json with the waitlist figures counted at ${figures.countedAt}:`,
          `total ${figures.verifiedTotal}, new this month ${figures.verifiedInMonth}, joined through a referral ${figures.verifiedInMonthThroughReferral}.`,
          'Complete every other section, then make the checks in docs/features/trust-ledger.md before publishing.',
        ];
      },
    },
  };
}

export function trustLedgerCommandLine(
  directory: string = defaultTrustLedgerDirectory,
): AdminCommandLine {
  return { commands: trustLedgerCommands(directory), invocation };
}

// `npm run trust-ledger -- draft --month YYYY-MM`: the script names the
// command set, so the founder types only the subcommand.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runAdminCommandLine(
    ['trust-ledger', ...process.argv.slice(2)],
    trustLedgerCommandLine(),
  );
}
