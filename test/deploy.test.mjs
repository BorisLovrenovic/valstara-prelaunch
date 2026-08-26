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
const migrationModuleUrl = new URL(
  '../src/server/db/migration.ts',
  import.meta.url,
).href;
const fiveMinutesInNanoseconds = 5n * 60n * 1_000_000_000n;
const checksumMismatchProgram = `
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMigrations } from '${migrationModuleUrl}';

const directory = await mkdtemp(join(tmpdir(), 'valstara-checksum-mismatch-'));
const filename = '0001-checksum.sql';

try {
  const appliedSql = 'SELECT 1;\\n';
  const appliedChecksum = createHash('sha256').update(appliedSql).digest('hex');
  await writeFile(join(directory, filename), appliedSql);
  await writeFile(join(directory, filename), 'SELECT 2;\\n');

  const connection = {
    async execute() {},
    async list() {
      return [{ filename }];
    },
    async readOne(query) {
      if (query.text.includes('SELECT checksum FROM migration_ledger')) {
        return { checksum: appliedChecksum };
      }
      return undefined;
    },
    release() {},
  };
  const database = {
    async connect() {
      return connection;
    },
  };

  await runMigrations(database, {
    applicationRolePassword: 'test-password',
    directory,
    release: '2222222222222222222222222222222222222222',
  });
  process.exitCode = 1;
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exitCode = 1;
} finally {
  await rm(directory, { force: true, recursive: true });
}
`;

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
  const checksumMismatchPath = join(directory, 'checksum-mismatch.mjs');
  const currentImage = options.currentImage ?? oldImage;

  await writeFile(composeFile, 'services: {}\n');
  await writeFile(statePath, currentImage);
  await writeFile(checksumMismatchPath, checksumMismatchProgram);
  await writeFile(
    dockerPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
state=$(cat "$FAKE_DOCKER_STATE")
case "$*" in
  *'compose '*" ps -q app")
    if [ "${options.noServingContainer ? '1' : '0'}" = 0 ]; then
      printf '%s\\n' app-container
    fi
    ;;
  *'inspect --format {{.Config.Image}}'*) printf '%s\\n' "$state" ;;
  *'inspect --format {{.State.Health.Status}}'*candidate*) printf '%s\\n' "${options.candidateHealth ?? 'healthy'}" ;;
  *'inspect --format {{.State.Health.Status}}'*) printf '%s\\n' "${options.currentHealth ?? options.restartHealth ?? 'healthy'}" ;;
  *'compose '*" pull app migrate"*)
    if [ "${options.pullFails ? '1' : '0'}" = 1 ]; then exit 1; fi
    ;;
  *'compose '*" run --rm migrate"*)
    if [ "${options.checksumMismatch ? '1' : '0'}" = 1 ]; then
      node --import tsx "$FAKE_CHECKSUM_MISMATCH_FIXTURE"
      exit $?
    fi
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
    FAKE_CHECKSUM_MISMATCH_FIXTURE: checksumMismatchPath,
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

test('an induced applied-migration checksum mismatch aborts before a candidate or restart and persists the failed attempt', async () => {
  const fixture = await createFixture({ checksumMismatch: true });

  try {
    const result = await run('sh', [deployUrl.pathname, newImage], {
      env: fixture.environment,
    });
    const commands = await readFile(fixture.commandLog, 'utf8');
    const records = await readFile(fixture.auditFile, 'utf8');

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /Applied migration checksum does not match: 0001-checksum.sql/,
    );
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
    const startedAt = process.hrtime.bigint();
    const result = await run('sh', [rollbackUrl.pathname], {
      env: fixture.environment,
    });
    const elapsed = process.hrtime.bigint() - startedAt;
    const commands = await readFile(fixture.commandLog, 'utf8');
    const records = await readFile(fixture.auditFile, 'utf8');

    assert.equal(result.code, 0);
    assert.ok(
      elapsed < fiveMinutesInNanoseconds,
      `Rollback drill exceeded the five-minute bound: ${elapsed}ns`,
    );
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

test('a missing serving container is recorded before deployment aborts', async () => {
  const fixture = await createFixture({ noServingContainer: true });

  try {
    const result = await run('sh', [deployUrl.pathname, newImage], {
      env: fixture.environment,
    });
    const records = await readFile(fixture.auditFile, 'utf8');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /No currently serving app container/);
    assert.match(records, /"migrations":\[\]/);
    assert.match(records, /"outcome":"no_serving_container"/);
  } finally {
    await fixture.dispose();
  }
});

test('an unhealthy current app is recorded before deployment aborts', async () => {
  const fixture = await createFixture({ currentHealth: 'unhealthy' });

  try {
    const result = await run('sh', [deployUrl.pathname, newImage], {
      env: fixture.environment,
    });
    const commands = await readFile(fixture.commandLog, 'utf8');
    const records = await readFile(fixture.auditFile, 'utf8');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /current app is not healthy/);
    assert.doesNotMatch(commands, /pull app migrate/);
    assert.match(records, /"migrations":\[\]/);
    assert.match(records, /"outcome":"current_health_failed"/);
  } finally {
    await fixture.dispose();
  }
});

test('an image pull failure is recorded before deployment aborts', async () => {
  const fixture = await createFixture({ pullFails: true });

  try {
    const result = await run('sh', [deployUrl.pathname, newImage], {
      env: fixture.environment,
    });
    const commands = await readFile(fixture.commandLog, 'utf8');
    const records = await readFile(fixture.auditFile, 'utf8');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Image pull failed/);
    assert.doesNotMatch(commands, /run --rm migrate/);
    assert.match(records, /"migrations":\[\]/);
    assert.match(records, /"outcome":"image_pull_failed"/);
  } finally {
    await fixture.dispose();
  }
});
