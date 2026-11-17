import { fileURLToPath } from 'node:url';

import { getDatabaseUrl } from '../config.ts';
import { createPool } from '../db/pool.ts';

import { campaignFlagKeys, isFlagKey } from './registry.ts';
import { createFlagService, flagCacheTtlMilliseconds } from './service.ts';
import type { FlagService } from './types.ts';

// The operator's incident lever (docs/ops/runbook.md#setting-a-campaign-flag).
// Every change goes through FlagService.set(), which audits it with the named
// actor; there is no path here that writes a flag without one.

const usage = [
  'Usage:',
  '  node ./src/server/flags/cli.ts list',
  '  node ./src/server/flags/cli.ts set <flag key> on|off --actor <name>',
  `Flag keys: ${campaignFlagKeys.join(', ')}`,
].join('\n');

export class FlagCommandError extends Error {
  public constructor(message: string) {
    super(`${message}\n${usage}`);
    this.name = 'FlagCommandError';
  }
}

export interface FlagCommandOutput {
  write(line: string): void;
}

export async function runFlagCommand(
  args: readonly string[],
  flags: Pick<FlagService, 'list' | 'set'>,
  output: FlagCommandOutput,
): Promise<void> {
  const [command, ...rest] = args;
  if (command === 'list' && rest.length === 0) {
    for (const flag of await flags.list())
      output.write(`${flag.key} ${flag.enabled ? 'on' : 'off'}`);
    return;
  }
  if (command !== 'set') throw new FlagCommandError('Unknown command.');

  const actorIndex = rest.indexOf('--actor');
  const actor = actorIndex === -1 ? undefined : rest[actorIndex + 1]?.trim();
  const positional =
    actorIndex === -1
      ? rest
      : [...rest.slice(0, actorIndex), ...rest.slice(actorIndex + 2)];
  if (actor === undefined || actor === '' || actor.startsWith('--'))
    throw new FlagCommandError('A flag change requires --actor <name>.');
  const [key, state] = positional;
  if (positional.length !== 2 || key === undefined || !isFlagKey(key))
    throw new FlagCommandError(`Unregistered flag key: ${String(key)}.`);
  if (state !== 'on' && state !== 'off')
    throw new FlagCommandError('The state must be on or off.');

  await flags.set(key, state === 'on', actor);
  output.write(
    `${key} is now ${state}, audited as ${actor}. Every process sees it within ${flagCacheTtlMilliseconds / 1_000} seconds.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const database = createPool(getDatabaseUrl());
  try {
    await runFlagCommand(process.argv.slice(2), createFlagService(database), {
      write: (line) => process.stdout.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'The flag command failed.'}\n`,
    );
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
