import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createFraudQueueRoute } from '../src/pages/api/admin/fraud.ts';
import { createFraudReviewRoute } from '../src/pages/api/admin/fraud/[id].ts';
import { adminActor } from '../src/server/admin-auth/authenticate.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createFraudReviewService,
  fraudReviewBatchMaximum,
} from '../src/server/fraud/review.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

interface DatabaseFixture {
  readonly applicationDatabase: DatabasePool;
  readonly database: DatabasePool;
  dispose(): Promise<void>;
}

interface FraudFlagFixture {
  readonly flagId: string;
  readonly subscriberId: string;
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const databaseName = `valstara_e504_${randomUUID().replaceAll('-', '')}`;
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
    release: 'e5-04-test',
  });
  const applicationDatabase = createPool(applicationUrl.toString());

  return {
    applicationDatabase,
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

async function insertOpenFlag(
  database: DatabasePool,
  input: {
    readonly createdAt?: Date;
    readonly detail?: Readonly<Record<string, unknown>>;
    readonly kind?: string;
  } = {},
): Promise<FraudFlagFixture> {
  const subscriberId = randomUUID();
  const flagId = randomUUID();
  const email = `${subscriberId}@review.example`;
  await database.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, country,
        confirmed_referrals, referral_tier, verified_at
      )
      VALUES ($1, $2, $2, 'review.example', 'verified', 'GB', 3, 1, $3)
    `,
    values: [subscriberId, email, new Date('2026-09-15T10:00:00.000Z')],
  });
  await database.execute({
    text: `
      INSERT INTO fraud_flag (
        id, subscriber_id, kind, detail, state, created_at
      )
      VALUES ($1, $2, $3, $4::jsonb, 'open', $5)
    `,
    values: [
      flagId,
      subscriberId,
      input.kind ?? 'duplicate_identity',
      JSON.stringify(input.detail ?? { reason: 'review_fixture' }),
      input.createdAt ?? new Date('2026-09-16T10:00:00.000Z'),
    ],
  });
  return { flagId, subscriberId };
}

function routeContext(
  request: Request,
  options: {
    readonly id?: string;
    readonly actor?: string;
  } = {},
) {
  return {
    locals: options.actor === undefined ? {} : { adminActor: options.actor },
    params: options.id === undefined ? {} : { id: options.id },
    request,
    url: new URL(request.url),
  } as never;
}

test('E5-04 dismiss and uphold routes persist the authenticated actor and audit both outcomes', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const dismissed = await insertOpenFlag(fixture.database);
    const upheld = await insertOpenFlag(fixture.database, {
      kind: 'self_referral',
    });
    const route = createFraudReviewRoute(
      createFraudReviewService(fixture.applicationDatabase),
    );

    for (const [flagId, outcome] of [
      [dismissed.flagId, 'dismissed'],
      [upheld.flagId, 'upheld'],
    ] as const) {
      const request = new Request(
        `https://valstara.test/api/admin/fraud/${flagId}`,
        {
          body: JSON.stringify({ outcome }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      const response = await route(
        routeContext(request, { actor: adminActor, id: flagId }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        flag: { id: flagId, outcome },
        status: 'reviewed',
      });
    }

    const flags = await fixture.database.list<{
      readonly id: string;
      readonly reviewed_by: string;
      readonly state: string;
    }>(
      {
        text: `
          SELECT id::text, state, reviewed_by
          FROM fraud_flag
          WHERE id = ANY($1::uuid[])
          ORDER BY id
        `,
        values: [[dismissed.flagId, upheld.flagId]],
      },
      2,
    );
    assert.deepEqual(
      flags.map((flag) => ({
        id: flag.id,
        reviewedBy: flag.reviewed_by,
        state: flag.state,
      })),
      [
        { id: dismissed.flagId, reviewedBy: adminActor, state: 'dismissed' },
        { id: upheld.flagId, reviewedBy: adminActor, state: 'upheld' },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );

    const audits = await fixture.database.list<{
      readonly actor: string;
      readonly outcome: string;
      readonly subject_id: string;
    }>(
      {
        text: `
          SELECT actor, subject_id, detail->>'outcome' AS outcome
          FROM audit_log
          WHERE action = 'fraud.reviewed'
          ORDER BY subject_id
        `,
      },
      2,
    );
    assert.deepEqual(
      audits,
      [
        {
          actor: adminActor,
          outcome: 'dismissed',
          subject_id: dismissed.flagId,
        },
        {
          actor: adminActor,
          outcome: 'upheld',
          subject_id: upheld.flagId,
        },
      ].sort((left, right) => left.subject_id.localeCompare(right.subject_id)),
    );

    const subscriberStatuses = await fixture.database.list<{
      readonly status: string;
    }>(
      {
        text: 'SELECT status FROM subscriber WHERE id = ANY($1::uuid[])',
        values: [[dismissed.subscriberId, upheld.subscriberId]],
      },
      2,
    );
    assert.deepEqual(
      subscriberStatuses.map(({ status }) => status),
      ['verified', 'verified'],
      'E5-05, not this review-state ticket, owns disqualification effects',
    );
  } finally {
    await fixture.dispose();
  }
});

