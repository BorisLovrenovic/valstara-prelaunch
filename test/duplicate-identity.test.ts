import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { POST as signupPost } from '../src/pages/api/signup.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createFraudService,
  duplicateIdentityEvidenceLimit,
  duplicateIdentityRuleVersion,
} from '../src/server/fraud/service.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly applicationDatabaseUrl: string;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e502_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e5-02-test',
  });
  const applicationDatabase = createPool(applicationUrl.toString());

  return {
    applicationDatabase,
    applicationDatabaseUrl: applicationUrl.toString(),
    database,
    async dispose() {
      await applicationDatabase.close();
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

function signupRequest(email: string): Request {
  return new Request('http://valstara.test/api/signup', {
    body: new URLSearchParams({
      country: 'GB',
      email,
      turnstile_token: 'duplicate-identity-route-token',
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
}

function signupRouteContext(request: Request) {
  return { clientAddress: '203.0.113.82', request } as never;
}

async function insertSubscriber(
  database: DatabasePool,
  email: string,
): Promise<string> {
  const id = randomUUID();
  const domain = email.slice(email.lastIndexOf('@') + 1);
  await database.execute({
    text: `
      INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
      VALUES ($1, $2, $2, $3, 'pending')
    `,
    values: [id, email, domain],
  });
  return id;
}

test('a cross-domain normalised local-part match flags the new subscriber without rejecting or changing status', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const firstMatch = await insertSubscriber(
      fixture.database,
      'shared@first.example',
    );
    const secondMatch = await insertSubscriber(
      fixture.database,
      'shared@second.example',
    );
    await insertSubscriber(fixture.database, 'different@third.example');

    const fraud = createFraudService(fixture.applicationDatabase, {
      mxResolver: async () => [{}],
    });
    let duplicateIdentityChecks = 0;
    const signup = createSignupService(fixture.applicationDatabase, {
      flagDuplicateIdentity: (subscriberId) => {
        duplicateIdentityChecks += 1;
        return fraud.flagDuplicateIdentity(subscriberId);
      },
      raiseFraudFlag: (subscriberId, kind, detail) =>
        fraud.raise(subscriberId, kind, detail),
      screenEmailDomain: (domain) => fraud.screen({ domain }),
      sendVerificationMail: async () => undefined,
    });

    const outcome = await signup({
      country: 'GB',
      email: 'SHARED+campaign@new.example',
      verificationUrl: (token) => `https://valstara.test/verify?token=${token}`,
    });

    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') {
      assert.fail('The duplicate-identity signal must not reject signup.');
    }
    const row = await fixture.database.readOne<{
      readonly detail: {
        readonly local_part: string;
        readonly match_count: number;
        readonly matched_subscriber_ids: readonly string[];
        readonly rule: string;
        readonly rule_version: number;
      };
      readonly kind: string;
      readonly state: string;
      readonly status: string;
    }>({
      text: `
        SELECT f.kind, f.state, f.detail, s.status
        FROM fraud_flag f
        JOIN subscriber s ON s.id = f.subscriber_id
        WHERE f.subscriber_id = $1
          AND f.kind = 'duplicate_identity'
      `,
      values: [outcome.subscriber.id],
    });

    assert.equal(row?.kind, 'duplicate_identity');
    assert.equal(row?.state, 'open');
    assert.equal(row?.status, 'pending');
    assert.equal(row?.detail.rule, 'shared_local_part_across_domains');
    assert.equal(row?.detail.rule_version, duplicateIdentityRuleVersion);
    assert.equal(row?.detail.match_count, 2);
    assert.equal(row?.detail.local_part, 'shared');
    assert.deepEqual(
      [...(row?.detail.matched_subscriber_ids ?? [])].sort(),
      [firstMatch, secondMatch].sort(),
    );

    const repeat = await signup({
      country: 'GB',
      email: 'shared@new.example',
      verificationUrl: (token) => `https://valstara.test/verify?token=${token}`,
    });
    assert.equal(repeat.kind, 'existing');
    assert.equal(duplicateIdentityChecks, 1);
  } finally {
    await fixture.dispose();
  }
});

test('duplicate-identity evidence is bounded and reports the complete match count', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const newSubscriberId = await insertSubscriber(
      fixture.database,
      'bounded@new.example',
    );
    for (
      let index = 0;
      index < duplicateIdentityEvidenceLimit + 3;
      index += 1
    ) {
      await insertSubscriber(
        fixture.database,
        `bounded@domain-${index}.example`,
      );
    }

    const raised = await createFraudService(
      fixture.applicationDatabase,
    ).flagDuplicateIdentity(newSubscriberId);
    assert.equal(raised, true);

    const detail = await fixture.database.readOne<{
      readonly match_count: string;
      readonly matched_count: string;
    }>({
      text: `
        SELECT
          detail->>'match_count' AS match_count,
          jsonb_array_length(detail->'matched_subscriber_ids')::text AS matched_count
        FROM fraud_flag
        WHERE subscriber_id = $1 AND kind = 'duplicate_identity'
      `,
      values: [newSubscriberId],
    });
    assert.deepEqual(detail, {
      match_count: String(duplicateIdentityEvidenceLimit + 3),
      matched_count: String(duplicateIdentityEvidenceLimit),
    });
  } finally {
    await fixture.dispose();
  }
});

test('a unique local part does not raise duplicate_identity, and the functional lookup index exists', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const subscriberId = await insertSubscriber(
      fixture.database,
      'different@same.example',
    );
    await insertSubscriber(fixture.database, 'shared@same.example');

    assert.equal(
      await createFraudService(
        fixture.applicationDatabase,
      ).flagDuplicateIdentity(subscriberId),
      false,
    );
    assert.equal(
      await fixture.database.readOne({
        text: `
          SELECT id FROM fraud_flag
          WHERE subscriber_id = $1 AND kind = 'duplicate_identity'
        `,
        values: [subscriberId],
      }),
      null,
    );

    const index = await fixture.database.readOne<{ readonly indexdef: string }>(
      {
        text: `
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'subscriber'
          AND indexname = 'idx_subscriber_email_normalised_local_part'
      `,
      },
    );
    assert.match(index?.indexdef ?? '', /split_part\(email_normalised, '@'/u);
  } finally {
    await fixture.dispose();
  }
});

