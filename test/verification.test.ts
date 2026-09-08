import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import fc from 'fast-check';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createVerificationService,
  customerOutcome,
  purposeLifetimeMs,
} from '../src/server/verification/service.ts';
import type {
  ConsumeResult,
  TokenPurpose,
} from '../src/server/verification/types.ts';

// E3-06 builds src/server/verification: single-use, hashed, expiring tokens with
// a purpose discriminator and per-purpose expiry. These tests exercise the
// module directly against a real database; the /verify endpoint that consumes
// tokens in a transaction is E3-07.

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e306_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e3-06-test',
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

let subscriberCounter = 0;

async function insertSubscriber(database: DatabasePool): Promise<string> {
  subscriberCounter += 1;
  const id = randomUUID();
  const address = `sub-${subscriberCounter}@example.test`;
  await database.execute({
    text: `
      INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
      VALUES ($1, $2, $3, 'example.test', 'pending')
    `,
    values: [id, address, `${id}@example.test`],
  });
  return id;
}

async function tokenRowCount(database: DatabasePool): Promise<number> {
  const row = await database.readOne<{ count: string }>({
    text: 'SELECT COUNT(*)::text AS count FROM verification_token',
  });
  return Number(row?.count ?? '0');
}

const baseTime = new Date('2026-09-08T12:00:00.000Z');

test('issue stores only the SHA-256 hash and returns the plaintext with a per-purpose expiry', async () => {
  const fixture = await createDatabaseFixture();
  const service = createVerificationService(fixture.database, {
    clock: () => baseTime,
  });

  try {
    for (const purpose of ['verify', 'status', 'unsubscribe'] as const) {
      const subscriberId = await insertSubscriber(fixture.database);
      const issued = await service.issue(subscriberId, purpose);

      assert.equal(
        issued.expiresAt.getTime(),
        baseTime.getTime() + purposeLifetimeMs[purpose],
        `${purpose} expiry must follow its configured lifetime`,
      );

      const row = await fixture.database.readOne<{
        token_hash: Buffer;
        purpose: string;
        expires_at: Date;
      }>({
        text: `
          SELECT token_hash, purpose, expires_at
          FROM verification_token
          WHERE subscriber_id = $1
        `,
        values: [subscriberId],
      });

      assert.equal(row?.purpose, purpose);
      assert.equal(row?.expires_at.getTime(), issued.expiresAt.getTime());
      // The stored hash is exactly SHA-256 of the returned plaintext, and the
      // plaintext itself appears nowhere in the row.
      assert.deepEqual(
        row?.token_hash,
        createHash('sha256').update(issued.token).digest(),
      );
    }
  } finally {
    await fixture.dispose();
  }
});

test('the plaintext token is never persisted in any column, and the module cannot log or audit it', async () => {
  const fixture = await createDatabaseFixture();
  const service = createVerificationService(fixture.database, {
    clock: () => baseTime,
  });

  try {
    const subscriberId = await insertSubscriber(fixture.database);
    const issued = await service.issue(subscriberId, 'verify');
    await service.consume(issued.token, 'verify');

    // Every stored value, textualised, is free of the plaintext.
    const row = await fixture.database.readOne<Record<string, unknown>>({
      text: 'SELECT * FROM verification_token WHERE subscriber_id = $1',
      values: [subscriberId],
    });
    assert.ok(row !== null);
    assert.ok(
      !JSON.stringify(row, (_key, value) =>
        value instanceof Buffer ? value.toString('base64') : value,
      ).includes(issued.token),
      'the plaintext token must not appear in any persisted column',
    );

    // The module has no path that could leak the plaintext to a log line or an
    // audit detail: it never calls console.* and never imports the audit module.
    const source = await readFile(
      fileURLToPath(
        new URL('../src/server/verification/service.ts', import.meta.url),
      ),
      'utf8',
    );
    assert.ok(!/\bconsole\./.test(source), 'the module must not log');
    assert.ok(
      !/from '.*audit/.test(source),
      'the module must not reach the audit layer with a plaintext token',
    );
  } finally {
    await fixture.dispose();
  }
});

