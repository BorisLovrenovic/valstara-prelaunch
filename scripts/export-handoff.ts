import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { once } from 'node:events';

import { createPool } from '../src/server/db/pool.ts';
import { exportHandoff } from '../src/server/subscriber/handoff.ts';

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv
    .slice(2)
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix} argument.`);
  return value;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const output = argument('output');
const actor = argument('actor');
const storeLaunchText = argument('store-launch-at');
if (
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(storeLaunchText)
) {
  throw new Error('Store launch must be an RFC 3339 UTC instant.');
}
const storeLaunchAt = new Date(storeLaunchText);
if (!Number.isFinite(storeLaunchAt.getTime()))
  throw new Error('Store launch instant is invalid.');
const database = createPool(databaseUrl);
const stream = createWriteStream(output, { flags: 'wx', mode: 0o600 });
try {
  const counts = await exportHandoff(
    database,
    actor,
    storeLaunchAt,
    async (record) => {
      if (!stream.write(`${JSON.stringify(record)}\n`))
        await once(stream, 'drain');
    },
  );
  stream.end();
  await once(stream, 'finish');
  process.stdout.write(`${JSON.stringify(counts)}\n`);
} catch (error) {
  stream.destroy();
  await rm(output, { force: true });
  throw error;
} finally {
  await database.close();
}
