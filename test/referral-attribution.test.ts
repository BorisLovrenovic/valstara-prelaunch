import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const repositorySourceExtensions = new Set(['.astro', '.sql', '.ts']);
const referralChainTraversal = /WITH\s+RECURSIVE\b|referral[_ -]chain/iu;

interface SourceFile {
  readonly contents: string;
  readonly path: string;
}

function repositorySourceFiles(repositoryRoot: string): readonly SourceFile[] {
  const sourceDirectory = join(repositoryRoot, 'src');
  const files: SourceFile[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        entry.isFile() &&
        repositorySourceExtensions.has(extname(path))
      ) {
        files.push({
          contents: readFileSync(path, 'utf8'),
          path: relative(repositoryRoot, path),
        });
      }
    }
  }

  visit(sourceDirectory);
  return files;
}

function assertNoReferralChainTraversal(sources: readonly SourceFile[]): void {
  for (const source of sources) {
    assert.doesNotMatch(
      source.contents,
      referralChainTraversal,
      `${source.path} must not walk a referral chain`,
    );
  }
}

interface DatabaseFixture {
  readonly database: DatabasePool;
  readonly applicationDatabase: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e403_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const applicationUrl = new URL(databaseUrl);
  applicationUrl.username = 'valstara_app';
  applicationUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e4-03-test',
  });

  return {
    applicationDatabase: createPool(applicationUrl.toString()),
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
  values: {
    readonly code?: string;
    readonly status?: 'pending' | 'verified';
  } = {},
): Promise<string> {
  const id = randomUUID();
  const status = values.status ?? 'pending';
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, referral_code, verified_at
      )
      VALUES ($1, $2, $3, 'example.test', $4, $5, $6)
    `,
    values: [
      id,
      `${id}@example.test`,
      `${id}@example.test`,
      status,
      values.code ?? null,
      status === 'verified' ? new Date('2026-09-12T12:00:00.000Z') : null,
    ],
  });
  return id;
}

async function edgeCount(
  database: DatabasePool,
  referredId: string,
): Promise<number> {
  const row = await database.readOne<{ count: string }>({
    text: 'SELECT COUNT(*)::text AS count FROM referral_edge WHERE referred_id = $1',
    values: [referredId],
  });
  return Number(row?.count ?? '0');
}

test('concurrent attribution writes exactly one database-backed edge and stamps its referrer once', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrerId = await insertSubscriber(fixture.database, {
      code: 'ABCDEFGHJKMN',
      status: 'verified',
    });
    const referredId = await insertSubscriber(fixture.database);
    const service = createReferralService(fixture.applicationDatabase);

    const results = await Promise.all([
      service.attribute(referredId, 'abcdefghjkmn'),
      service.attribute(referredId, 'ABCDEFGHJKMN'),
    ]);

    assert.equal(
      results.filter((result) => result.kind === 'attributed').length,
      1,
    );
    assert.equal(await edgeCount(fixture.database, referredId), 1);
    assert.deepEqual(
      await fixture.database.readOne<{ referred_by_id: string | null }>({
        text: 'SELECT referred_by_id FROM subscriber WHERE id = $1',
        values: [referredId],
      }),
      { referred_by_id: referrerId },
    );

    const directReferredId = await insertSubscriber(fixture.database);
    const writes = await Promise.allSettled([
      fixture.database.execute({
        text: `
          INSERT INTO referral_edge (
            id, referrer_id, referred_id, state, reward_state
          ) VALUES ($1, $2, $3, 'attributed', 'none')
        `,
        values: [randomUUID(), referrerId, directReferredId],
      }),
      fixture.database.execute({
        text: `
          INSERT INTO referral_edge (
            id, referrer_id, referred_id, state, reward_state
          ) VALUES ($1, $2, $3, 'attributed', 'none')
        `,
        values: [randomUUID(), referrerId, directReferredId],
      }),
    ]);
    assert.equal(
      writes.filter((write) => write.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      writes.some(
        (write) =>
          write.status === 'rejected' &&
          typeof write.reason === 'object' &&
          write.reason !== null &&
          'code' in write.reason &&
          write.reason.code === '23505',
      ),
      true,
    );
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});

test('self-referral is flagged while the repeat signup remains accepted and has no edge', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(fixture.database, {
      code: 'ABCDEFGHJKMN',
      status: 'verified',
    });
    const signup = createSignupService(fixture.applicationDatabase, {
      attributeReferral: (referredId, code, allowAttribution) =>
        createReferralService(fixture.applicationDatabase).attribute(
          referredId,
          code,
          allowAttribution,
        ),
      isReferralEnabled: async () => true,
      async sendVerificationMail() {
        return undefined;
      },
    });

    const result = await signup({
      country: 'GB',
      email: `${subscriberId}@example.test`,
      referralCode: 'ABCDEFGHJKMN',
      verificationUrl: (token) => `https://valstara.test/verify?token=${token}`,
    });

    assert.equal(result.kind, 'already_verified');
    assert.equal(await edgeCount(fixture.database, subscriberId), 0);
    assert.deepEqual(
      await fixture.database.readOne<{ kind: string; detail: unknown }>({
        text: `
          SELECT kind, detail
          FROM fraud_flag
          WHERE subscriber_id = $1 AND kind = 'self_referral'
        `,
        values: [subscriberId],
      }),
      { kind: 'self_referral', detail: { reason: 'self_referral' } },
    );
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});

