// E11.8-03: run before every build. Every founder note in
// src/content/weekly-notes/ must pass its rules: the file name `YYYY-Www.md`
// naming a real ISO week, plain prose of at most 120 words, at most one link
// and that link a path on the site's own origin, no image, HTML or merge
// field, and the copy rules, including the forbidden-copy list. Any problem
// fails the build.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  checkWeeklyNotes,
  weeklyNoteDirectory,
} from '../../src/server/email/weekly-note-content.ts';

const root = process.cwd();
const policy = JSON.parse(
  await readFile(join(root, 'scripts/forbidden-copy.json'), 'utf8'),
) as { entries: { term: string }[] };

const problems = checkWeeklyNotes(join(root, weeklyNoteDirectory), {
  forbiddenTerms: policy.entries.map(({ term }) => term),
});
if (problems.length > 0) {
  process.stderr.write(
    `A weekly note failed its checks:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n`,
  );
  process.exit(1);
}
