import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import {
  countRehearsalRows,
  createRehearsalTables,
} from '../src/server/db/handoff-rehearsal.ts';
import { createPool } from '../src/server/db/pool.ts';
import { importRehearsal } from '../src/server/subscriber/handoff-rehearsal.ts';

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv
    .slice(2)
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix} argument.`);
  return value;
}

const adminUrlText = process.env.HANDOFF_REHEARSAL_ADMIN_URL;
if (!adminUrlText) throw new Error('HANDOFF_REHEARSAL_ADMIN_URL is required.');
const adminUrl = new URL(adminUrlText);
const input = argument('input');
const evidencePath = argument('evidence');
const inputHash = createHash('sha256');
for await (const chunk of createReadStream(input)) inputHash.update(chunk);
const inputSha256 = inputHash.digest('hex');
const admin = createPool(adminUrl.toString());
const rehearsals: Array<{
  rehearsal: number;
  firstImport: unknown;
  secondImport: unknown;
  finalCounts: unknown;
}> = [];

try {
  for (let number = 1; number <= 2; number += 1) {
    const name = `valstara_e1106_${randomUUID().replaceAll('-', '')}`;
    const scratchUrl = new URL(adminUrl);
    scratchUrl.pathname = `/${name}`;
    await admin.execute({ text: `CREATE DATABASE "${name}"` });
    const scratch = createPool(scratchUrl.toString());
    try {
      await createRehearsalTables(scratch);
      const load = () =>
        importRehearsal(
          scratch,
          createInterface({
            input: createReadStream(input),
            crlfDelay: Infinity,
          }),
        );
      const firstImport = await load();
      if (firstImport.createdCustomers === 0)
        throw new Error('A handoff rehearsal requires at least one customer.');
      const secondImport = await load();
      if (
        secondImport.createdCustomers !== 0 ||
        secondImport.createdDiscounts !== 0 ||
        secondImport.createdGroups !== 0 ||
        secondImport.createdReferrals !== 0
      ) {
        throw new Error('A repeated handoff import created additional rows.');
      }
      const finalCounts = await countRehearsalRows(scratch);
      if (
        finalCounts.customers !== firstImport.createdCustomers ||
        finalCounts.discounts !== firstImport.createdDiscounts ||
        finalCounts.groups !== firstImport.createdGroups ||
        finalCounts.referrals !== firstImport.createdReferrals
      ) {
        throw new Error(
          'Scratch database counts disagree with the first import.',
        );
      }
      rehearsals.push({
        rehearsal: number,
        firstImport,
        secondImport,
        finalCounts,
      });
    } finally {
      await scratch.close();
      await admin.list(
        {
          text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          values: [name],
        },
        10,
      );
      await admin.execute({ text: `DROP DATABASE "${name}"` });
    }
  }
  await writeFile(
    evidencePath,
    `${JSON.stringify({ ticket: 'E11-06', inputSha256, rehearsals }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(
    'Two scratch-database rehearsals passed; aggregate evidence written.\n',
  );
} finally {
  await admin.close();
}
