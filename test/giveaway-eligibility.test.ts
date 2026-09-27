import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import { createFlagService } from '../src/server/flags/service.ts';
import {
  createGiveawayEligibilityService,
  createGiveawayEligibilityServiceWithDependencies,
} from '../src/server/giveaway/eligibility.ts';

const baseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

test('eligibility and entry accrual read no location field', async () => {
  const directory = new URL('../src/server/giveaway/', import.meta.url);
  const names = ['eligibility.ts', 'accrue.ts', 'reconcile.ts'];
  for (const name of names) {
    const source = await readFile(new URL(name, directory), 'utf8');
    const parsed = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const locationInput = /country|region|location/iu;
    function scan(node: ts.Node): void {
      if (
        (ts.isIdentifier(node) && locationInput.test(node.text)) ||
        (ts.isStringLiteralLike(node) && locationInput.test(node.text))
      ) {
        assert.fail(
          `${name} references a location input: ${node.getText(parsed)}`,
        );
      }
      ts.forEachChild(node, scan);
    }
    scan(parsed);
  }
  const eligibility = await readFile(
    new URL('eligibility.ts', directory),
    'utf8',
  );
  assert.match(eligibility, /isEligible\(subscriberId: string\)/u);
});

test('flag-off eligibility is false without a subscriber read', async () => {
  let reads = 0;
  const service = createGiveawayEligibilityServiceWithDependencies(
    {
      async statusFor() {
        reads += 1;
        return 'verified';
      },
    },
    {
      async isEnabled() {
        return false;
      },
    },
  );
  assert.equal(await service.isEligible(randomUUID()), false);
  assert.equal(reads, 0);
});

test('only verified subscribers are eligible, independent of marketing consent', async () => {
  const name = `valstara_e701_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  const app = createPool(appUrl.toString());

  try {
    await runMigrations(owner, {
      applicationRolePassword: appPassword,
      release: 'e7-01-test',
    });
    const flags = createFlagService(app);
    const eligibility = createGiveawayEligibilityService(app, flags);
    const statuses = [
      'pending',
      'verified',
      'expired',
      'unsubscribed',
      'bounced',
      'disqualified',
    ] as const;
    const ids = new Map<string, string>();

    for (const status of statuses) {
      const id = randomUUID();
      ids.set(status, id);
      const email = `${status}@example.test`;
      await owner.execute({
        text: `INSERT INTO subscriber
          (id, email, email_normalised, email_domain, status)
          VALUES ($1, $2, $2, 'example.test', $3)`,
        values: [id, email, status],
      });
    }
    const verifiedId = ids.get('verified');
    assert.ok(verifiedId);

    // The code default is off. No eligibility lookup changes a waitlist row.
    for (const id of ids.values()) {
      assert.equal(await eligibility.isEligible(id), false);
    }
    assert.equal(await eligibility.isEligible(randomUUID()), false);
    await flags.set('giveaway.open', true, 'e7-01-test');

    for (const [status, id] of ids) {
      assert.equal(
        await eligibility.isEligible(id),
        status === 'verified',
        status,
      );
    }
    assert.equal(await eligibility.isEligible(randomUUID()), false);

    await owner.execute({
      text: `UPDATE subscriber SET marketing_consent_at = $2,
        marketing_consent_version = 'e7-test', marketing_consent_source = 'member_status'
        WHERE id = $1`,
      values: [verifiedId, new Date('2026-09-25T12:00:00.000Z')],
    });
    assert.equal(await eligibility.isEligible(verifiedId), true);
    await owner.execute({
      text: `UPDATE subscriber SET marketing_consent_at = NULL,
        marketing_consent_version = NULL, marketing_consent_source = NULL
        WHERE id = $1`,
      values: [verifiedId],
    });
    assert.equal(await eligibility.isEligible(verifiedId), true);

    await flags.set('giveaway.open', false, 'e7-01-test');
    for (const id of ids.values()) {
      assert.equal(await eligibility.isEligible(id), false);
    }
    const rows = await owner.list<{
      status: string;
      giveaway_rules_version: string | null;
    }>(
      {
        text: 'SELECT status, giveaway_rules_version FROM subscriber ORDER BY status',
      },
      statuses.length,
    );
    assert.deepEqual(
      rows.map((row) => row.status),
      [...statuses].sort(),
    );
    assert.equal(
      rows.every((row) => row.giveaway_rules_version === null),
      true,
    );
    const entryCount = await owner.readOne<{ count: string }>({
      text: 'SELECT count(*)::text AS count FROM giveaway_entry',
    });
    assert.equal(entryCount?.count, '0');
  } finally {
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
  }
});
