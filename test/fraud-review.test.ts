import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

interface DisqualificationAssignment {
  readonly path: string;
  readonly statement: string;
}

function disqualificationAssignments(
  sources: readonly { readonly contents: string; readonly path: string }[],
): readonly DisqualificationAssignment[] {
  return sources.flatMap(({ contents, path }) =>
    [
      ...contents.matchAll(
        /\bUPDATE\s+subscriber\s+SET\b(?<set>[\s\S]*?)\bWHERE\b/giu,
      ),
    ]
      .filter(({ groups }) =>
        /\bstatus\s*=\s*'disqualified'/iu.test(groups?.set ?? ''),
      )
      .map((match) => ({ path, statement: match[0] })),
  );
}

test('E5-05 permits exactly one disqualification assignment: the actor-audited upheld transition', () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const sources: { contents: string; path: string }[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && extname(path) === '.ts') {
        sources.push({
          contents: readFileSync(path, 'utf8'),
          path: relative(repositoryRoot, path),
        });
      }
    }
  };
  visit(join(repositoryRoot, 'src'));

  const assignments = disqualificationAssignments(sources);
  assert.deepEqual(
    assignments.map(({ path }) => path),
    ['src/server/fraud/review.ts'],
  );

  const reviewSource = sources.find(
    ({ path }) => path === 'src/server/fraud/review.ts',
  );
  assert.ok(reviewSource, 'the fraud review service must exist');
  assert.match(
    reviewSource.contents,
    /const actor = rawActor\.trim\(\);[\s\S]*?if \(actor === ''\) \{[\s\S]*?throw new RangeError\('An authenticated actor is required\.'/u,
  );

  const upheldTransition = reviewSource.contents.match(
    /if \(outcome === 'upheld'\) \{(?<body>[\s\S]*?)\n\s*\}\n\n\s*const restored/u,
  );
  assert.ok(upheldTransition?.groups?.body, 'the upheld transition must exist');
  assert.match(
    upheldTransition.groups.body,
    /UPDATE\s+subscriber\s+SET[\s\S]*?status\s*=\s*'disqualified'/u,
  );
  assert.match(
    upheldTransition.groups.body,
    /action: 'subscriber\.disqualified',[\s\S]*?actor,/u,
  );
  assert.match(
    assignments[0]?.statement ?? '',
    /UPDATE\s+subscriber\s+SET[\s\S]*?status\s*=\s*'disqualified'/u,
  );
  assert.deepEqual(
    disqualificationAssignments([
      {
        contents:
          "const query = `UPDATE subscriber SET status = status WHERE status = 'disqualified'`;",
        path: 'src/server/subscriber/predicate-only.ts',
      },
    ]),
    [],
    'a status predicate must not be mistaken for a disqualification assignment',
  );
});

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
      subscriberStatuses.map(({ status }) => status).sort(),
      ['disqualified', 'verified'],
      'an upheld review now performs E5-05 disqualification',
    );
  } finally {
    await fixture.dispose();
  }
});

