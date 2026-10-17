import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createDsrRepository } from '../db/dsr.ts';
import type { DatabasePool } from '../db/pool.ts';
import type { createErasureService } from './service.ts';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function commandOptions(
  args: readonly string[],
  names: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!,
      value = args[i + 1];
    if (!names.includes(name) || !value?.trim() || result[name])
      throw new Error('Invalid command arguments.');
    result[name] = value;
  }
  if (names.some((name) => !result[name]))
    throw new Error('Missing required command argument.');
  return result;
}
export async function completeErasureCommand(
  service: Pick<ReturnType<typeof createErasureService>, 'completeManually'>,
  args: readonly string[],
) {
  const options = commandOptions(args, ['--subscriber-id', '--actor']);
  if (!uuid.test(options['--subscriber-id']!))
    throw new Error('Invalid subscriber ID.');
  await service.completeManually(
    options['--subscriber-id']!,
    options['--actor']!,
  );
}
export async function requestErasureCommand(
  service: Pick<ReturnType<typeof createErasureService>, 'requestManually'>,
  args: readonly string[],
) {
  const options = commandOptions(args, [
    '--subscriber-id',
    '--actor',
    '--evidence-ref',
  ]);
  if (!uuid.test(options['--subscriber-id']!))
    throw new Error('Invalid subscriber ID.');
  await service.requestManually(
    options['--subscriber-id']!,
    options['--actor']!,
    options['--evidence-ref']!,
  );
}
export async function reapplyErasureCommand(
  database: DatabasePool,
  service: Pick<ReturnType<typeof createErasureService>, 'reapply'>,
  args: readonly string[],
) {
  const options = commandOptions(args, ['--ledger-file', '--actor']);
  const lines = createInterface({
    input: createReadStream(options['--ledger-file']!),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (line.length > 256) throw new Error('Invalid erasure ledger row.');
    const row: unknown = JSON.parse(line);
    if (
      typeof row !== 'object' ||
      row === null ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(',') !== 'erased_at,subscriber_id'
    )
      throw new Error('Invalid erasure ledger shape.');
    const { subscriber_id: id, erased_at: at } = row as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      !uuid.test(id) ||
      typeof at !== 'string' ||
      !Number.isFinite(Date.parse(at))
    )
      throw new Error('Invalid erasure ledger values.');
    await service.reapply(id, new Date(at), options['--actor']!);
  }
  // Also apply every ID already in the destination's ledger. Memory and SQL
  // batches stay bounded even when a newer off-host ledger is much larger.
  let after: string | null = null;
  for (;;) {
    const rows = await createDsrRepository(database).ledger(after);
    for (const row of rows)
      await service.reapply(
        row.subscriber_id,
        row.erased_at,
        options['--actor']!,
      );
    if (rows.length === 0) break;
    after = rows.at(-1)!.subscriber_id;
  }
}
