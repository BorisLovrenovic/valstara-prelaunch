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

async function assertDatabaseConnection({ database, role }) {
  const currentDatabase = await compose([
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    `PGPASSWORD="$${role === 'valstara' ? 'POSTGRES_PASSWORD' : 'UMAMI_DB_PASSWORD'}" psql --host 127.0.0.1 --username "$${role === 'valstara' ? 'POSTGRES_USER' : 'UMAMI_DB_USER'}" --dbname "$${role === 'valstara' ? 'POSTGRES_DB' : 'UMAMI_DB_NAME'}" --tuples-only --no-align --command 'SELECT current_database()'`,
  ]);

  assert.equal(
    currentDatabase,
    database,
    `${role} role targets the wrong database`,
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
    assertDatabaseConnection({ database: appDatabase, role: 'valstara' }),
    assertDatabaseConnection({ database: umamiDatabase, role: 'umami' }),
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
