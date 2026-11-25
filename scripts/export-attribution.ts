// E11.7-14: `npm run export:attribution -- --actor=<operator> --output=<new directory>`.
// Writes the attribution export (docs/data/attribution-export.md) into a new
// private directory: attribution.json and one CSV per record type. A failure
// removes the directory, so a partial export never remains to be imported.
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

import { createPool } from '../src/server/db/pool.ts';
import {
  attributionExportFiles,
  exportAttribution,
  type AttributionExportFile,
} from '../src/server/partner/attribution-export.ts';

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

// `recursive: false` refuses an existing directory, so an earlier export is
// never overwritten or mixed with this one.
await mkdir(output, { recursive: false, mode: 0o700 });
const streams = new Map<AttributionExportFile, WriteStream>(
  attributionExportFiles.map((file) => [
    file,
    createWriteStream(join(output, file), { flags: 'wx', mode: 0o600 }),
  ]),
);
const database = createPool(databaseUrl);
let completed = false;
try {
  const counts = await exportAttribution(
    database,
    actor,
    async (file, chunk) => {
      const stream = streams.get(file);
      if (stream === undefined) throw new Error(`Unknown export file ${file}.`);
      if (!stream.write(chunk)) await once(stream, 'drain');
    },
  );
  await Promise.all(
    [...streams.values()].map(async (stream) => {
      const done = finished(stream);
      stream.end();
      await done;
    }),
  );
  completed = true;
  process.stdout.write(`${JSON.stringify(counts)}\n`);
} finally {
  if (!completed) {
    for (const stream of streams.values()) stream.destroy();
    await rm(output, { recursive: true, force: true });
  }
  await database.close();
}
