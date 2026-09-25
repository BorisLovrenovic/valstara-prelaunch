import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createMarketingRoute } from '../src/pages/api/me/marketing.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createMarketingService } from '../src/server/subscriber/marketing.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';

const baseUrl = process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword = process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const migrationDirectory = fileURLToPath(new URL('../src/server/db/migrations/', import.meta.url));
const signupTime = new Date('2026-09-25T10:00:00.000Z');
const verificationTime = new Date('2026-09-25T10:05:00.000Z');

async function fixture(migrate = true) {
  const name = `valstara_s01_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  if (migrate) await runMigrations(owner, { applicationRolePassword: appPassword, release: 's01-test' });
  const app = createPool(appUrl.toString());
  return {
    owner, app,
    async dispose() {
      await app.close();
      await owner.close();
      await admin.list({
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        values: [name],
      }, 10);
      await admin.execute({ text: `DROP DATABASE "${name}"` });
      await admin.close();
    },
  };
}

async function subscriberRow(database: DatabasePool, id: string) {
  return database.readOne<{
    access_window: string | null;
    marketing_consent_at: Date | null;
    marketing_consent_source: string | null;
    marketing_consent_version: string | null;
    marketing_opt_in_pending: boolean;
    marketing_opt_in_pending_version: string | null;
    referral_code: string | null;
    status: string;
  }>({
    text: `SELECT access_window, marketing_consent_at, marketing_consent_source,
      marketing_consent_version, marketing_opt_in_pending,
      marketing_opt_in_pending_version, referral_code, status
      FROM subscriber WHERE id = $1`,
    values: [id],
  });
}

async function seedVerified(database: DatabasePool, label: string) {
  const id = randomUUID();
  const email = `${label}@example.test`;
  await database.execute({
    text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
      status, verified_at, referral_code, access_window)
      VALUES ($1, $2, $2, 'example.test', 'verified', $3, $4, 'wave-2')`,
    values: [id, email, signupTime, `CODE${id.slice(0, 8)}`],
  });
  return id;
}

async function seedStatusToken(database: DatabasePool, subscriberId: string, token: string, expiresAt: Date) {
  await database.execute({
    text: `INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at)
      VALUES ($1, $2, $3, 'status', $4)`,
    values: [randomUUID(), subscriberId, createHash('sha256').update(token).digest(), expiresAt],
  });
}

function routeContext(token: string, marketing: 'on' | 'off', challenge = 'ok') {
  const request = new Request('https://valstara.test/api/me/marketing', {
    method: 'POST',
    body: new URLSearchParams({ t: token, marketing, turnstile_token: challenge }),
  });
  return { clientAddress: '203.0.113.24', request } as never;
}

