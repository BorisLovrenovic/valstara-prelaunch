import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
const deployUrl = new URL('../infra/deploy/deploy.sh', import.meta.url);
const rollbackUrl = new URL('../infra/deploy/rollback.sh', import.meta.url);
const oldImage =
  'ghcr.io/example/valstara-prelaunch:1111111111111111111111111111111111111111';
const newImage =
  'ghcr.io/example/valstara-prelaunch:2222222222222222222222222222222222222222';

async function run(command, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, options);
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stderr, stdout });
    });
  });
}

async function createFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'valstara-e107-'));
  const auditFile = join(directory, 'audit', 'deploy-audit.jsonl');
  const commandLog = join(directory, 'docker.log');
  const dockerPath = join(directory, 'docker');
  const statePath = join(directory, 'state');
  const composeFile = join(directory, 'compose.yml');
  const currentImage = options.currentImage ?? oldImage;

  await writeFile(composeFile, 'services: {}\n');
  await writeFile(statePath, currentImage);
  await writeFile(
    dockerPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
state=$(cat "$FAKE_DOCKER_STATE")
case "$*" in
  *'compose '*" ps -q app") printf '%s\\n' app-container ;;
  *'inspect --format {{.Config.Image}}'*) printf '%s\\n' "$state" ;;
  *'inspect --format {{.State.Health.Status}}'*candidate*) printf '%s\\n' "${options.candidateHealth ?? 'healthy'}" ;;
  *'inspect --format {{.State.Health.Status}}'*) printf '%s\\n' "${options.restartHealth ?? 'healthy'}" ;;
  *'compose '*" run --rm migrate"*)
    if [ "${options.migrationFails ? '1' : '0'}" = 1 ]; then exit 1; fi
    printf '%s\\n' 'Applied migrations: 0004-deployment-audit.sql'
    ;;
  *'compose '*" exec -T postgres psql"*) printf '%s\\n' '["0004-deployment-audit.sql"]' ;;
  *'compose '*" up -d --no-deps --force-recreate app"*)
    image=$(printf '%s' "$VALSTARA_IMAGE")
    printf '%s\\n' "$image" > "$FAKE_DOCKER_STATE"
    ;;
esac
`,
  );
  await run('chmod', ['+x', dockerPath]);

  const environment = {
    ...process.env,
    DEPLOY_AUDIT_FILE: auditFile,
    DEPLOY_COMPOSE_FILE: composeFile,
    DEPLOY_HEALTH_POLL_SECONDS: '1',
    DEPLOY_HEALTH_TIMEOUT_SECONDS: '1',
    FAKE_DOCKER_LOG: commandLog,
    FAKE_DOCKER_STATE: statePath,
    PATH: `${directory}:${process.env.PATH}`,
    VALSTARA_DB_USER: 'valstara',
  };

  return {
    auditFile,
    commandLog,
    directory,
    environment,
    async dispose() {
      await rm(directory, { force: true, recursive: true });
    },
  };
}

test('a staged bad image fails its candidate health gate while the previous release remains serving and is audited', async () => {
  const fixture = await createFixture({ candidateHealth: 'unhealthy' });

  try {
    const result = await run('sh', [deployUrl.pathname, newImage], {
      env: fixture.environment,
    });
    const commands = await readFile(fixture.commandLog, 'utf8');
    const records = await readFile(fixture.auditFile, 'utf8');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /previous app remains serving/);
    assert.doesNotMatch(commands, /up -d --no-deps --force-recreate app/);
    assert.match(
      records,
      /"image":"ghcr.io\/example\/valstara-prelaunch:2222222222222222222222222222222222222222"/,
    );
    assert.match(records, /"migrations":\["0004-deployment-audit.sql"\]/);
    assert.match(records, /"outcome":"candidate_health_failed"/);
  } finally {
    await fixture.dispose();
  }
});

test('a checksum mismatch aborts before a candidate or restart and persists the failed attempt', async () => {
  const fixture = await createFixture({ migrationFails: true });

  try {
    const result = await run('sh', [deployUrl.pathname, newImage], {
      env: fixture.environment,
    });
    const commands = await readFile(fixture.commandLog, 'utf8');
    const records = await readFile(fixture.auditFile, 'utf8');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Migration failed/);
    assert.doesNotMatch(commands, /run -d --no-deps --name/);
    assert.doesNotMatch(commands, /up -d --no-deps --force-recreate app/);
    assert.match(records, /"migrations":\["0004-deployment-audit.sql"\]/);
    assert.match(records, /"outcome":"migration_failed"/);
  } finally {
    await fixture.dispose();
  }
});

test('one rollback command redeploys the previous audited release and records its outcome', async () => {
  const fixture = await createFixture({ currentImage: newImage });

  try {
    await mkdir(join(fixture.directory, 'audit'));
    await writeFile(
      fixture.auditFile,
      `{"image":"${oldImage}","outcome":"succeeded"}\n{"image":"${newImage}","outcome":"succeeded"}\n`,
    );
    const result = await run('sh', [rollbackUrl.pathname], {
      env: fixture.environment,
    });
    const commands = await readFile(fixture.commandLog, 'utf8');
    const records = await readFile(fixture.auditFile, 'utf8');

    assert.equal(result.code, 0);
    assert.match(commands, /release=1111111111111111111111111111111111111111/);
    assert.match(
      records,
      /"image":"ghcr.io\/example\/valstara-prelaunch:1111111111111111111111111111111111111111"/,
    );
    assert.match(records, /"outcome":"rollback_succeeded"/);
  } finally {
    await fixture.dispose();
  }
});
