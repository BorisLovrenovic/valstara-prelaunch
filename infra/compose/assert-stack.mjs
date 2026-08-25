#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const composeFile = fileURLToPath(
  new URL('./docker-compose.yml', import.meta.url),
);
const expectedServices = ['app', 'postgres', 'umami'];

async function run(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024,
  });

  return stdout.trim();
}

async function compose(args) {
  return run('docker', ['compose', '-f', composeFile, ...args]);
}

async function inspectService(service) {
  const containerId = await compose(['ps', '--quiet', service]);
  assert.notEqual(
    containerId,
    '',
    `${service} does not have a running container`,
  );

  const inspection = JSON.parse(await run('docker', ['inspect', containerId]));
  assert.equal(inspection.length, 1, `${service} inspection was not unique`);

  return inspection[0];
}

async function assertRunningServiceSet() {
  const serviceOutput = await run('docker', [
    'ps',
    '--filter',
    'label=com.docker.compose.project=valstara-prelaunch',
    '--format',
    '{{.Label "com.docker.compose.service"}}',
  ]);
  const runningServices = serviceOutput.split('\n').filter(Boolean).sort();

  assert.deepEqual(runningServices, expectedServices);
}

function environmentOf(inspection) {
  return Object.fromEntries(
    inspection.Config.Env.map((entry) => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

function assertMemoryLimit(service, inspection) {
  const memory = inspection.HostConfig.Memory;
  const memorySwap = inspection.HostConfig.MemorySwap;

  assert.ok(memory > 0, `${service} has no hard memory limit`);
  assert.equal(
    memorySwap,
    memory,
    `${service} swap limit must equal its memory limit`,
  );
}

function assertHealthy(service, inspection) {
  assert.equal(inspection.State.Running, true, `${service} is not running`);
  assert.equal(
    inspection.State.Health?.Status,
    'healthy',
    `${service} is not healthy`,
  );
}

/**
 * Authenticate with a service's OWN runtime connection string and report the
 * database the credentials actually reach.
 *
 * The connection string is passed through the environment rather than argv so
 * the password never appears in the container's process list. `psql` is run
 * inside the postgres container because it is the only image in the stack that
 * ships a client; the URL is used verbatim, so its host, role, password and
 * database are all exercised exactly as the owning service holds them.
 */
async function currentDatabaseFor(connectionUrl) {
  return compose([
    'exec',
    '-T',
    '-e',
    `PROBE_DATABASE_URL=${connectionUrl}`,
    'postgres',
    'sh',
    '-c',
    'psql "$PROBE_DATABASE_URL" --tuples-only --no-align --command "SELECT current_database()"',
  ]);
}

/**
 * Green path: the service's real credentials reach the database it claims.
 */
async function assertDatabaseConnection({ service, connectionUrl, database }) {
  const currentDatabase = await currentDatabaseFor(connectionUrl);

  assert.equal(
    currentDatabase,
    database,
    `${service} credentials did not authenticate against ${database}`,
  );
}

/**
 * Red path: the same probe must FAIL on a wrong password.
 *
 * Without this the green path proves nothing — a probe that only opens a TCP
 * socket passes with any credentials at all, which is precisely the defect this
 * assertion replaces.
 */
async function assertInvalidCredentialsRejected(connectionUrl) {
  const tampered = new URL(connectionUrl);
  tampered.password = 'definitely-wrong-password';

  await assert.rejects(
    () => currentDatabaseFor(tampered.toString()),
    'the probe accepted an invalid password, so it cannot prove authentication',
  );
}

async function assertPostgresVersion() {
  const versionNumber = await compose([
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    'PGPASSWORD="$POSTGRES_PASSWORD" psql --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SHOW server_version_num"',
  ]);

  assert.equal(
    Math.floor(Number(versionNumber) / 10_000),
    17,
    'the running database must be PostgreSQL 17',
  );
}

export async function assertStack() {
  await assertRunningServiceSet();

  const inspections = new Map(
    await Promise.all(
      expectedServices.map(async (service) => [
        service,
        await inspectService(service),
      ]),
    ),
  );

  for (const [service, inspection] of inspections) {
    assertHealthy(service, inspection);
    assertMemoryLimit(service, inspection);
  }

  const appEnvironment = environmentOf(inspections.get('app'));
  const umamiEnvironment = environmentOf(inspections.get('umami'));
  assert.equal(
    appEnvironment.MIGRATION_DATABASE_URL,
    undefined,
    'the long-running app must not receive the migration-owner credential',
  );
  assert.equal(
    new URL(appEnvironment.DATABASE_URL).username,
    'valstara_app',
    'the long-running app must use the restricted database role',
  );
  const appDatabase = new URL(appEnvironment.DATABASE_URL).pathname.slice(1);
  const umamiDatabase = new URL(umamiEnvironment.DATABASE_URL).pathname.slice(
    1,
  );

  assert.equal(appDatabase, 'valstara_waitlist');
  assert.equal(umamiDatabase, 'umami');
  assert.notEqual(
    appDatabase,
    umamiDatabase,
    'Umami must use its own database',
  );

  await Promise.all([
    assertDatabaseConnection({
      service: 'app',
      connectionUrl: appEnvironment.DATABASE_URL,
      database: appDatabase,
    }),
    assertDatabaseConnection({
      service: 'umami',
      connectionUrl: umamiEnvironment.DATABASE_URL,
      database: umamiDatabase,
    }),
    assertInvalidCredentialsRejected(appEnvironment.DATABASE_URL),
    assertPostgresVersion(),
  ]);

  const [appResponse, umamiResponse] = await Promise.all([
    globalThis.fetch('http://127.0.0.1:4321/'),
    globalThis.fetch('http://127.0.0.1:3000/api/heartbeat'),
  ]);

  assert.equal(
    appResponse.ok,
    true,
    'the app is not reachable on localhost:4321',
  );
  assert.equal(
    umamiResponse.ok,
    true,
    'Umami is not reachable on localhost:3000',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await assertStack();
  process.stdout.write('Local Compose stack assertions passed.\n');
}