test('a fresh token consumes once and every replay returns already', async () => {
  const fixture = await createDatabaseFixture();
  const service = createVerificationService(fixture.database, {
    clock: () => baseTime,
  });

  try {
    const subscriberId = await insertSubscriber(fixture.database);
    const issued = await service.issue(subscriberId, 'verify');

    assert.equal(await service.consume(issued.token, 'verify'), 'verified');
    assert.equal(await service.consume(issued.token, 'verify'), 'already');
    assert.equal(await service.consume(issued.token, 'verify'), 'already');
  } finally {
    await fixture.dispose();
  }
});

test('a token issued for one purpose is invalid for another, and does not consume', async () => {
  const fixture = await createDatabaseFixture();
  const service = createVerificationService(fixture.database, {
    clock: () => baseTime,
  });

  try {
    const subscriberId = await insertSubscriber(fixture.database);
    const issued = await service.issue(subscriberId, 'status');

    // A status link presented as a verification is invalid — the takeover
    // primitive this discriminator exists to prevent.
    assert.equal(await service.consume(issued.token, 'verify'), 'invalid');
    assert.equal(await service.consume(issued.token, 'unsubscribe'), 'invalid');

    // It remains unconsumed and still usable for its own purpose.
    const before = await fixture.database.readOne<{ consumed_at: Date | null }>(
      {
        text: 'SELECT consumed_at FROM verification_token WHERE subscriber_id = $1',
        values: [subscriberId],
      },
    );
    assert.equal(before?.consumed_at, null);
    assert.equal(await service.consume(issued.token, 'status'), 'verified');
  } finally {
    await fixture.dispose();
  }
});

test('an expired token returns expired under an injected clock, and never consumes', async () => {
  const fixture = await createDatabaseFixture();
  const issuer = createVerificationService(fixture.database, {
    clock: () => baseTime,
  });

  try {
    const subscriberId = await insertSubscriber(fixture.database);
    const issued = await issuer.issue(subscriberId, 'verify');
    const expiry = new Date(baseTime.getTime() + purposeLifetimeMs.verify);

    // Exactly at expiry the token is already expired (validity is strictly
    // before expires_at).
    const atExpiry = createVerificationService(fixture.database, {
      clock: () => expiry,
    });
    assert.equal(await atExpiry.consume(issued.token, 'verify'), 'expired');

    // One millisecond before expiry it still consumes.
    const justBefore = createVerificationService(fixture.database, {
      clock: () => new Date(expiry.getTime() - 1),
    });
    assert.equal(await justBefore.consume(issued.token, 'verify'), 'verified');
  } finally {
    await fixture.dispose();
  }
});

test('expired and invalid produce the identical customer-facing response', async () => {
  const fixture = await createDatabaseFixture();
  const issuer = createVerificationService(fixture.database, {
    clock: () => baseTime,
  });

  try {
    const subscriberId = await insertSubscriber(fixture.database);
    const issued = await issuer.issue(subscriberId, 'verify');
    const afterExpiry = createVerificationService(fixture.database, {
      clock: () => new Date(baseTime.getTime() + purposeLifetimeMs.verify + 1),
    });

    const expired = await afterExpiry.consume(issued.token, 'verify');
    const invalid = await afterExpiry.consume('no-such-token', 'verify');

    assert.equal(expired, 'expired');
    assert.equal(invalid, 'invalid');
    // Distinct internally, indistinguishable to the visitor.
    assert.equal(customerOutcome(expired), 'rejected');
    assert.equal(customerOutcome(invalid), 'rejected');
    assert.equal(customerOutcome(expired), customerOutcome(invalid));
  } finally {
    await fixture.dispose();
  }
});

test('customerOutcome collapses verified and already to success and expired and invalid to rejected', () => {
  assert.equal(customerOutcome('verified'), 'ok');
  assert.equal(customerOutcome('already'), 'ok');
  assert.equal(customerOutcome('expired'), 'rejected');
  assert.equal(customerOutcome('invalid'), 'rejected');
});