test('E5-05 upholding disqualifies only through review, isolates referred people, and voids only referral-derived entries', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const referrer = await insertOpenFlag(fixture.database);
    const referredId = randomUUID();
    const unrelatedId = randomUUID();
    const edgeId = randomUUID();
    const referralEntryId = randomUUID();
    const referredBaseEntryId = randomUUID();
    const unrelatedReferralEntryId = randomUUID();

    for (const [id, domain] of [
      [referredId, 'referred.example'],
      [unrelatedId, 'unrelated.example'],
    ] as const) {
      const email = `${id}@${domain}`;
      await fixture.database.execute({
        text: `
          INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
          VALUES ($1, $2, $2, $3, 'verified')
        `,
        values: [id, email, domain],
      });
    }
    await fixture.database.execute({
      text: `
        INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
        VALUES ($1, $2, $3, 'confirmed', 'settled')
      `,
      values: [edgeId, referrer.subscriberId, referredId],
    });
    for (const [id, subscriberId, method, sourceEdgeId] of [
      [referralEntryId, referrer.subscriberId, 'referral', edgeId],
      [referredBaseEntryId, referredId, 'base', null],
      [unrelatedReferralEntryId, unrelatedId, 'referral', null],
    ] as const) {
      await fixture.database.execute({
        text: `
          INSERT INTO giveaway_entry (
            id, subscriber_id, method, entries, jurisdiction, rules_version, source_edge_id
          ) VALUES ($1, $2, $3, 1, 'GB', 'test-rules', $4)
        `,
        values: [id, subscriberId, method, sourceEdgeId],
      });
    }

    await createFraudReviewService(fixture.applicationDatabase).review(
      referrer.flagId,
      'upheld',
      adminActor,
    );

    assert.deepEqual(
      await fixture.database.readOne({
        text: `
          SELECT status, disqualified_by_flag_id::text
          FROM subscriber WHERE id = $1
        `,
        values: [referrer.subscriberId],
      }),
      { disqualified_by_flag_id: referrer.flagId, status: 'disqualified' },
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: 'SELECT status FROM subscriber WHERE id = $1',
        values: [referredId],
      }),
      { status: 'verified' },
      'a referrer decision must not punish the referred subscriber',
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: `
          SELECT state, rejected_reason, state_before_rejection
          FROM referral_edge WHERE id = $1
        `,
        values: [edgeId],
      }),
      {
        rejected_reason: 'referrer_disqualified',
        state: 'rejected',
        state_before_rejection: 'confirmed',
      },
    );
    const entries = await fixture.database.list<{
      readonly id: string;
      readonly voided_at: Date | null;
    }>(
      {
        text: `
          SELECT id::text, voided_at FROM giveaway_entry
          WHERE id = ANY($1::uuid[])
          ORDER BY id
        `,
        values: [
          [referralEntryId, referredBaseEntryId, unrelatedReferralEntryId],
        ],
      },
      3,
    );
    assert.deepEqual(
      entries.map((entry) => ({
        id: entry.id,
        voided: entry.voided_at !== null,
      })),
      [
        { id: referralEntryId, voided: true },
        { id: referredBaseEntryId, voided: false },
        { id: unrelatedReferralEntryId, voided: false },
      ].sort((left, right) => left.id.localeCompare(right.id)),
      'only the disqualified referrer’s referral-derived entry is voided',
    );
    const audits = await fixture.database.list<{
      readonly action: string;
      readonly actor: string;
    }>(
      {
        text: `
          SELECT action, actor FROM audit_log
          WHERE subject_id = $1
          ORDER BY action
        `,
        values: [referrer.subscriberId],
      },
      2,
    );
    assert.deepEqual(audits, [
      { action: 'subscriber.disqualified', actor: adminActor },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test('E5-05 requires an actor and rolls back a disqualification when its audit cannot be written', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const flag = await insertOpenFlag(fixture.database);
    const review = createFraudReviewService(fixture.applicationDatabase);
    await assert.rejects(
      review.review(flag.flagId, 'upheld', '  '),
      /authenticated actor/u,
    );
    await fixture.database.execute({
      text: 'REVOKE INSERT ON TABLE audit_log FROM valstara_app',
    });
    await assert.rejects(
      review.review(flag.flagId, 'upheld', adminActor),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '42501',
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: `SELECT state FROM fraud_flag WHERE id = $1`,
        values: [flag.flagId],
      }),
      { state: 'open' },
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: `SELECT status FROM subscriber WHERE id = $1`,
        values: [flag.subscriberId],
      }),
      { status: 'verified' },
    );
  } finally {
    await fixture.database.execute({
      text: 'GRANT INSERT ON TABLE audit_log TO valstara_app',
    });
    await fixture.dispose();
  }
});

test('E5-05 reversing an upheld review restores the recorded state and audits the reversal', async () => {
  const fixture = await createDatabaseFixture();
  try {
    const flag = await insertOpenFlag(fixture.database);
    const referredId = randomUUID();
    const edgeId = randomUUID();
    const entryId = randomUUID();
    const referredEmail = `${referredId}@reversal.example`;
    await fixture.database.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
             VALUES ($1, $2, $2, 'reversal.example', 'verified')`,
      values: [referredId, referredEmail],
    });
    await fixture.database.execute({
      text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
             VALUES ($1, $2, $3, 'attributed', 'none')`,
      values: [edgeId, flag.subscriberId, referredId],
    });
    await fixture.database.execute({
      text: `INSERT INTO giveaway_entry (id, subscriber_id, method, entries, jurisdiction, rules_version, source_edge_id)
             VALUES ($1, $2, 'referral', 1, 'GB', 'test-rules', $3)`,
      values: [entryId, flag.subscriberId, edgeId],
    });
    const review = createFraudReviewService(fixture.applicationDatabase);
    await review.review(flag.flagId, 'upheld', adminActor);
    await review.review(flag.flagId, 'dismissed', adminActor);

    assert.deepEqual(
      await fixture.database.readOne({
        text: `SELECT status, disqualified_at, disqualified_by_flag_id
               FROM subscriber WHERE id = $1`,
        values: [flag.subscriberId],
      }),
      {
        disqualified_at: null,
        disqualified_by_flag_id: null,
        status: 'verified',
      },
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: `SELECT state, rejected_reason, state_before_rejection
               FROM referral_edge WHERE id = $1`,
        values: [edgeId],
      }),
      {
        rejected_reason: null,
        state: 'attributed',
        state_before_rejection: null,
      },
    );
    assert.deepEqual(
      await fixture.database.readOne({
        text: `SELECT voided_at, voided_by_disqualification_flag_id
               FROM giveaway_entry WHERE id = $1`,
        values: [entryId],
      }),
      { voided_at: null, voided_by_disqualification_flag_id: null },
    );
    assert.deepEqual(
      await fixture.database.list(
        {
          text: `SELECT action, actor FROM audit_log
                 WHERE subject_id = $1 ORDER BY action`,
          values: [flag.subscriberId],
        },
        2,
      ),
      [
        { action: 'subscriber.disqualification_reversed', actor: adminActor },
        { action: 'subscriber.disqualified', actor: adminActor },
      ],
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