test('unknown codes and disabled attribution leave a signup unattributed', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const attributed: string[] = [];
    const signup = createSignupService(fixture.applicationDatabase, {
      attributeReferral: async (_referredId, code) => {
        attributed.push(code);
      },
      isReferralEnabled: async () => false,
      async sendVerificationMail() {
        return undefined;
      },
    });
    const result = await signup({
      country: 'GB',
      email: 'flag-off@example.test',
      referralCode: 'UNKNOWNCODE1',
      verificationUrl: (token) => `https://valstara.test/verify?token=${token}`,
    });
    assert.equal(result.kind, 'created');
    assert.deepEqual(attributed, []);

    const referredId = await insertSubscriber(fixture.database);
    const unknown = await createReferralService(
      fixture.applicationDatabase,
    ).attribute(referredId, 'UNKNOWNCODE1');
    assert.deepEqual(unknown, { kind: 'unattributed' });
    assert.equal(await edgeCount(fixture.database, referredId), 0);
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});

test('the edge remains single-level and referred_by_id is database write-once', async () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const sources = repositorySourceFiles(repositoryRoot);
  assert.equal(
    sources.some((source) => source.path === 'src/server/db/referral.ts'),
    true,
  );
  assertNoReferralChainTraversal(sources);
  assert.throws(
    () =>
      assertNoReferralChainTraversal([
        {
          contents: 'WITH RECURSIVE referral_chain AS (SELECT 1)',
          path: 'src/server/db/referral.ts',
        },
      ]),
    /src\/server\/db\/referral\.ts must not walk a referral chain/u,
  );

  const fixture = await createDatabaseFixture();
  try {
    const firstReferrer = await insertSubscriber(fixture.database, {
      code: 'ABCDEFGHJKMN',
      status: 'verified',
    });
    const secondReferrer = await insertSubscriber(fixture.database, {
      code: 'PQRSTUVWXY234',
      status: 'verified',
    });
    const referredId = await insertSubscriber(fixture.database);
    const service = createReferralService(fixture.applicationDatabase);
    await service.attribute(referredId, 'ABCDEFGHJKMN');
    await assert.rejects(
      fixture.database.execute({
        text: 'UPDATE subscriber SET referred_by_id = $2 WHERE id = $1',
        values: [referredId, secondReferrer],
      }),
      /referred_by_id is write-once/u,
    );
    assert.notEqual(firstReferrer, secondReferrer);
  } finally {
    await fixture.applicationDatabase.close();
    await fixture.dispose();
  }
});
