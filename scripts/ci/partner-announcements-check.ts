// E11.7-16: run before every build. Every partner announcement in
// src/content/partner-announcements/ must pass its rules: the file name, a
// subject of at most 80 characters, plain prose of at most 300 words, at most
// three links to the site's own pages, no image, HTML or merge field, and the
// copy rules, including the forbidden-copy list. Any problem fails the build.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkPartnerAnnouncements } from '../../src/server/partner/announcement-content.ts';

const root = process.cwd();
const policy = JSON.parse(
  await readFile(join(root, 'scripts/forbidden-copy.json'), 'utf8'),
) as { entries: { term: string }[] };

const problems = checkPartnerAnnouncements(
  join(root, 'src/content/partner-announcements'),
  { forbiddenTerms: policy.entries.map(({ term }) => term) },
);
if (problems.length > 0) {
  process.stderr.write(
    `A partner announcement failed its checks:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n`,
  );
  process.exit(1);
}
