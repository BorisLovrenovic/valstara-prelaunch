import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { CurrentGiveawayRules } from './accrue.ts';

/** The maintenance process reads the same checked-in revisions Astro builds. */
export async function currentRulesFromFiles(
  directory = resolve(process.cwd(), 'src/content/giveaway-rules'),
): Promise<CurrentGiveawayRules> {
  const names = (await readdir(directory))
    .filter((name) => /^VAL-GW-[A-Z0-9]+-\d{8}-r[1-9]\d*\.md$/u.test(name))
    .sort((left, right) => {
      const leftParts = left.match(/-(\d{8})-r(\d+)\.md$/u);
      const rightParts = right.match(/-(\d{8})-r(\d+)\.md$/u);
      if (leftParts === null || rightParts === null) return 0;
      return (
        leftParts[1].localeCompare(rightParts[1]) ||
        Number(leftParts[2]) - Number(rightParts[2])
      );
    });
  const name = names.at(-1);
  if (name === undefined) throw new Error('No published giveaway rules exist.');
  const source = await readFile(join(directory, name), 'utf8');
  const rulesVersion = source.match(/^rulesVersion: (.+)$/mu)?.[1];
  const sha256 = source.match(/^sha256: ['"]?([a-f0-9]{64})['"]?$/mu)?.[1];
  if (rulesVersion !== name.slice(0, -3) || sha256 === undefined) {
    throw new Error('The published giveaway rules metadata is invalid.');
  }
  return { rulesVersion, sha256 };
}
