import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  referralCodeAlphabet,
  referralCodeLength,
} from '../src/server/referral/config.ts';
import {
  createReferralCode,
  createReferralService,
} from '../src/server/referral/service.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const generatedSampleSize = 20_000;
const codePattern = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/u;

interface DatabaseFixture {
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e401_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e4-01-test',
  });

  return {
    database,
    async dispose() {
      await database.close();
      await admin.list(
        {
          text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          values: [databaseName],
        },
        10,
      );
      await admin.execute({ text: `DROP DATABASE "${databaseName}"` });
      await admin.close();
    },
  };
}

async function insertSubscriber(
  database: DatabasePool,
  status: 'pending' | 'verified',
): Promise<string> {
  const id = randomUUID();
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at
      )
      VALUES ($1, $2, $3, 'example.test', $4, $5)
    `,
    values: [
      id,
      `${id}@example.test`,
      `${id}@example.test`,
      status,
      status === 'verified' ? new Date('2026-09-11T12:00:00.000Z') : null,
    ],
  });
  return id;
}

function shannonEntropy(counts: ReadonlyMap<string, number>, total: number) {
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / total;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

test('codes have a large keyspace and a uniform, non-sequential large-sample distribution', () => {
  assert.equal(referralCodeAlphabet.length, 31);
  assert.equal(referralCodeLength, 12);
  assert.ok(
    Math.log2(referralCodeAlphabet.length) * referralCodeLength > 59,
    'the configured code space must exceed 59 bits',
  );

  const codes = new Set<string>();
  const symbolCounts = new Map(
    [...referralCodeAlphabet].map((symbol) => [symbol, 0]),
  );
  let equalAdjacentPositions = 0;
  let adjacentPositionComparisons = 0;
  let previous: string | null = null;

  for (let index = 0; index < generatedSampleSize; index += 1) {
    const code = createReferralCode();
    assert.match(code, codePattern);
    codes.add(code);

    for (const symbol of code) {
      symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
    }
    if (previous !== null) {
      for (let position = 0; position < referralCodeLength; position += 1) {
        equalAdjacentPositions += Number(code[position] === previous[position]);
        adjacentPositionComparisons += 1;
      }
    }
    previous = code;
  }

  assert.equal(codes.size, generatedSampleSize);
  const symbolTotal = generatedSampleSize * referralCodeLength;
  const expectedPerSymbol = symbolTotal / referralCodeAlphabet.length;
  const chiSquared = [...symbolCounts.values()].reduce(
    (sum, count) => sum + (count - expectedPerSymbol) ** 2 / expectedPerSymbol,
    0,
  );

  const maximumSymbolEntropy = Math.log2(referralCodeAlphabet.length);
  assert.ok(
    shannonEntropy(symbolCounts, symbolTotal) > maximumSymbolEntropy - 0.01,
    'the empirical per-symbol entropy must remain close to its maximum',
  );
  assert.ok(
    chiSquared < 100,
    `the symbol distribution is unexpectedly biased (chi-squared ${chiSquared})`,
  );
  assert.ok(
    equalAdjacentPositions / adjacentPositionComparisons < 0.05,
    'successive codes must not exhibit the shared-prefix pattern of a sequence',
  );
});

test('a database collision regenerates and lookup is case-insensitive', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const firstId = await insertSubscriber(fixture.database, 'verified');
    const secondId = await insertSubscriber(fixture.database, 'verified');
    const existingCode = 'ABCDEFGHJKMN';
    const replacementCode = 'QRSTUVWXYZ23';

    assert.equal(
      await createReferralService(fixture.database, {
        createCode: () => existingCode,
      }).generateCode(firstId),
      existingCode,
    );

    let calls = 0;
    const service = createReferralService(fixture.database, {
      createCode: () => {
        calls += 1;
        return calls === 1 ? existingCode : replacementCode;
      },
    });
    assert.equal(await service.generateCode(secondId), replacementCode);
    assert.equal(calls, 2);
    assert.equal(
      await service.lookupCode(replacementCode.toLowerCase()),
      secondId,
    );
  } finally {
    await fixture.dispose();
  }
});

test('allocation is verified-only and concurrent calls return one persisted code', async () => {
  const fixture = await createDatabaseFixture();
  try {
    await assert.rejects(
      createReferralService(fixture.database).generateCode(randomUUID()),
      /requires an existing subscriber/u,
    );

    const pendingId = await insertSubscriber(fixture.database, 'pending');
    let pendingGeneratorCalls = 0;
    await assert.rejects(
      createReferralService(fixture.database, {
        createCode: () => {
          pendingGeneratorCalls += 1;
          return 'BCDEFGHJKLMN';
        },
      }).generateCode(pendingId),
      /requires a verified subscriber/u,
    );
    assert.equal(pendingGeneratorCalls, 0);
    assert.equal(
      await createReferralService(fixture.database).getReferralCode(pendingId),
      null,
    );

    const verifiedId = await insertSubscriber(fixture.database, 'verified');
    const [first, second] = await Promise.all([
      createReferralService(fixture.database, {
        createCode: () => 'CDEFGHJKLMNP',
      }).generateCode(verifiedId),
      createReferralService(fixture.database, {
        createCode: () => 'DEFGHJKLMNPQ',
      }).generateCode(verifiedId),
    ]);

    assert.equal(first, second);
    assert.equal(
      await createReferralService(fixture.database).getReferralCode(verifiedId),
      first,
    );
  } finally {
    await fixture.dispose();
  }
});
