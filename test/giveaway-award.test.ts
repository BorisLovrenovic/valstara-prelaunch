import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { createVerificationService } from '../src/server/verification/service.ts';
import { createAwardService } from '../src/server/giveaway/award.ts';
import {
  availableProducts,
  validateAwardCatalog,
} from '../src/server/giveaway/award-catalog.ts';

const baseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const rulesVersion = 'VAL-GW-LAUNCH-20260925-r1';
const timestamp = new Date('2027-04-01T12:00:00.000Z');
const catalog = validateAwardCatalog(
  {
    rulesVersion,
    approvedBy: 'founder:test',
    bundleProductIds: ['bundle-item'],
    products: [
      {
        id: 'bundle-item',
        name: 'Bundle item',
        retailValueEurCents: 30000,
        availableGlobally: true,
        unavailableCountries: ['CA'],
        replacementEligible: false,
      },
      {
        id: 'replacement',
        name: 'Replacement',
        retailValueEurCents: 30000,
        availableGlobally: true,
        unavailableCountries: [],
        replacementEligible: true,
      },
      {
        id: 'cheap',
        name: 'Insufficient replacement',
        retailValueEurCents: 5000,
        availableGlobally: true,
        unavailableCountries: [],
        replacementEligible: true,
      },
    ],
  },
  rulesVersion,
  30000,
);

