import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseFrontmatter } from 'astro/markdown';

import type { CurrentGiveawayRules } from './accrue.ts';
import {
  rulesEntryStamp,
  validateRulesCatalog,
  validateRulesMetadata,
} from './rules.ts';

/** Use Astro's frontmatter parser and the rules catalog's metadata checks. */
export async function currentRulesFromFiles(
  directory = resolve(process.cwd(), 'src/content/giveaway-rules'),
): Promise<CurrentGiveawayRules> {
  const revisions = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.md')) continue;
    const source = await readFile(join(directory, name), 'utf8');
    revisions.push(
      validateRulesMetadata(name, parseFrontmatter(source).frontmatter),
    );
  }
  return rulesEntryStamp(validateRulesCatalog(revisions).current);
}
