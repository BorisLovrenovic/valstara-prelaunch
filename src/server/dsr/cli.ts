import { getDatabaseUrl } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createErasureService } from './service.ts';
import { completeErasureCommand, reapplyErasureCommand } from './commands.ts';
export async function runDsrCommand(
  kind: 'complete' | 'reapply',
  args: readonly string[],
) {
  const database = createPool(getDatabaseUrl());
  try {
    const service = createErasureService(database, {
      clock: () => new Date(),
      alerts: { send: async () => undefined },
      // Manual/restore commands must never call a provider or broaden credentials.
      deleteContact: async () => {
        throw new Error('Provider calls are forbidden in recovery commands.');
      },
    });
    if (kind === 'complete') await completeErasureCommand(service, args);
    else await reapplyErasureCommand(database, service, args);
    process.stdout.write('Erasure command completed.\n');
  } catch {
    process.stderr.write('Erasure command failed; do not resume processing.\n');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