test('a duplicate-identity signal failure cannot reject the signup', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const signup = createSignupService(fixture.applicationDatabase, {
      async flagDuplicateIdentity() {
        throw new Error('review metadata unavailable');
      },
      raiseFraudFlag: async () => undefined,
      screenEmailDomain: async () => ({ flags: [] }),
      sendVerificationMail: async () => undefined,
    });
    const outcome = await signup({
      country: 'GB',
      email: 'accepted@failure.example',
      verificationUrl: () => 'https://valstara.test/verify',
    });

    assert.equal(outcome.kind, 'created');
    assert.deepEqual(
      await fixture.database.readOne<{ readonly status: string }>({
        text: 'SELECT status FROM subscriber WHERE id = $1',
        values: [outcome.kind === 'created' ? outcome.subscriber.id : ''],
      }),
      { status: 'pending' },
    );
  } finally {
    await fixture.dispose();
  }
});

test('the default POST wiring flags a cross-domain duplicate identity on the new subscriber', async () => {
  const fixture = await createDatabaseFixture();
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const localPart = `default-route-${randomUUID().replaceAll('-', '')}`;
  const email = `${localPart}@gmail.com`;

  process.env.DATABASE_URL = fixture.applicationDatabaseUrl;
  process.env.IP_PREFIX_PEPPER = 'duplicate-identity-route-pepper';
  process.env.REFERRAL_SIGNING_SECRET =
    'duplicate-identity-route-referral-secret';
  process.env.TURNSTILE_SECRET_KEY = 'duplicate-identity-route-secret';
  process.env.RESEND_API_KEY = 'duplicate-identity-route-resend-key';
  process.env.RESEND_TEST_RECIPIENT = 'delivered@resend.dev';

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('challenges.cloudflare.com')) {
      return Response.json({ success: true });
    }
    if (url === 'https://api.resend.com/emails') {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }) as typeof globalThis.fetch;

  try {
    await insertSubscriber(
      fixture.database,
      `${localPart}@existing.example`,
    );

    const response = await signupPost(
      signupRouteContext(signupRequest(email)),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'pending');

    const subscriber = await fixture.database.readOne<{
      readonly id: string;
      readonly status: string;
    }>({
      text: `
        SELECT id, status
        FROM subscriber
        WHERE email_normalised = $1
      `,
      values: [email],
    });
    assert.ok(subscriber, 'the default route must create the new subscriber');

    const flag = await fixture.database.readOne<{
      readonly kind: string;
      readonly state: string;
    }>({
      text: `
        SELECT kind, state
        FROM fraud_flag
        WHERE subscriber_id = $1
          AND kind = 'duplicate_identity'
      `,
      values: [subscriber.id],
    });
    assert.deepEqual(flag, { kind: 'duplicate_identity', state: 'open' });
    assert.equal(subscriber.status, 'pending');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of [
      'DATABASE_URL',
      'IP_PREFIX_PEPPER',
      'REFERRAL_SIGNING_SECRET',
      'TURNSTILE_SECRET_KEY',
      'RESEND_API_KEY',
      'RESEND_TEST_RECIPIENT',
    ]) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await fixture.dispose();
  }
});

function assertFlagPathsDoNotWriteSubscriberStatus(
  sources: readonly { readonly contents: string; readonly path: string }[],
): void {
  const statusWrite = /UPDATE\s+subscriber\s+SET[\s\S]{0,300}\bstatus\s*=/iu;
  for (const source of sources) {
    if (/fraud[-_]flag|flagDuplicateIdentity/u.test(source.contents)) {
      assert.doesNotMatch(
        source.contents,
        statusWrite,
        `${source.path} must not change subscriber.status from a flag path`,
      );
    }
  }
}

test('no fraud-flag write path changes subscriber.status', () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const sourceRoot = join(repositoryRoot, 'src');
  const sources: { contents: string; path: string }[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && ['.sql', '.ts'].includes(extname(path))) {
        sources.push({
          contents: readFileSync(path, 'utf8'),
          path: relative(repositoryRoot, path),
        });
      }
    }
  };
  visit(sourceRoot);
  assertFlagPathsDoNotWriteSubscriberStatus(sources);

  assert.throws(
    () =>
      assertFlagPathsDoNotWriteSubscriberStatus([
        {
          contents:
            "INSERT INTO fraud_flag VALUES (...); UPDATE subscriber SET status = 'disqualified';",
          path: 'src/server/fraud/mutant.ts',
        },
      ]),
    /must not change subscriber\.status/u,
  );
});
