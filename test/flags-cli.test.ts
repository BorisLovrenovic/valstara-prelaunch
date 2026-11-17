import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import { FlagCommandError, runFlagCommand } from '../src/server/flags/cli.ts';
import type { FlagKey } from '../src/server/flags/registry.ts';

// QA gate 7 (G7-1-I5): the runbook's incident levers need a production tool
// that sets a campaign flag with an audited actor.

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(
  new URL('../src/server/flags/cli.ts', import.meta.url),
);
const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

function recordingFlags() {
  const calls: { key: FlagKey; enabled: boolean; actor: string }[] = [];
  return {
    calls,
    async list() {
      return [
        { key: 'leaderboard.public' as const, enabled: true },
        { key: 'giveaway.open' as const, enabled: false },
      ];
    },
    async set(key: FlagKey, enabled: boolean, actor: string) {
      calls.push({ key, enabled, actor });
    },
  };
}

function output() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

test('a flag change without an actor, or for an unregistered key, sets nothing', async () => {
  for (const args of [
    ['set', 'leaderboard.public', 'off'],
    ['set', 'leaderboard.public', 'off', '--actor'],
    ['set', 'leaderboard.public', 'off', '--actor', '   '],
    ['set', 'leaderboard.public', 'off', '--actor', '--force'],
    ['set', 'leaderboard.unknown', 'off', '--actor', 'operator'],
    ['set', 'leaderboard.public', 'false', '--actor', 'operator'],
    ['set', 'leaderboard.public', '--actor', 'operator'],
    ['toggle', 'leaderboard.public'],
  ]) {
    const flags = recordingFlags();
    await assert.rejects(
      runFlagCommand(args, flags, output()),
      FlagCommandError,
      args.join(' '),
    );
    assert.deepEqual(flags.calls, [], args.join(' '));
  }
});

test('set passes the key, the state and the named actor to the flag service', async () => {
  const flags = recordingFlags();
  const printed = output();
  await runFlagCommand(
    ['set', '--actor', 'operator-1', 'leaderboard.public', 'off'],
    flags,
    printed,
  );
  await runFlagCommand(
    ['set', 'signup.enabled', 'on', '--actor', 'operator-2'],
    flags,
    printed,
  );
  assert.deepEqual(flags.calls, [
    { key: 'leaderboard.public', enabled: false, actor: 'operator-1' },
    { key: 'signup.enabled', enabled: true, actor: 'operator-2' },
  ]);
  assert.match(printed.lines[0] ?? '', /leaderboard\.public is now off/u);
  assert.match(printed.lines[0] ?? '', /audited as operator-1/u);
});

test('list prints every flag with its state', async () => {
  const printed = output();
  await runFlagCommand(['list'], recordingFlags(), printed);
  assert.deepEqual(printed.lines, [
    'leaderboard.public on',
    'giveaway.open off',
  ]);
});

test('the CLI entry point sets a flag in the database and audits the actor', async () => {
  const databaseName = `valstara_flagcli_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const applicationUrl = new URL(databaseUrl);
  applicationUrl.username = 'valstara_app';
  applicationUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  const database = createPool(databaseUrl.toString());
  try {
    await runMigrations(database, {
      applicationRolePassword,
      release: 'gate-7-flag-cli-test',
    });
    const environment = {
      ...process.env,
      DATABASE_URL: applicationUrl.toString(),
    };

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        cliPath,
        'set',
        'leaderboard.public',
        'off',
        '--actor',
        'operator-incident',
      ],
      { env: environment },
    );
    assert.match(stdout, /leaderboard\.public is now off/u);

    const flag = await database.readOne<{
      enabled: boolean;
      updated_by: string;
    }>({
      text: `SELECT enabled, updated_by FROM campaign_flag
        WHERE key = 'leaderboard.public'`,
    });
    const audit = await database.readOne<{
      actor: string;
      detail: { enabled: boolean };
      subject_id: string;
    }>({
      text: `SELECT actor, detail, subject_id FROM audit_log
        WHERE action = 'flag.changed'`,
    });
    assert.deepEqual(flag, { enabled: false, updated_by: 'operator-incident' });
    assert.deepEqual(audit, {
      actor: 'operator-incident',
      detail: { enabled: false },
      subject_id: 'leaderboard.public',
    });

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cliPath, 'set', 'signup.enabled', 'off'],
        { env: environment },
      ),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? '', /requires --actor/u);
        return true;
      },
    );
    const changes = await database.readOne<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM audit_log
        WHERE action = 'flag.changed'`,
    });
    assert.equal(changes?.count, '1');

    const listed = await execFileAsync(process.execPath, [cliPath, 'list'], {
      env: environment,
    });
    assert.match(listed.stdout, /^leaderboard\.public off$/mu);
  } finally {
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
  }
});