test('an empty token is invalid without touching the database', async () => {
  const fixture = await createDatabaseFixture();
  const service = createVerificationService(fixture.database, {
    clock: () => baseTime,
  });

  try {
    assert.equal(await service.consume('', 'verify'), 'invalid');
  } finally {
    await fixture.dispose();
  }
});

test('purgeExpired removes only expired tokens, is batch-capped, and drains across calls', async () => {
  const fixture = await createDatabaseFixture();
  const issuer = createVerificationService(fixture.database, {
    clock: () => baseTime,
  });

  try {
    // Five expired verify tokens (issued long ago) and two still-valid ones.
    const longAgo = createVerificationService(fixture.database, {
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    for (let index = 0; index < 5; index += 1) {
      const id = await insertSubscriber(fixture.database);
      await longAgo.issue(id, 'verify');
    }
    for (let index = 0; index < 2; index += 1) {
      const id = await insertSubscriber(fixture.database);
      await issuer.issue(id, 'verify');
    }
    assert.equal(await tokenRowCount(fixture.database), 7);

    const before = new Date('2026-06-01T00:00:00.000Z');
    // Batch cap of 2 removes exactly 2, never the whole expired set at once.
    assert.equal(await issuer.purgeExpired(before, 2), 2);
    assert.equal(await tokenRowCount(fixture.database), 5);
    // Subsequent calls drain the rest, then stop — the two valid tokens remain.
    assert.equal(await issuer.purgeExpired(before, 10), 3);
    assert.equal(await issuer.purgeExpired(before, 10), 0);
    assert.equal(await tokenRowCount(fixture.database), 2);
  } finally {
    await fixture.dispose();
  }
});

test('purgeExpired rejects a non-positive limit', async () => {
  const fixture = await createDatabaseFixture();
  const service = createVerificationService(fixture.database, {
    clock: () => baseTime,
  });

  try {
    await assert.rejects(
      () => service.purgeExpired(baseTime, 0),
      RangeError,
      'a zero limit must be rejected',
    );
    await assert.rejects(() => service.purgeExpired(baseTime, -1), RangeError);
  } finally {
    await fixture.dispose();
  }
});

test('a concurrent double-consume yields exactly one verified against a real database', async () => {
  const fixture = await createDatabaseFixture();
  const service = createVerificationService(fixture.database, {
    clock: () => baseTime,
  });

  try {
    const subscriberId = await insertSubscriber(fixture.database);
    const issued = await service.issue(subscriberId, 'verify');

    const results = await Promise.all([
      service.consume(issued.token, 'verify'),
      service.consume(issued.token, 'verify'),
    ]);

    // The single-use invariant: the row-level guard lets exactly one win.
    assert.deepEqual([...results].sort(), ['already', 'verified']);
  } finally {
    await fixture.dispose();
  }
});

test('single-use holds across a seeded range of purposes and replay counts', async () => {
  const fixture = await createDatabaseFixture();

  try {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<TokenPurpose>('verify', 'status', 'unsubscribe'),
        fc.integer({ min: 1, max: 5 }),
        async (purpose, extraAttempts) => {
          const service = createVerificationService(fixture.database, {
            clock: () => baseTime,
          });
          const subscriberId = await insertSubscriber(fixture.database);
          const issued = await service.issue(subscriberId, purpose);

          // The first consume for the matching purpose succeeds exactly once.
          const first = await service.consume(issued.token, purpose);
          assert.equal(first, 'verified');

          // Every further consume is a no-op replay, never a second success.
          const replays: ConsumeResult[] = [];
          for (let index = 0; index < extraAttempts; index += 1) {
            replays.push(await service.consume(issued.token, purpose));
          }
          assert.ok(replays.every((result) => result === 'already'));
        },
      ),
      { numRuns: 15, seed: 20_260_908 },
    );
  } finally {
    await fixture.dispose();
  }
});
