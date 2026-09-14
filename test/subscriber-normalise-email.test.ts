import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { QueryResultRow } from 'pg';

import { createSignupService } from '../src/server/subscriber/signup.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import {
  createPool,
  type DatabaseClient,
  type DatabasePool,
  type SqlStatement,
} from '../src/server/db/pool.ts';
import { normaliseEmail } from '../src/server/subscriber/normalise-email.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

// --- Unit: the normalisation table ------------------------------------------

test('the three Gmail variants normalise to one uniqueness key', () => {
  const variants = [
    'user+tag@gmail.com',
    'u.s.e.r@gmail.com',
    'user@gmail.com',
    'U.S.E.R+promo@Gmail.com',
  ];

  const keys = variants.map((raw) => normaliseEmail(raw)?.normalised);

  assert.deepEqual(new Set(keys), new Set(['user@gmail.com']));
});

test('dot-stripping is Gmail-family behaviour, not general', () => {
  // The counterexample that fails if dot-stripping is applied to every domain.
  assert.equal(
    normaliseEmail('u.s.e.r@example.com')?.normalised,
    'u.s.e.r@example.com',
  );
  assert.equal(
    normaliseEmail('first.last@fastmail.com')?.normalised,
    'first.last@fastmail.com',
  );
  // googlemail.com is the same mailbox family as gmail.com.
  assert.equal(
    normaliseEmail('u.s.e.r@googlemail.com')?.normalised,
    'user@googlemail.com',
  );
});

test('+tag stripping is general and the raw address is preserved unchanged', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['User+newsletter@example.com', 'user@example.com'],
    ['person+anything+more@fastmail.com', 'person@fastmail.com'],
    ['a.b+tag@gmail.com', 'ab@gmail.com'],
  ];

  for (const [raw, normalised] of cases) {
    const result = normaliseEmail(raw);
    assert.equal(result?.normalised, normalised);
    assert.equal(
      result?.raw,
      raw,
      'the raw address must be preserved verbatim',
    );
  }
});

test('the denormalised domain is the lowercased domain part', () => {
  assert.equal(normaliseEmail('Person@Example.COM')?.domain, 'example.com');
  assert.equal(normaliseEmail('u.s.e.r+x@Gmail.com')?.domain, 'gmail.com');
});

test('malformed addresses return null rather than throwing', () => {
  const malformed = [
    'not an email',
    ' spaced@example.test ',
    'no-at-sign.example.com',
    'no-domain-dot@example',
    'two@@example.com',
    'spa ce@example.com',
    '@example.com',
    'user@',
    '',
    '+tag@gmail.com', // empties the local part
    '.@gmail.com', // empties the local part after dot removal
  ];

  for (const raw of malformed) {
    assert.equal(normaliseEmail(raw), null, `expected null for ${raw}`);
  }
});

test('Unicode and internationalised domains are handled without throwing', () => {
  const internationalised = [
    'tëst@example.com',
    'test@münchen.de',
    'test@xn--mnchen-3ya.de',
    'ユーザー@example.jp',
    'user@例え.jp',
  ];

  for (const raw of internationalised) {
    assert.doesNotThrow(() => normaliseEmail(raw));
    // Non-Gmail domains keep their local part intact apart from lowercasing.
    assert.equal(
      normaliseEmail(raw)?.domain,
      raw.slice(raw.lastIndexOf('@') + 1).toLowerCase(),
    );
  }
});

// --- Call site: normalisation precedes the uniqueness check -----------------

test('the signup call site normalises before its uniqueness check', () => {
  const rawSource = readFileSync(
    fileURLToPath(
      new URL('../src/server/subscriber/signup.ts', import.meta.url),
    ),
    'utf8',
  );
  // Scan code only — comments legitimately mention the uniqueness check.
  const signupSource = rawSource
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/[^\n]*/g, '');

  assert.match(
    signupSource,
    /from '\.\/normalise-email\.ts'/,
    'signup must use the shared normaliseEmail, not a local normaliser',
  );

  const flowStart = signupSource.indexOf('return async (input)');
  assert.notEqual(flowStart, -1, 'could not locate the signup flow closure');
  const flow = signupSource.slice(flowStart);

  const normaliseCall = flow.indexOf('normaliseEmail(');
  const uniquenessCall = flow.indexOf('upsertSubscriber(');
  assert.notEqual(normaliseCall, -1, 'the flow must call normaliseEmail');
  assert.notEqual(
    uniquenessCall,
    -1,
    'the flow must reach the uniqueness upsert',
  );
  assert.ok(
    normaliseCall < uniquenessCall,
    'normalisation must run before the uniqueness check',
  );

  // The uniqueness check lives only inside upsertSubscriber, which receives an
  // already-normalised value — no ON CONFLICT / findByNormalised precedes it.
  assert.doesNotMatch(
    flow.slice(0, normaliseCall),
    /ON CONFLICT|email_normalised|findByNormalised/,
    'no uniqueness check may precede normalisation',
  );
});

// A recording pool captures the exact statements the signup flow issues, in
// order, so the call-site ordering can be asserted behaviourally rather than by
// scanning source text for today's SQL idioms. Every write "succeeds" so the
// flow proceeds through its uniqueness insert; the rate-limit counter reads as
// one attempt.
interface RecordedStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingPool(recorded: RecordedStatement[]): DatabasePool {
  const record = (statement: SqlStatement): void => {
    recorded.push({ text: statement.text, values: statement.values ?? [] });
  };