interface Fixture {
  owner: DatabasePool;
  app: DatabasePool;
  close(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const name = `valstara_e706_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword: appPassword,
    release: 'e7-06-test',
  });
  const app = createPool(appUrl.toString());
  return {
    owner,
    app,
    async close() {
      await app.close();
      await owner.close();
      await admin.list(
        {
          text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          values: [name],
        },
        10,
      );
      await admin.execute({ text: `DROP DATABASE "${name}"` });
      await admin.close();
    },
  };
}

async function person(owner: DatabasePool): Promise<string> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await owner.execute({
    text: `INSERT INTO subscriber
             (id, email, email_normalised, email_domain, status, verified_at)
           VALUES ($1, $2, $2, 'example.test', 'verified', $3)`,
    values: [id, email, timestamp],
  });
  return id;
}

async function publishedDraw(owner: DatabasePool, people: readonly string[]) {
  const drawId = randomUUID();
  const entryIds: string[] = [];
  const committed = new Date(timestamp.getTime() - 10 * 60_000);
  await owner.execute({
    text: 'INSERT INTO giveaway_draw (id, executed_by) VALUES ($1, $2)',
    values: [drawId, 'admin:test'],
  });
  for (const [index, subscriberId] of people.entries()) {
    const entryId = randomUUID();
    entryIds.push(entryId);
    await owner.execute({
      text: `INSERT INTO giveaway_entry
               (id, subscriber_id, method, entries, rules_version, rules_sha256)
             VALUES ($1, $2, 'base', 1, $3, decode($4, 'hex'))`,
      values: [entryId, subscriberId, rulesVersion, 'ab'.repeat(32)],
    });
    await owner.execute({
      text: `INSERT INTO giveaway_draw_snapshot_row
               (draw_id, entry_id, subscriber_id, method, rules_version,
                rules_sha256)
             VALUES ($1, $2, $3, 'base', $4, decode($5, 'hex'))`,
      values: [drawId, entryId, subscriberId, rulesVersion, 'ab'.repeat(32)],
    });
    await owner.execute({
      text: `INSERT INTO giveaway_draw_selection
               (draw_id, position, subscriber_id, entry_id, is_winner)
             VALUES ($1, $2, $3, $4, $5)`,
      values: [drawId, index + 1, subscriberId, entryId, index === 0],
    });
  }
  await owner.execute({
    text: `UPDATE giveaway_draw SET snapshot_committed_at = $2,
             entry_snapshot_hash = decode($3, 'hex'), snapshot_count = $4,
             prize_count = 1, rules_version = $5,
             rules_sha256 = decode($6, 'hex'),
             drand_chain_hash = decode($7, 'hex'), drand_chain_info = '{}'::jsonb,
             target_round = 1, target_round_at = $8
           WHERE id = $1`,
    values: [
      drawId,
      committed,
      'cd'.repeat(32),
      people.length,
      rulesVersion,
      'ab'.repeat(32),
      'ef'.repeat(32),
      new Date(committed.getTime() + 6 * 60_000),
    ],
  });
  await owner.execute({
    text: `UPDATE giveaway_draw SET state = 'published', seed = $2,
             seed_generated_at = $3, beacon_round = 1,
             beacon_randomness = decode($4, 'hex'),
             beacon_signature = decode($5, 'hex'),
             beacon_relay_used = 'test',
             beacon_verified_relays = '["one", "two"]'::jsonb,
             winners = $6::jsonb, reproduced_at = $7,
             published_at = $7 WHERE id = $1`,
    values: [
      drawId,
      'ab'.repeat(32),
      new Date(committed.getTime() + 60_000),
      '12'.repeat(32),
      '34'.repeat(48),
      JSON.stringify([people[0]]),
      timestamp,
    ],
  });
  return { drawId, entryIds };
}

function service(
  db: DatabasePool,
  now: () => Date,
  sanctionedCountries: readonly string[] = [],
  enabled = true,
  reportP3: (at: Date, count: number) => void = () => {},
) {
  return createAwardService(db, {
    flags: { isEnabled: async () => enabled },
    clock: now,
    sanctionedCountries,
    substitutionDays: 14,
    catalog: async () => catalog,
    reportP3,
  });
}

const common = {
  ipPrefixHash: 'test-prefix',
  challengeTimedOut: false,
  publicityPermission: false,
};

test('notifications are one row per winner under real concurrency; only winner can answer', async () => {
  const db = await fixture();
  try {
    const winner = await person(db.owner);
    const outsider = await person(db.owner);
    const { drawId, entryIds } = await publishedDraw(db.owner, [
      winner,
      outsider,
    ]);
    assert.equal(
      await service(db.app, () => timestamp, [], false).initialize(),
      0,
    );
    const award = service(db.app, () => timestamp);
    await Promise.all(Array.from({ length: 8 }, () => award.initialize()));
    const rows = await db.owner.list<{ business_key: string }>(
      {
        text: `SELECT business_key FROM email_send
             WHERE template = 'giveaway_winner'`,
      },
      10,
    );
    assert.deepEqual(
      rows.map((row) => row.business_key),
      [`giveaway-winner:${drawId}:${entryIds[0]}`],
    );
    const awardRow = await db.owner.readOne<{
      id: string;
      entry_id: string;
      entry_snapshot_hash: Buffer;
    }>({
      text: 'SELECT id, entry_id, entry_snapshot_hash FROM giveaway_award',
    });
    assert.equal(awardRow?.entry_id, entryIds[0]);
    assert.equal(
      awardRow?.entry_snapshot_hash.toString('hex'),
      'cd'.repeat(32),
    );
    const outsiderToken = await createVerificationService(db.app, {
      clock: () => timestamp,
    }).issue(outsider, 'status');
    assert.equal(await award.ownAward(awardRow!.id, outsiderToken.token), null);
    assert.equal(
      await award.submitChecks({
        ...common,
        awardId: awardRow!.id,
        token: outsiderToken.token,
        country: 'US',
        ageConfirmed: true,
        skillAnswer: '',
      }),
      'accepted',
    );
    const country = await db.owner.readOne<{
      country_of_residence: string | null;
    }>({
      text: 'SELECT country_of_residence FROM giveaway_award',
    });
    assert.equal(country?.country_of_residence, null);
    const columns = await db.owner.list<{ column_name: string }>(
      {
        text: `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'giveaway_award'`,
      },
      100,
    );
    assert.equal(
      columns.some((column) =>
        /postal|address|region/i.test(column.column_name),
      ),
      false,
    );
    assert.deepEqual(
      await service(db.app, () => timestamp, [], false).expireDue(),
      { responses: 0, substitutions: 0 },
    );
  } finally {
    await db.close();
  }
});

test('sanctions and wrong Canadian answer replace from the ordered reserve', async () => {
  for (const mode of ['sanctions', 'skill'] as const) {
    const db = await fixture();
    try {
      const alerts: { at: Date; count: number }[] = [];
      const winner = await person(db.owner);
      const reserve = await person(db.owner);
      await publishedDraw(db.owner, [winner, reserve]);
      const award = service(
        db.app,
        () => timestamp,
        mode === 'sanctions' ? ['CA'] : [],
        true,
        (at, count) => alerts.push({ at, count }),
      );
      await award.initialize();
      const row = await db.owner.readOne<{ id: string }>({
        text: 'SELECT id FROM giveaway_award',
      });
      const token = await createVerificationService(db.app, {
        clock: () => timestamp,
      }).issue(winner, 'status');
      assert.equal(
        await award.submitChecks({
          ...common,
          awardId: row!.id,
          token: token.token,
          country: 'CA',
          ageConfirmed: true,
          skillAnswer: mode === 'skill' ? '49' : '50',
        }),
        'replaced',
      );
      const after = await db.owner.readOne<{ subscriber_id: string }>({
        text: 'SELECT subscriber_id FROM giveaway_award',
      });
      assert.equal(after?.subscriber_id, reserve);
      assert.deepEqual(alerts, [{ at: timestamp, count: 1 }]);
      assert.deepEqual(await award.ownAward(row!.id, token.token), {
        id: row!.id,
        state: 'replaced',
      });
      const notices = await db.owner.readOne<{ count: string }>({
        text: `SELECT count(*)::text AS count FROM email_send
               WHERE template = 'giveaway_winner'`,
      });
      assert.equal(notices?.count, '2');
    } finally {
      await db.close();
    }
  }
});

test('age failure and response deadline replace; empty sanctions list permits Canada', async () => {
  const db = await fixture();
  try {
    const winner = await person(db.owner);
    const reserve = await person(db.owner);
    await publishedDraw(db.owner, [winner, reserve]);
    let now = timestamp;
    const award = service(db.app, () => now);
    await award.initialize();
    const row = await db.owner.readOne<{ id: string }>({
      text: 'SELECT id FROM giveaway_award',
    });
    const token = await createVerificationService(db.app, {
      clock: () => now,
    }).issue(winner, 'status');
    assert.equal(
      await award.submitChecks({
        ...common,
        awardId: row!.id,
        token: token.token,
        country: 'CA',
        ageConfirmed: false,
        skillAnswer: '50',
      }),
      'replaced',
    );
    now = new Date(timestamp.getTime() + 15 * 24 * 60 * 60_000);
    assert.deepEqual(await award.expireDue(), {
      responses: 1,
      substitutions: 0,
    });
    const final = await db.owner.readOne<{ state: string }>({
      text: 'SELECT state FROM giveaway_award',
    });
    assert.equal(final?.state, 'exhausted');
  } finally {
    await db.close();
  }
});

test('replacement value and substitution expiry keep the confirmed winner', async () => {
  for (const choice of ['replacement', 'expiry', 'decline'] as const) {
    const db = await fixture();
    try {
      const winner = await person(db.owner);
      const reserve = await person(db.owner);
      await publishedDraw(db.owner, [winner, reserve]);
      let now = timestamp;
      const award = service(db.app, () => now);
      await award.initialize();
      const row = await db.owner.readOne<{ id: string }>({
        text: 'SELECT id FROM giveaway_award',
      });
      const token = await createVerificationService(db.app, {
        clock: () => now,
      }).issue(winner, 'status');
      assert.equal(
        await award.submitChecks({
          ...common,
          awardId: row!.id,
          token: token.token,
          country: 'CA',
          ageConfirmed: true,
          skillAnswer: '50',
        }),
        'substitution_offered',
      );
      if (choice === 'replacement') {
        assert.equal(
          await award.chooseSubstitution({
            ...common,
            awardId: row!.id,
            token: token.token,
            choice: 'replacement',
            productIds: ['cheap'],
          }),
          'invalid_input',
        );
        assert.equal(
          await award.chooseSubstitution({
            ...common,
            awardId: row!.id,
            token: token.token,
            choice: 'replacement',
            productIds: ['replacement'],
          }),
          'confirmed',
        );
      } else if (choice === 'decline') {
        assert.equal(
          await award.chooseSubstitution({
            ...common,
            awardId: row!.id,
            token: token.token,
            choice: 'decline',
            productIds: [],
          }),
          'confirmed',
        );
      } else {
        now = new Date(timestamp.getTime() + 15 * 24 * 60 * 60_000);
        assert.deepEqual(await award.expireDue(), {
          responses: 0,
          substitutions: 1,
        });
      }
      const final = await db.owner.readOne<{
        state: string;
        subscriber_id: string;
        substitution_state: string;
        substitution: { cashEurCents?: number };
      }>({
        text: `SELECT state, subscriber_id, substitution_state,
                      substitution FROM giveaway_award`,
      });
      assert.equal(final?.state, 'confirmed');
      assert.equal(final?.subscriber_id, winner);
      assert.equal(
        final?.substitution_state,
        choice === 'replacement' ? 'replacement' : 'cash',
      );
      if (choice !== 'replacement')
        assert.equal(final?.substitution.cashEurCents, 30000);
      const audit = await db.owner.list<{ action: string }>(
        {
          text: `SELECT action FROM audit_log
               WHERE subject_type = 'giveaway_award'`,
        },
        30,
      );
      assert.equal(
        audit.some((entry) => entry.action === 'giveaway.substitution_offered'),
        true,
      );
      assert.equal(
        audit.some(
          (entry) =>
            entry.action ===
            (choice === 'replacement'
              ? 'giveaway.substitution_replacement'
              : 'giveaway.substitution_cash'),
        ),
        true,
      );
      const notices = await db.owner.readOne<{ count: string }>({
        text: `SELECT count(*)::text AS count FROM email_send
               WHERE template = 'giveaway_winner'`,
      });
      assert.equal(notices?.count, '1');
    } finally {
      await db.close();
    }
  }
});

test('award catalog requires founder approval, unique IDs and the stated value', () => {
  const approved = {
    rulesVersion,
    approvedBy: 'founder:test',
    bundleProductIds: ['one'],
    products: [
      {
        id: 'one',
        name: 'One',
        retailValueEurCents: 30000,
        availableGlobally: true,
        unavailableCountries: [],
        replacementEligible: false,
      },
    ],
  };
  assert.equal(
    validateAwardCatalog(approved, rulesVersion, 30000).bundleProductIds[0],
    'one',
  );
  assert.throws(() =>
    validateAwardCatalog(
      { ...approved, approvedBy: null },
      rulesVersion,
      30000,
    ),
  );
  assert.throws(() => validateAwardCatalog(approved, rulesVersion, 29999));
  assert.throws(() =>
    validateAwardCatalog(
      { ...approved, products: [approved.products[0], approved.products[0]] },
      rulesVersion,
      30000,
    ),
  );
  const globallyUnavailable = validateAwardCatalog(
    {
      ...approved,
      products: [{ ...approved.products[0], availableGlobally: false }],
    },
    rulesVersion,
    30000,
  );
  assert.deepEqual(
    availableProducts(globallyUnavailable, 'US').unavailable.map(
      (product) => product.id,
    ),
    ['one'],
  );
});
