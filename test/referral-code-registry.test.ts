import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { exportSubjectPage } from '../src/server/db/dsr-export.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import {
  createPool,
  type DatabaseClient,
  type DatabasePool,
} from '../src/server/db/pool.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import { createReferralCodeRegistry } from '../src/server/referral/code-registry.ts';
import { createPartnerCodeRules } from '../src/server/referral/partner-code.ts';
import { createReferralService } from '../src/server/referral/service.ts';

// E11.7-01: the shared code registry. Every test runs against a real,
// freshly migrated database; runtime calls use the least-privilege app role.

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const registryMigration = '0058-referral-code-registry.sql';
const migrationDirectory = fileURLToPath(
  new URL('../src/server/db/migrations/', import.meta.url),
);

interface Fixture {
  readonly app: DatabasePool;
  readonly owner: DatabasePool;
  dispose(): Promise<void>;
}

async function createFixture(
  beforeRegistry?: (owner: DatabasePool) => Promise<void>,
): Promise<Fixture> {
  const databaseName = `valstara_e11701_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const owner = createPool(databaseUrl.toString());

  if (beforeRegistry !== undefined) {
    // Migrate to the release before the registry, seed, then apply it and
    // every later migration.
    const directory = await mkdtemp(join(tmpdir(), 'valstara-e11701-'));
    try {
      await cp(migrationDirectory, directory, {
        filter: (source) => {
          const name = basename(source);
          return !name.endsWith('.sql') || name < registryMigration;
        },
        recursive: true,
      });
      await runMigrations(owner, {
        applicationRolePassword,
        directory,
        release: 'e11-7-01-before',
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
    await beforeRegistry(owner);
  }
  await runMigrations(owner, {
    applicationRolePassword,
    release: 'e11-7-01-test',
  });

  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = applicationRolePassword;
  const app = createPool(appUrl.toString());
  return {
    app,
    owner,
    async dispose() {
      await app.close();
      await owner.close();
      await admin.execute({
        text: `DROP DATABASE "${databaseName}" WITH (FORCE)`,
      });
      await admin.close();
    },
  };
}

async function insertSubscriber(
  database: DatabasePool,
  options: { readonly code?: string | null; readonly status?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const status = options.status ?? 'verified';
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at
      )
      VALUES ($1, $2, $2, 'example.test', $3, $4)
    `,
    values: [
      id,
      `${id}@example.test`,
      status,
      status === 'verified' ? new Date('2026-11-01T09:00:00.000Z') : null,
    ],
  });
  if (options.code !== undefined && options.code !== null) {
    await database.execute({
      text: 'UPDATE subscriber SET referral_code = $2 WHERE id = $1',
      values: [id, options.code],
    });
  }
  return id;
}

async function insertPartnerCode(
  database: DatabasePool,
  code: string,
  partnerId: string = randomUUID(),
): Promise<string> {
  // No partner table exists before E11.7-05; the owner is an opaque id.
  await database.execute({
    text: `INSERT INTO referral_code (code, owner_kind, owner_id) VALUES ($1, 'partner', $2)`,
    values: [code, partnerId],
  });
  return partnerId;
}

async function activatePartnerCode(
  database: DatabasePool,
  code: string,
): Promise<void> {
  // Stands in for partner activation (E11.7-07), run as the owner role
  // because the application role has no UPDATE.
  await database.execute({
    text: `UPDATE referral_code SET active = true WHERE code = $1 AND owner_kind = 'partner'`,
    values: [code],
  });
}

async function registryRows(database: DatabasePool, code: string) {
  return database.list<{
    active: boolean;
    code: string;
    owner_id: string | null;
    owner_kind: string;
  }>(
    {
      text: `
        SELECT code, owner_kind, owner_id, active
        FROM referral_code
        WHERE upper(code) = upper($1)
        ORDER BY code
      `,
      values: [code],
    },
    10,
  );
}

function pgCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