  const execute = async (statement: SqlStatement): Promise<number> => {
    record(statement);
    return /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(statement.text) ? 0 : 1;
  };

  const readOne = async <Row extends QueryResultRow>(
    statement: SqlStatement,
  ): Promise<Row | null> => {
    record(statement);
    if (/FROM rate_limit_bucket/i.test(statement.text)) {
      return { count: 1 } as unknown as Row;
    }
    return null;
  };

  const list = async <Row extends QueryResultRow>(
    statement: SqlStatement,
  ): Promise<readonly Row[]> => {
    record(statement);
    return [];
  };

  const connection: DatabaseClient = {
    execute,
    readOne,
    list,
    release: () => undefined,
  };

  return {
    execute,
    readOne,
    list,
    connect: async () => connection,
    close: async () => undefined,
  };
}

test('the signup call site binds the normalised key before it touches the uniqueness structure', async () => {
  const recorded: RecordedStatement[] = [];
  const signup = createSignupService(createRecordingPool(recorded), {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    clock: () => new Date('2026-09-06T12:00:00.000Z'),
    async sendVerificationMail() {
      return undefined;
    },
  });

  // A dotted, +tagged Gmail address: the raw and normalised forms differ, so
  // the value bound to the uniqueness key reveals whether normalisation ran
  // first. Raw local part 'u.s.e.r+promo' normalises to 'user'.
  const result = await signup({
    email: 'u.s.e.r+promo@gmail.com',
    country: 'GB',
    verificationUrl: (token) => `http://valstara.test/verify?token=${token}`,
  });
  assert.equal(result.kind, 'created');

  // The uniqueness rule is the `subscriber` table's UNIQUE email_normalised.
  // Find the first statement that touches that table, however the check is
  // spelled and whichever helper issues it (\bsubscriber\b matches the table
  // but not the subscriber_id columns of later inserts).
  const firstSubscriberTouch = recorded.find((statement) =>
    /\bsubscriber\b/i.test(statement.text),
  );
  assert.ok(
    firstSubscriberTouch,
    'the flow must reach the subscriber uniqueness structure',
  );

  // By the time the subscriber table is first touched, the bound values must
  // already carry the NORMALISED key. A uniqueness read on the raw email before
  // normalisation would bind 'u.s.e.r+promo@gmail.com' as the lookup here and
  // fail this assertion — with no dependence on today's SQL idioms or helper
  // names.
  assert.ok(
    firstSubscriberTouch.values.includes('user@gmail.com'),
    'normalisation must run before the subscriber uniqueness structure is touched',
  );
});

// --- Integration: the variants collide on one database row ------------------

interface DatabaseFixture {
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e301_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createPool(adminUrl.toString());

  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  await runMigrations(database, {
    applicationRolePassword,
    release: 'e3-01-test',
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

test('the three Gmail variants collide on one subscriber row', async () => {
  const fixture = await createDatabaseFixture();
  const signup = createSignupService(fixture.database, {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    clock: () => new Date('2026-09-06T12:00:00.000Z'),
    async sendVerificationMail() {
      return undefined;
    },
  });

  try {
    const results = [];
    for (const raw of [
      'user+tag@gmail.com',
      'u.s.e.r@gmail.com',
      'user@gmail.com',
    ]) {
      results.push(
        await signup({
          email: raw,
          country: 'GB',
          verificationUrl: (token) =>
            `http://valstara.test/verify?token=${token}`,
        }),
      );
    }

    assert.equal(results[0]?.kind, 'created');
    assert.equal(results[1]?.kind, 'existing');
    assert.equal(results[2]?.kind, 'existing');

    const rows = await fixture.database.list<{
      email: string;
      email_normalised: string;
      email_domain: string;
    }>(
      {
        text: 'SELECT email, email_normalised, email_domain FROM subscriber',
      },
      10,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.email_normalised, 'user@gmail.com');
    assert.equal(rows[0]?.email, 'user+tag@gmail.com'); // raw of the first write
    assert.equal(rows[0]?.email_domain, 'gmail.com');
  } finally {
    await fixture.dispose();
  }
});

test('a non-Gmail dotted address is stored as a distinct row', async () => {
  const fixture = await createDatabaseFixture();
  const signup = createSignupService(fixture.database, {
    raiseFraudFlag: async () => undefined,
    screenEmailDomain: async () => ({ flags: [] }),
    clock: () => new Date('2026-09-06T12:00:00.000Z'),
    async sendVerificationMail() {
      return undefined;
    },
  });

  try {
    const dotted = await signup({
      email: 'u.s.e.r@example.com',
      country: 'GB',
      verificationUrl: (token) => `http://valstara.test/verify?token=${token}`,
    });
    const undotted = await signup({
      email: 'user@example.com',
      country: 'GB',
      verificationUrl: (token) => `http://valstara.test/verify?token=${token}`,
    });

    assert.equal(dotted.kind, 'created');
    assert.equal(undotted.kind, 'created'); // dots are significant off Gmail

    const count = await fixture.database.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM subscriber',
    });
    assert.equal(count?.count, '2');
  } finally {
    await fixture.dispose();
  }
});
