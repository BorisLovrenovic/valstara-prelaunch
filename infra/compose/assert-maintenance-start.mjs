#!/usr/bin/env node

// Smoke start of the built image's maintenance worker (QA gate 7, G7-1-B1/T3).
// The worker runs from TypeScript source in the runtime image, so a module the
// Dockerfile forgets to copy only shows up when the process starts. This starts
// PostgreSQL, the migration gate and the maintenance service from the
// production Compose file with the given image, then requires the worker to
// stay running, unrestarted, for a settle window and to log no module or
// configuration failure.
//
// Usage: node infra/compose/assert-maintenance-start.mjs <image reference>

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

import { productionTestEnvironment } from './production-test-environment.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = fileURLToPath(
  new URL('./docker-compose.production.yml', import.meta.url),
);
const settleMs = Number(process.env.MAINTENANCE_SMOKE_SETTLE_MS ?? '20000');
const image = process.argv[2];
assert.ok(image, 'usage: assert-maintenance-start.mjs <image reference>');

const project = `valstara-maintenance-smoke-${process.pid}`;
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'valstara-maintenance-smoke-'),
);
const certificate = join(temporaryDirectory, 'origin-cert.pem');
const privateKey = join(temporaryDirectory, 'origin-key.pem');
const environment = {
  ...process.env,
  ...productionTestEnvironment({
    certificate,
    image,
    privateKey,
    seedSecretsDirectory: temporaryDirectory,
  }),
};

async function run(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: projectRoot,
    env: environment,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function compose(args) {
  return run('docker', ['compose', '-p', project, '-f', composeFile, ...args]);
}

async function maintenanceState() {
  const id = await compose(['ps', '--all', '--quiet', 'maintenance']);
  assert.notEqual(id, '', 'the maintenance service has no container');
  const [inspection] = JSON.parse(await run('docker', ['inspect', id]));
  return {
    restarts: inspection.RestartCount,
    running: inspection.State.Running,
    status: inspection.State.Status,
  };
}

let logs = '';
try {
  // Compose validates the top-level secrets even for services it does not
  // start; Caddy is not part of this smoke.
  await writeFile(certificate, '');
  await writeFile(privateKey, '');
  await compose([
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '180',
    'postgres',
    'migrate',
    'maintenance',
  ]);
  await sleep(settleMs);
  const state = await maintenanceState();
  logs = await compose(['logs', '--no-color', 'maintenance']);
  assert.doesNotMatch(logs, /ERR_MODULE_NOT_FOUND|Cannot find module/u);
  assert.doesNotMatch(logs, /Invalid configuration:/u);
  assert.equal(state.status, 'running', 'the maintenance worker exited');
  assert.equal(state.running, true, 'the maintenance worker is not running');
  assert.equal(state.restarts, 0, 'the maintenance worker restarted');
  process.stdout.write(
    `The maintenance worker in ${image} started and stayed up for ${settleMs} ms.\n`,
  );
} catch (error) {
  if (logs === '')
    logs = await compose(['logs', '--no-color', 'maintenance']).catch(() => '');
  process.stderr.write(`${logs}\n`);
  throw error;
} finally {
  await compose(['down', '--volumes', '--remove-orphans']).catch(() => {});
  await rm(temporaryDirectory, { force: true, recursive: true });
}