test('S-01 migration removes location and AMOE and enforces both consent checks', async () => {
  const f = await fixture();
  try {
    const columns = await f.owner.list<{ table_name: string; column_name: string }>({
      text: `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('subscriber', 'giveaway_entry') ORDER BY table_name, column_name`,
    }, 100);
    const names = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
    for (const name of ['subscriber.country', 'subscriber.country_detected', 'subscriber.region',
      'subscriber.giveaway_eligible', 'giveaway_entry.jurisdiction']) {
      assert.equal(names.has(name), false, name);
    }
    for (const name of ['marketing_consent_at', 'marketing_consent_version',
      'marketing_consent_source', 'marketing_opt_in_pending', 'marketing_opt_in_pending_version']) {
      assert.equal(names.has(`subscriber.${name}`), true, name);
    }
    const id = await seedVerified(f.owner, 'migration');
    await assert.rejects(f.owner.execute({
      text: `UPDATE subscriber SET marketing_opt_in_pending = true WHERE id = $1`,
      values: [id],
    }), { code: '23514' });
    await assert.rejects(f.owner.execute({
      text: `UPDATE subscriber SET marketing_opt_in_pending_version = 'v1' WHERE id = $1`,
      values: [id],
    }), { code: '23514' });
    await assert.rejects(f.owner.execute({
      text: `UPDATE subscriber SET marketing_consent_at = $2 WHERE id = $1`,
      values: [id, signupTime],
    }), { code: '23514' });
    await assert.rejects(f.owner.execute({
      text: `INSERT INTO giveaway_entry (id, subscriber_id, method, entries, rules_version)
        VALUES ($1, $2, 'amoe', 1, 'v1')`,
      values: [randomUUID(), id],
    }), { code: '23514' });
    assert.equal((await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM migration_ledger WHERE filename LIKE '0023-%'`,
    }))?.count, '1');
  } finally { await f.dispose(); }
});

test('S-01 migration refuses a nonempty entry ledger without changing its schema or ledger', async () => {
  const f = await fixture(false);
  const directory = await mkdtemp(join(tmpdir(), 'valstara-s01-migrations-'));
  try {
    for (const filename of await readdir(migrationDirectory)) {
      if (/^\d{4}-.*\.sql$/u.test(filename) && !filename.startsWith('0023-')) {
        await cp(join(migrationDirectory, filename), join(directory, filename));
      }
    }
    await runMigrations(f.owner, { applicationRolePassword: appPassword, directory, release: 'before-s01' });
    const subscriberId = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status)
        VALUES ($1, 'before@example.test', 'before@example.test', 'example.test', 'verified')`,
      values: [subscriberId],
    });
    await f.owner.execute({
      text: `INSERT INTO giveaway_entry (id, subscriber_id, method, entries, jurisdiction, rules_version)
        VALUES ($1, $2, 'base', 1, 'GB', 'old')`,
      values: [randomUUID(), subscriberId],
    });
    await assert.rejects(
      runMigrations(f.owner, { applicationRolePassword: appPassword, release: 's01' }),
      /S-01 requires an empty giveaway_entry ledger/u,
    );
    const stillPresent = await f.owner.readOne<{ column_name: string }>({
      text: `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'subscriber' AND column_name = 'country'`,
    });
    assert.equal(stillPresent?.column_name, 'country');
    const ledger = await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM migration_ledger WHERE filename LIKE '0023-%'`,
    });
    assert.equal(ledger?.count, '0');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.dispose();
  }
});

test('pending wording version survives a copy change and becomes audited consent only at verification', async () => {
  const f = await fixture();
  const sent: string[] = [];
  try {
    const signup = createSignupService(f.app, {
      clock: () => signupTime,
      screenEmailDomain: async () => ({ flags: [] }),
      raiseFraudFlag: async () => undefined,
      sendVerificationMail: async (mail) => { sent.push(mail.verificationUrl); },
    });
    const input = (email: string, marketingOptInVersion: string | null) => ({
      email, marketingOptInVersion,
      verificationUrl: (token: string) => `https://valstara.test/verify?token=${token}`,
    });
    const ticked = await signup(input('ticked@example.test', 'v1'));
    const unticked = await signup(input('unticked@example.test', null));
    assert.equal(ticked.kind, 'created');
    assert.equal(unticked.kind, 'created');
    if (ticked.kind !== 'created' || unticked.kind !== 'created') throw new Error('Fixture failed');
    assert.deepEqual(await subscriberRow(f.owner, ticked.subscriber.id), {
      access_window: null, marketing_consent_at: null, marketing_consent_source: null,
      marketing_consent_version: null, marketing_opt_in_pending: true,
      marketing_opt_in_pending_version: 'v1', referral_code: null, status: 'pending',
    });
    assert.equal((await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM audit_log WHERE action = 'consent.marketing_granted'`,
    }))?.count, '0');
    // Simulates a newly deployed wording version before the first mail is verified.
    const repeat = await signup(input('ticked@example.test', 'v2'));
    assert.equal(repeat.kind, 'existing');
    assert.equal((await subscriberRow(f.owner, ticked.subscriber.id))?.marketing_opt_in_pending_version, 'v2');

    const complete = createVerificationCompletionService(f.app, { clock: () => verificationTime });
    const tickedToken = new URL(sent[0]!).searchParams.get('token')!;
    const untickedToken = new URL(sent[1]!).searchParams.get('token')!;
    assert.equal((await complete(tickedToken)).outcome, 'verified');
    assert.equal((await complete(untickedToken)).outcome, 'verified');
    const tickedRow = await subscriberRow(f.owner, ticked.subscriber.id);
    const untickedRow = await subscriberRow(f.owner, unticked.subscriber.id);
    assert.equal(tickedRow?.marketing_consent_at?.toISOString(), verificationTime.toISOString());
    assert.equal(tickedRow?.marketing_consent_version, 'v2');
    assert.equal(tickedRow?.marketing_consent_source, 'signup');
    assert.equal(tickedRow?.marketing_opt_in_pending, false);
    assert.equal(tickedRow?.marketing_opt_in_pending_version, null);
    assert.equal(untickedRow?.marketing_consent_at, null);
    assert.equal(untickedRow?.marketing_consent_version, null);
    assert.equal(untickedRow?.marketing_opt_in_pending, false);
    assert.equal(tickedRow?.status, untickedRow?.status);
    assert.equal(tickedRow?.access_window, untickedRow?.access_window);
    assert.notEqual(tickedRow?.referral_code, null);
    assert.notEqual(untickedRow?.referral_code, null);
    assert.equal((await f.owner.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM giveaway_entry WHERE subscriber_id IN ($1, $2)',
      values: [ticked.subscriber.id, unticked.subscriber.id],
    }))?.count, '0');
    const audit = await f.owner.list<{ action: string; detail: { version: string }; subject_id: string }>({
      text: `SELECT action, detail, subject_id FROM audit_log WHERE action = 'consent.marketing_granted'`,
    }, 2);
    assert.deepEqual(audit, [{ action: 'consent.marketing_granted', detail: { source: 'signup', version: 'v2' }, subject_id: ticked.subscriber.id }]);
    assert.equal((await complete(tickedToken)).outcome, 'already');
    assert.equal((await signup(input('ticked@example.test', 'v3'))).kind, 'already_verified');
    assert.deepEqual(await subscriberRow(f.owner, ticked.subscriber.id), tickedRow);
    assert.equal((await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM audit_log WHERE action = 'consent.marketing_granted'`,
    }))?.count, '1');
  } finally { await f.dispose(); }
});

