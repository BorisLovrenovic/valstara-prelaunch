// E11.8-01: run before every build. Every file in src/content/trust-ledger/
// must be a Trust Ledger entry, `YYYY-MM.json`, holding that month and
// passing the entry schema, with no forbidden-copy term. Any problem fails
// the build. The site's bundle validates the same entries again
// (src/server/trust-ledger/bundled.ts), so the build cannot pass over one.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  trustLedgerDirectory,
  trustLedgerFileProblems,
} from '../../src/server/trust-ledger/ledger.ts';

const root = process.cwd();
const policy = JSON.parse(
  await readFile(join(root, 'scripts/forbidden-copy.json'), 'utf8'),
) as { entries: { term: string }[] };

const directory = join(root, trustLedgerDirectory);
let names: string[];
try {
  names = (await readdir(directory)).filter((name) => !name.startsWith('.'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  names = [];
}
const files: Record<string, unknown> = {};
const problems: string[] = [];
for (const name of names.sort()) {
  const source = await readFile(join(directory, name), 'utf8');
  for (const { term } of policy.entries) {
    if (
      new RegExp(
        `\\b${term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`,
        'iu',
      ).test(source)
    )
      problems.push(`${name}: forbidden copy "${term}"`);
  }
  try {
    files[name] = JSON.parse(source);
  } catch {
    problems.push(`${name}: not valid JSON`);
    files[name] = null;
  }
}
problems.push(...trustLedgerFileProblems(files));
if (problems.length > 0) {
  process.stderr.write(
    `A Trust Ledger entry failed its checks:\n${[...new Set(problems)].map((problem) => `- ${problem}`).join('\n')}\n`,
  );
  process.exit(1);
}
