import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { currentRulesFromFiles } from './current-rules-file.ts';

export interface CurrentDrawRules {
  readonly prizeCount: number;
  readonly rulesVersion: string;
  readonly rulesSha256: string;
  readonly bundleContentsListed: boolean;
}

export async function currentDrawRulesFromFiles(
  directory = resolve(process.cwd(), 'src/content/giveaway-rules'),
): Promise<CurrentDrawRules> {
  const rules = await currentRulesFromFiles(directory);
  const source = await readFile(
    resolve(directory, `${rules.rulesVersion}.md`),
    'utf8',
  );
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---/u)?.[1];
  if (frontmatter === undefined)
    throw new Error('The current giveaway rules have no frontmatter.');
  const count = Number(frontmatter.match(/^prizeCount: ([1-9]\d*)$/mu)?.[1]);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('The current giveaway rules have no valid prize count.');
  }
  const contentLine = frontmatter.match(/^bundleContents:([^\n]*)$/mu);
  if (contentLine === null)
    throw new Error('The current rules have no bundle contents field.');
  const contents = contentLine[1].trim();
  let listed = false;
  if (contents === '') {
    const following = frontmatter.slice(
      (contentLine.index ?? 0) + contentLine[0].length,
    );
    listed = /^\n[ \t]+-[ \t]+\S+/u.test(following);
  } else if (contents.startsWith('[') && contents.endsWith(']')) {
    listed = contents.slice(1, -1).trim().length > 0;
  } else if (
    contents !== "'to be announced'" &&
    contents !== '"to be announced"'
  ) {
    throw new Error('The current bundle contents are not a validated list.');
  }
  return {
    prizeCount: count,
    rulesVersion: rules.rulesVersion,
    rulesSha256: rules.sha256,
    bundleContentsListed: listed,
  };
}