test('marketing route grants and withdraws consent without changing waitlist or entries', async () => {
  const f = await fixture();
  try {
    const id = await seedVerified(f.owner, 'member');
    const otherId = await seedVerified(f.owner, 'other');
    await f.owner.execute({
      text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state)
        VALUES ($1, $2, $3, 'confirmed', 'settled')`,
      values: [randomUUID(), id, otherId],
    });
    await f.owner.execute({
      text: `INSERT INTO giveaway_entry (id, subscriber_id, method, entries, rules_version)
        VALUES ($1, $2, 'base', 3, 'v1')`,
      values: [randomUUID(), id],
    });
    await seedStatusToken(f.owner, id, 'valid-status-token', new Date('2026-10-25T00:00:00.000Z'));
    const flags = { isEnabled: async () => true };
    const service = createMarketingService(f.app, { flags, clock: () => verificationTime });
    const route = createMarketingRoute({
      verifyTurnstile: async () => 'verified',
      change: service.change,
      ipPrefixPepper: 's01-route-pepper',
    });
    const before = await f.owner.readOne<{ status: string; access_window: string; referral_code: string }>({
      text: 'SELECT status, access_window, referral_code FROM subscriber WHERE id = $1', values: [id],
    });
    const responseOn = await route(routeContext('valid-status-token', 'on'));
    assert.equal(responseOn.status, 200);
    assert.equal((await subscriberRow(f.owner, id))?.marketing_consent_source, 'member_status');
    assert.equal((await subscriberRow(f.owner, id))?.marketing_consent_version, 'v1');
    const responseOff = await route(routeContext('valid-status-token', 'off'));
    assert.equal(responseOff.status, 200);
    assert.equal((await subscriberRow(f.owner, id))?.marketing_consent_at, null);
    const after = await f.owner.readOne<{ status: string; access_window: string; referral_code: string }>({
      text: 'SELECT status, access_window, referral_code FROM subscriber WHERE id = $1', values: [id],
    });
    assert.deepEqual(after, before);
    assert.equal((await f.owner.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM referral_edge WHERE referrer_id = $1', values: [id],
    }))?.count, '1');
    assert.equal((await f.owner.readOne<{ entries: number }>({
      text: 'SELECT entries FROM giveaway_entry WHERE subscriber_id = $1', values: [id],
    }))?.entries, 3);
    const actions = await f.owner.list<{ action: string }>({
      text: `SELECT action FROM audit_log WHERE subject_id = $1 ORDER BY at, action`, values: [id],
    }, 10);
    assert.deepEqual(actions.map((row) => row.action), ['consent.marketing_granted', 'consent.marketing_withdrawn']);
  } finally { await f.dispose(); }
});

test('marketing route treats tampered and expired tokens identically, protects Turnstile first, and honors flag off', async () => {
  const f = await fixture();
  try {
    const id = await seedVerified(f.owner, 'token');
    await seedStatusToken(f.owner, id, 'expired-token', verificationTime);
    const service = createMarketingService(f.app, {
      flags: { isEnabled: async () => true }, clock: () => verificationTime,
    });
    const route = createMarketingRoute({
      verifyTurnstile: async () => 'verified', change: service.change, ipPrefixPepper: 's01-route-pepper',
    });
    const expired = await route(routeContext('expired-token', 'on'));
    const tampered = await route(routeContext('tampered-token', 'on'));
    assert.equal(expired.status, 200);
    assert.equal(tampered.status, 200);
    assert.deepEqual(await expired.json(), await tampered.json());
    assert.equal((await subscriberRow(f.owner, id))?.marketing_consent_at, null);

    let changed = false;
    const rejected = createMarketingRoute({
      verifyTurnstile: async () => 'rejected',
      change: async () => { changed = true; return 'accepted'; },
      ipPrefixPepper: 's01-route-pepper',
    });
    assert.equal((await rejected(routeContext('expired-token', 'on'))).status, 400);
    assert.equal(changed, false);

    const disabled = createMarketingRoute({
      verifyTurnstile: async () => 'verified',
      change: createMarketingService(f.app, {
        flags: { isEnabled: async () => false }, clock: () => verificationTime,
      }).change,
      ipPrefixPepper: 's01-route-pepper',
    });
    const offResponse = await disabled(routeContext('expired-token', 'on'));
    assert.equal(offResponse.status, 503);
    assert.equal((await offResponse.json()).error.code, 'unavailable');
    assert.equal((await subscriberRow(f.owner, id))?.marketing_consent_at, null);
  } finally { await f.dispose(); }
});

test('marketing route applies database-backed limits and flags a recognised subscriber on Turnstile timeout', async () => {
  const f = await fixture();
  try {
    const id = await seedVerified(f.owner, 'limited');
    await seedStatusToken(f.owner, id, 'limited-token', new Date('2026-10-25T00:00:00.000Z'));
    const service = createMarketingService(f.app, {
      flags: { isEnabled: async () => true }, clock: () => verificationTime,
    });
    const route = createMarketingRoute({
      verifyTurnstile: async () => 'unavailable', change: service.change,
      ipPrefixPepper: 's01-limited-pepper',
    });
    assert.equal((await route(routeContext('limited-token', 'on'))).status, 200);
    assert.equal((await route(routeContext('limited-token', 'off'))).status, 200);
    assert.equal((await route(routeContext('limited-token', 'on'))).status, 429);
    assert.equal((await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM fraud_flag
        WHERE subscriber_id = $1 AND kind = 'challenge_timeout'`,
      values: [id],
    }))?.count, '1');
    assert.equal((await subscriberRow(f.owner, id))?.marketing_consent_at, null);
  } finally { await f.dispose(); }
});

