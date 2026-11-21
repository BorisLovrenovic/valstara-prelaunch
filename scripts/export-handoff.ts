import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

import { createPool } from '../src/server/db/pool.ts';
import { assertCutoverEligible } from '../src/server/db/handoff.ts';
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
const database = createPool(databaseUrl);
const stream = createWriteStream(output, { flags: 'wx', mode: 0o600 });
let outputFinished = false;
try {
  await assertCutoverEligible(database);
  const counts = await exportHandoff(
    database,
    actor,
    async (record) => {
      if (!stream.write(`${JSON.stringify(record)}\n`))
        await once(stream, 'drain');
    },
    async () => {
      const completed = finished(stream);
      stream.end();
      await completed;
      outputFinished = true;
    },
  );
  process.stdout.write(`${JSON.stringify(counts)}\n`);
} catch (error) {
  stream.destroy();
  if (!outputFinished) await rm(output, { force: true });
  throw error;
} finally {
  await database.close();
}