test('E5-04 fraud queue enforces its hard batch cap and orders by review priority', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const lowPriority = await insertOpenFlag(fixture.database, {
      createdAt: new Date('2026-09-15T00:00:00.000Z'),
      kind: 'no_mx',
    });
    const highestPriority = await insertOpenFlag(fixture.database, {
      createdAt: new Date('2026-09-16T12:00:00.000Z'),
      kind: 'manual',
    });
    for (let index = 0; index < fraudReviewBatchMaximum; index += 1) {
      await insertOpenFlag(fixture.database, {
        createdAt: new Date(
          `2026-09-16T10:${String(index).padStart(2, '0')}:00.000Z`,
        ),
        kind: 'duplicate_identity',
      });
    }

    const route = createFraudQueueRoute(
      createFraudReviewService(fixture.applicationDatabase),
    );
    const request = new Request('https://valstara.test/api/admin/fraud');
    const response = await route(routeContext(request, { actor: adminActor }));
    const body = (await response.json()) as {
      readonly flags: readonly { readonly id: string }[];
      readonly limit: number;
    };

    assert.equal(response.status, 200);
    assert.equal(body.limit, fraudReviewBatchMaximum);
    assert.equal(body.flags.length, fraudReviewBatchMaximum);
    assert.equal(body.flags[0]?.id, highestPriority.flagId);
    assert.equal(
      body.flags.some((flag) => flag.id === lowPriority.flagId),
      false,
      'an older low-risk flag must not outrank decision priority',
    );

    await assert.rejects(
      createFraudReviewService(fixture.applicationDatabase).openFlags(
        fraudReviewBatchMaximum + 1,
      ),
      /batch limit/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test('E5-04 fraud response is decision-ready and redacts raw IP addresses and tokens', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const rawIp = '203.0.113.91';
    const rawToken = 'verification-token-that-must-not-leak';
    const flag = await insertOpenFlag(fixture.database, {
      detail: {
        match_count: 4,
        raw_ip: rawIp,
        reason: 'shared_local_part_across_domains',
        token: rawToken,
      },
      kind: 'duplicate_identity',
    });
    const route = createFraudQueueRoute(
      createFraudReviewService(fixture.applicationDatabase),
    );
    const request = new Request(
      'https://valstara.test/api/admin/fraud?limit=1',
    );
    const response = await route(routeContext(request, { actor: adminActor }));
    const text = await response.text();
    const body = JSON.parse(text) as {
      readonly flags: readonly {
        readonly evidence: Readonly<Record<string, unknown>>;
        readonly id: string;
        readonly kind: string;
        readonly priority: number;
        readonly raisedAt: string;
        readonly subscriber: {
          readonly confirmedReferrals: number;
          readonly country: string | null;
          readonly createdAt: string;
          readonly emailDomain: string;
          readonly id: string;
          readonly referralTier: number;
          readonly status: string;
          readonly verifiedAt: string | null;
        };
      }[];
    };

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(text, new RegExp(rawIp.replaceAll('.', '\\.')), rawIp);
    assert.doesNotMatch(text, new RegExp(rawToken), rawToken);
    const returnedFlag = body.flags[0];
    assert.ok(returnedFlag);
    const { createdAt, ...subscriber } = returnedFlag.subscriber;
    assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual(
      { ...returnedFlag, subscriber },
      {
        evidence: {
          match_count: 4,
          raw_ip: '[redacted]',
          reason: 'shared_local_part_across_domains',
          token: '[redacted]',
        },
        id: flag.flagId,
        kind: 'duplicate_identity',
        priority: 3,
        raisedAt: '2026-09-16T10:00:00.000Z',
        subscriber: {
          confirmedReferrals: 3,
          country: 'GB',
          emailDomain: 'review.example',
          id: flag.subscriberId,
          referralTier: 1,
          status: 'verified',
          verifiedAt: '2026-09-15T10:00:00.000Z',
        },
      },
    );
  } finally {
    await fixture.dispose();
  }
});