test('a consent audit failure rolls back a member preference change', async () => {
  const f = await fixture();
  try {
    const id = await seedVerified(f.owner, 'rollback');
    await seedStatusToken(f.owner, id, 'rollback-token', new Date('2026-10-25T00:00:00.000Z'));
    await f.owner.execute({
      text: `ALTER TABLE audit_log ADD CONSTRAINT reject_consent_audit
        CHECK (action NOT LIKE 'consent.%')`,
    });
    const route = createMarketingRoute({
      verifyTurnstile: async () => 'verified',
      change: createMarketingService(f.app, {
        flags: { isEnabled: async () => true }, clock: () => verificationTime,
      }).change,
      ipPrefixPepper: 's01-rollback-pepper',
    });
    assert.equal((await route(routeContext('rollback-token', 'on'))).status, 500);
    assert.equal((await subscriberRow(f.owner, id))?.marketing_consent_at, null);
  } finally { await f.dispose(); }
});

test('a consent audit failure rolls back verification and leaves the pending wording version intact', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await f.owner.execute({
      text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
        status, marketing_opt_in_pending, marketing_opt_in_pending_version)
        VALUES ($1, 'verify-audit@example.test', 'verify-audit@example.test',
          'example.test', 'pending', true, 'v1')`,
      values: [id],
    });
    const token = 'audit-failure-verification-token';
    await f.owner.execute({
      text: `INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at)
        VALUES ($1, $2, $3, 'verify', $4)`,
      values: [randomUUID(), id, createHash('sha256').update(token).digest(), new Date('2026-10-01T00:00:00.000Z')],
    });
    await f.owner.execute({
      text: `ALTER TABLE audit_log ADD CONSTRAINT reject_consent_audit
        CHECK (action NOT LIKE 'consent.%')`,
    });
    await assert.rejects(createVerificationCompletionService(f.app, {
      clock: () => verificationTime,
    })(token), { code: '23514' });
    const row = await subscriberRow(f.owner, id);
    assert.equal(row?.status, 'pending');
    assert.equal(row?.marketing_opt_in_pending, true);
    assert.equal(row?.marketing_opt_in_pending_version, 'v1');
    assert.equal(row?.marketing_consent_at, null);
    assert.equal((await f.owner.readOne<{ consumed_at: Date | null }>({
      text: 'SELECT consumed_at FROM verification_token WHERE subscriber_id = $1', values: [id],
    }))?.consumed_at, null);
  } finally { await f.dispose(); }
});
