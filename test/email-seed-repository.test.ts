import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import { createSeedTestRepository } from '../src/server/db/seed-test.ts';
import { seedTestHealth } from '../src/server/email/seed-test.ts';

test('UTC Monday seed records survive a west-of-UTC local timezone', async () => {
  const timezoneVariable = 'TZ';
  const originalTimezone = process.env[timezoneVariable];
  const name = `valstara_e804_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
  );
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password =
    process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  let app: ReturnType<typeof createPool> | null = null;
  try {
    process.env[timezoneVariable] = 'America/Los_Angeles';
    await runMigrations(owner, {
      applicationRolePassword: appUrl.password,
      release: 'e8-04-test',
    });
    app = createPool(appUrl.toString());
    const repository = createSeedTestRepository(app);
    const week = new Date('2026-09-28T00:00:00.000Z');
    const firstMarker = randomUUID();
    const [first, second] = await Promise.all([
      repository.ensure(week, 'gmail', firstMarker),
      repository.ensure(week, 'gmail', randomUUID()),
    ]);
    assert.equal(first.marker, second.marker);
    assert.equal(first.week_start, '2026-09-28');
    const sentAt = new Date('2026-09-29T09:00:00.000Z');
    await repository.markSent(week, 'gmail', sentAt);
    await repository.markPlacement(week, 'gmail', 'spam', sentAt);
    await repository.markAlerted(week, 'gmail', sentAt);
    const row = (await repository.latest())[0];
    assert.equal(row?.placement, 'spam');
    assert.deepEqual(row?.sent_at, sentAt);
    assert.deepEqual(row?.checked_at, sentAt);
    assert.deepEqual(row?.alerted_at, sentAt);
    const health = await seedTestHealth(repository, () => sentAt);
    assert.equal(health.state, 'incomplete');
    assert.equal(
      health.providers.find((entry) => entry.provider === 'gmail')?.placement,
      'spam',
    );
    const count = await owner.readOne<{ count: string }>({
      text: 'SELECT COUNT(*)::text AS count FROM email_seed_test',
    });
    assert.equal(count?.count, '1');
    await assert.rejects(
      repository.ensure(
        new Date('2026-09-29T00:00:00.000Z'),
        'gmx',
        randomUUID(),
      ),
    );
  } finally {
    if (originalTimezone === undefined) delete process.env[timezoneVariable];
    else process.env[timezoneVariable] = originalTimezone;
    await app?.close();
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