async function waitUntilLockWaiting(
  database: DatabasePool,
  backendPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = await database.readOne<{ waiting: boolean }>({
      text: `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
      values: [backendPid],
    });
    if (row?.waiting === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('the second writer never waited on the first writer');
}

async function backendPid(client: DatabaseClient): Promise<number> {
  const row = await client.readOne<{ pid: number }>({
    text: 'SELECT pg_backend_pid() AS pid',
  });
  assert.ok(row);
  return row.pid;
}

test('the database refuses a code that is not upper case, and a malformed partner code', async () => {
  const fixture = await createFixture();
  try {
    for (const code of ['maya', 'Maya2026', 'mAYA']) {
      await assert.rejects(insertPartnerCode(fixture.owner, code), (error) => {
        assert.equal(pgCode(error), '23514', code);
        return true;
      });
    }
    for (const code of ['ABC', 'ABCDEFGHJKMNPQRST', 'MAYA-1', 'MAYA 1']) {
      await assert.rejects(insertPartnerCode(fixture.owner, code), (error) => {
        assert.equal(pgCode(error), '23514', code);
        return true;
      });
    }
    await assert.rejects(
      fixture.owner.execute({
        text: `INSERT INTO referral_code (code, owner_kind, owner_id) VALUES ('ROGUE1', 'vendor', $1)`,
        values: [randomUUID()],
      }),
      (error) => pgCode(error) === '23514',
    );

    // The application role reads and inserts, and can neither rewrite nor
    // delete a code.
    await insertPartnerCode(fixture.owner, 'GRANTS1');
    await assert.rejects(
      fixture.app.execute({
        text: `UPDATE referral_code SET active = false WHERE code = 'GRANTS1'`,
      }),
      (error) => pgCode(error) === '42501',
    );
    await assert.rejects(
      fixture.app.execute({
        text: `DELETE FROM referral_code WHERE code = 'GRANTS1'`,
      }),
      (error) => pgCode(error) === '42501',
    );
    await assert.rejects(
      fixture.owner.execute({
        text: `UPDATE referral_code SET code = 'GRANTS2' WHERE code = 'GRANTS1'`,
      }),
      /immutable/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test('a partner code always enters the registry inactive; a member code still inserts active', async () => {
  const fixture = await createFixture();
  try {
    const registry = createReferralCodeRegistry(fixture.app);

    // As the application role, with an owner: stored inactive, and lookup
    // reports it inactive.
    const partnerId = await insertPartnerCode(fixture.app, 'MAYA2026');
    assert.deepEqual(await registryRows(fixture.owner, 'MAYA2026'), [
      {
        active: false,
        code: 'MAYA2026',
        owner_id: partnerId,
        owner_kind: 'partner',
      },
    ]);
    assert.deepEqual(await registry.lookup('maya2026'), {
      active: false,
      code: 'MAYA2026',
      ownerId: partnerId,
      ownerKind: 'partner',
    });

    // Whoever inserts it: even the owner role asking for active gets an
    // inactive partner row.
    const ownerInserted = randomUUID();
    await fixture.owner.execute({
      text: `INSERT INTO referral_code (code, owner_kind, owner_id, active) VALUES ('JONAS77', 'partner', $1, true)`,
      values: [ownerInserted],
    });
    assert.deepEqual(await registry.lookup('JONAS77'), {
      active: false,
      code: 'JONAS77',
      ownerId: ownerInserted,
      ownerKind: 'partner',
    });

    // A member row inserted by the application role (generation) is active.
    const memberId = await insertSubscriber(fixture.owner);
    const memberCode = await createReferralService(fixture.app, {
      createCode: () => 'MEMBERCODE23',
    }).generateCode(memberId);
    assert.deepEqual(await registry.lookup(memberCode), {
      active: true,
      code: 'MEMBERCODE23',
      ownerId: memberId,
      ownerKind: 'member',
    });
    assert.equal(
      await createReferralService(fixture.app).lookupCode(memberCode),
      memberId,
    );
  } finally {
    await fixture.dispose();
  }
});

test('two codes differing only in case never both exist, under genuine concurrency', async () => {
  const fixture = await createFixture();
  try {
    // A partner claim holds the code uncommitted while a member write of the
    // lower-case form waits on it, then fails when the claim commits.
    const subscriberId = await insertSubscriber(fixture.owner);
    const partnerWriter = await fixture.owner.connect();
    const memberWriter = await fixture.app.connect();
    try {
      await partnerWriter.execute({ text: 'BEGIN' });
      await partnerWriter.execute({
        text: `INSERT INTO referral_code (code, owner_kind, owner_id) VALUES ('MAYA2026', 'partner', $1)`,
        values: [randomUUID()],
      });
      await memberWriter.execute({ text: 'BEGIN' });
      const memberPid = await backendPid(memberWriter);
      const memberWrite = memberWriter
        .execute({
          text: `UPDATE subscriber SET referral_code = 'maya2026' WHERE id = $1`,
          values: [subscriberId],
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitUntilLockWaiting(fixture.owner, memberPid);
      await partnerWriter.execute({ text: 'COMMIT' });
      assert.equal(pgCode(await memberWrite), '23505');
      await memberWriter.execute({ text: 'ROLLBACK' });
    } finally {
      partnerWriter.release();
      memberWriter.release();
    }
    assert.deepEqual(
      (await registryRows(fixture.owner, 'maya2026')).map((row) => [
        row.code,
        row.owner_kind,
      ]),
      [['MAYA2026', 'partner']],
    );

    // A burst of simultaneous writers, each in its own transaction, offering
    // every case variant through both write paths: exactly one wins.
    const variants = [
      'RaceCode2026',
      'RACECODE2026',
      'racecode2026',
      'rACECODE2026',
      'RACEcode2026',
      'raceCODE2026',
    ];
    const subscribers = await Promise.all(
      variants.map(() => insertSubscriber(fixture.owner)),
    );
    const clients = await Promise.all(
      [...variants, 'RACECODE2026', 'RACECODE2026'].map(() =>
        fixture.owner.connect(),
      ),
    );
    try {
      await Promise.all(
        clients.map((client) => client.execute({ text: 'BEGIN' })),
      );
      const outcomes = await Promise.allSettled(
        clients.map(async (client, index) => {
          try {
            if (index < variants.length) {
              await client.execute({
                text: 'UPDATE subscriber SET referral_code = $2 WHERE id = $1',
                values: [subscribers[index], variants[index]],
              });
            } else {
              await client.execute({
                text: `INSERT INTO referral_code (code, owner_kind, owner_id) VALUES ($1, 'partner', $2)`,
                values: ['RACECODE2026', randomUUID()],
              });
            }
            await client.execute({ text: 'COMMIT' });
          } catch (error) {
            await client.execute({ text: 'ROLLBACK' });
            throw error;
          }
        }),
      );
      const fulfilled = outcomes.filter(
        (outcome) => outcome.status === 'fulfilled',
      );
      assert.equal(fulfilled.length, 1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          assert.equal(pgCode(outcome.reason), '23505');
        }
      }
    } finally {
      for (const client of clients) {
        client.release();
      }
    }
    const rows = await registryRows(fixture.owner, 'racecode2026');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.code, 'RACECODE2026');
    const holders = await fixture.owner.list<{ id: string }>(
      {
        text: `SELECT id FROM subscriber WHERE upper(referral_code) = 'RACECODE2026'`,
      },
      10,
    );
    assert.deepEqual(
      holders.map((holder) => holder.id),
      rows[0]?.owner_kind === 'member' ? [rows[0].owner_id] : [],
    );
  } finally {
    await fixture.dispose();
  }
});

test('a member code generated after a partner code never equals it, and the reverse', async () => {
  const fixture = await createFixture();
  try {
    const partnerCode = 'ABCDEFGHJKMN';
    const partnerId = await insertPartnerCode(fixture.owner, partnerCode);
    // Active, so the member lookup below proves it filters by kind, not
    // only by state.
    await activatePartnerCode(fixture.owner, partnerCode);
    const memberId = await insertSubscriber(fixture.owner);

    // Generation inside a caller's transaction, as verification runs it: the
    // collision regenerates without aborting the surrounding transaction.
    const offered: string[] = [];
    const allocated = await withTransaction(fixture.app, async (connection) => {
      const code = await createReferralService(connection, {
        createCode: () => {
          offered.push(offered.length === 0 ? partnerCode : 'QRSTUVWXYZ23');
          return offered.at(-1)!;
        },
      }).generateCode(memberId);
      const stillUsable = await connection.readOne<{ ok: number }>({
        text: 'SELECT 1 AS ok',
      });
      assert.equal(stillUsable?.ok, 1);
      return code;
    });
    assert.equal(offered.length, 2);
    assert.equal(allocated, 'QRSTUVWXYZ23');

    const registry = createReferralCodeRegistry(fixture.app);
    assert.deepEqual(await registry.lookup('abcdefghjkmn'), {
      active: true,
      code: partnerCode,
      ownerId: partnerId,
      ownerKind: 'partner',
    });
    assert.deepEqual(await registry.lookup('qrstuvwxyz23'), {
      active: true,
      code: 'QRSTUVWXYZ23',
      ownerId: memberId,
      ownerKind: 'member',
    });
    assert.equal(await registry.lookup('UNKNOWN2345'), null);

    // A member referral lookup never resolves to a partner.
    const service = createReferralService(fixture.app);
    assert.equal(await service.lookupCode(partnerCode), null);
    assert.equal(await service.lookupCode('Qrstuvwxyz23'), memberId);

    // Any other write of a partner's code to a subscriber is refused by the
    // database, in any case.
    const otherMember = await insertSubscriber(fixture.owner);
    await assert.rejects(
      fixture.app.execute({
        text: 'UPDATE subscriber SET referral_code = $2 WHERE id = $1',
        values: [otherMember, 'AbcdefghJkmn'],
      }),
      (error) => pgCode(error) === '23505',
    );

    // The reverse: a partner code equal to a member code, in any case, is
    // taken, and the database refuses it outright.
    const rules = createPartnerCodeRules(fixture.app);
    for (const requested of ['QRSTUVWXYZ23', 'qrstuvwxyz23', 'QrStUvWxYz23']) {
      const result = await rules.check(requested);
      assert.equal(result.outcome, 'refused');
      assert.equal(result.outcome === 'refused' && result.reason, 'taken');
    }
    await assert.rejects(
      insertPartnerCode(fixture.owner, 'QRSTUVWXYZ23'),
      (error) => pgCode(error) === '23505',
    );
  } finally {
    await fixture.dispose();
  }
});

test('allocation stays idempotent and serialised for one subscriber', async () => {
  const fixture = await createFixture();
  try {
    const memberId = await insertSubscriber(fixture.owner);
    const [first, second] = await Promise.all([
      createReferralService(fixture.app, {
        createCode: () => 'CDEFGHJKMNPQ',
      }).generateCode(memberId),
      createReferralService(fixture.app, {
        createCode: () => 'DEFGHJKMNPQR',
      }).generateCode(memberId),
    ]);
    assert.equal(first, second);
    const rows = await fixture.owner.list<{ code: string }>(
      {
        text: `SELECT code FROM referral_code WHERE owner_kind = 'member' AND owner_id = $1`,
        values: [memberId],
      },
      10,
    );
    assert.deepEqual(
      rows.map((row) => row.code),
      [first],
    );

    // A claimed registry row that no subscriber holds cannot commit.
    const orphanOwner = await insertSubscriber(fixture.owner);
    await assert.rejects(
      fixture.app.execute({
        text: `INSERT INTO referral_code (code, owner_kind, owner_id) VALUES ('ORPHAN234567', 'member', $1)`,
        values: [orphanOwner],
      }),
      /subscriber's referral code/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test('every existing member code is backfilled and member links resolve exactly as before', async () => {
  const seeded: { readonly code: string; readonly id: string }[] = [];
  let erasedId = '';
  const fixture = await createFixture(async (owner) => {
    // Before the registry: codes as E4-01 generated them, plus a code-less
    // pending row and an erased row whose code was cleared.
    for (const code of ['ABCDEFGHJKMN', 'PQRSTUVWXYZ2', '23456789ABCD']) {
      seeded.push({ code, id: await insertSubscriber(owner, { code }) });
    }
    await insertSubscriber(owner, { status: 'pending' });
    erasedId = await insertSubscriber(owner, { code: 'ERASEDCODE23' });
    await owner.execute({
      text: 'UPDATE subscriber SET referral_code = NULL WHERE id = $1',
      values: [erasedId],
    });
  });
  try {
    const registered = await fixture.owner.list<{
      active: boolean;
      code: string;
      owner_id: string;
      owner_kind: string;
    }>(
      {
        text: 'SELECT code, owner_kind, owner_id, active FROM referral_code ORDER BY code',
      },
      10,
    );
    assert.deepEqual(
      registered,
      [...seeded]
        .sort((left, right) => left.code.localeCompare(right.code))
        .map(({ code, id }) => ({
          active: true,
          code,
          owner_id: id,
          owner_kind: 'member',
        })),
    );

    // The pre-registry lookup, verbatim, against the registry lookup.
    const before = async (code: string) =>
      (
        await fixture.owner.readOne<{ id: string }>({
          text: 'SELECT id FROM subscriber WHERE LOWER(referral_code) = LOWER($1)',
          values: [code],
        })
      )?.id ?? null;
    const service = createReferralService(fixture.app);
    const inputs = [
      ...seeded.flatMap(({ code }) => [
        code,
        code.toLowerCase(),
        `${code.slice(0, 6).toLowerCase()}${code.slice(6)}`,
        ` ${code}`,
        `${code}X`,
        code.slice(0, 11),
      ]),
      'ERASEDCODE23',
      'UNKNOWN23456',
      '',
    ];
    for (const input of inputs) {
      assert.equal(await service.lookupCode(input), await before(input), input);
    }

    // A backfilled link still attributes a new signup to its member.
    const referredId = await insertSubscriber(fixture.owner, {
      status: 'pending',
    });
    assert.deepEqual(
      await service.attribute(referredId, seeded[0]!.code.toLowerCase()),
      { kind: 'attributed' },
    );
    const edge = await fixture.owner.readOne<{ referrer_id: string }>({
      text: 'SELECT referrer_id FROM referral_edge WHERE referred_id = $1',
      values: [referredId],
    });
    assert.equal(edge?.referrer_id, seeded[0]!.id);

    // A code allocated after the migration resolves the same way.
    const laterId = await insertSubscriber(fixture.owner);
    const laterCode = await createReferralService(fixture.app).generateCode(
      laterId,
    );
    assert.equal(await service.lookupCode(laterCode.toLowerCase()), laterId);
    assert.equal(await before(laterCode.toLowerCase()), laterId);
  } finally {
    await fixture.dispose();
  }
});

test('the subject export carries the member code, and erasure retires it for good', async () => {
  const fixture = await createFixture();
  try {
    const memberId = await insertSubscriber(fixture.owner);
    const code = await createReferralService(fixture.app).generateCode(
      memberId,
    );
    const exported = await exportSubjectPage(
      fixture.app,
      'referral_code',
      memberId,
      0,
    );
    assert.equal(exported.length, 1);
    assert.deepEqual(Object.keys(exported[0]!.data).sort(), [
      'active',
      'code',
      'created_at',
      'owner_id',
      'owner_kind',
    ]);
    assert.equal(exported[0]!.data.code, code);

    // Erasure through the E9-05 identity function clears the subscriber's
    // code; the registry row is retired with its owner cleared.
    await withTransaction(fixture.owner, async (connection) => {
      await connection.execute({
        text: `UPDATE subscriber SET status = 'erasure_pending' WHERE id = $1`,
        values: [memberId],
      });
      await connection.execute({
        text: `INSERT INTO dsr_erasure (subscriber_id, requested_at, next_attempt_at)
               VALUES ($1, '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z')`,
        values: [memberId],
      });
      await connection.readOne({
        text: 'SELECT erase_subscriber_identity($1)',
        values: [memberId],
      });
      await connection.execute({
        text: `INSERT INTO erasure_ledger (subscriber_id, erased_at) VALUES ($1, '2026-11-02T00:00:00Z')`,
        values: [memberId],
      });
      await connection.execute({
        text: `UPDATE dsr_erasure SET completed_at = '2026-11-02T00:00:00Z' WHERE subscriber_id = $1`,
        values: [memberId],
      });
    });
    assert.deepEqual(await registryRows(fixture.owner, code), [
      { active: false, code, owner_id: null, owner_kind: 'member' },
    ]);
    assert.deepEqual(
      await exportSubjectPage(fixture.app, 'referral_code', memberId, 0),
      [],
    );
    assert.equal(
      await createReferralService(fixture.app).lookupCode(code),
      null,
    );
    assert.deepEqual(
      await createReferralCodeRegistry(fixture.app).lookup(code),
      { active: false, code, ownerId: null, ownerKind: 'member' },
    );

    // The retired code is never reissued: not to a member, not to a partner.
    const nextMember = await insertSubscriber(fixture.owner);
    const offered: string[] = [];
    const reissued = await createReferralService(fixture.app, {
      createCode: () => {
        offered.push(offered.length === 0 ? code : 'NEWCODE23456');
        return offered.at(-1)!;
      },
    }).generateCode(nextMember);
    assert.equal(reissued, 'NEWCODE23456');
    const partnerCheck = await createPartnerCodeRules(fixture.app).check(code);
    assert.equal(
      partnerCheck.outcome === 'refused' && partnerCheck.reason,
      'taken',
    );
    await assert.rejects(
      fixture.owner.execute({
        text: `UPDATE referral_code SET owner_id = $2, active = true WHERE code = $1`,
        values: [code, nextMember],
      }),
      /owner can only be cleared/u,
    );
  } finally {
    await fixture.dispose();
  }
});
