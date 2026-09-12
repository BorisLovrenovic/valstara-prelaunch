import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
const deployUrl = new URL('../infra/deploy/deploy.sh', import.meta.url);
const rollbackUrl = new URL('../infra/deploy/rollback.sh', import.meta.url);
const productionComposeUrl = new URL(
  '../infra/compose/docker-compose.production.yml',
  import.meta.url,
);
const oldImage =
  'ghcr.io/example/valstara-prelaunch:1111111111111111111111111111111111111111';
const newImage =
  'ghcr.io/example/valstara-prelaunch:2222222222222222222222222222222222222222';
const migrationModuleUrl = new URL(
  '../src/server/db/migration.ts',
  import.meta.url,
).href;
const drillCommandTimeoutMs = 45_000;
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

async function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const { timeoutMs = drillCommandTimeoutMs, ...spawnOptions } = options;
    const child = spawn(command, arguments_, spawnOptions);
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    let killTimer;
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
          }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (process.env.VALSTARA_E107_DRILL_DIAGNOSTICS === '1') {
        process.stderr.write(
          `[E1-07 drill] ${command} ${arguments_.join(' ')} completed in ${Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000)}ms\n`,
        );
      }
      resolve({ code, stderr, stdout, timedOut });
    });
  });
}

async function runChecked(command, arguments_, options) {
  const result = await run(command, arguments_, {
    ...options,
    timeoutMs: options?.timeoutMs ?? drillCommandTimeoutMs,
  });
  assert.equal(
    result.timedOut,
    false,
    `${command} ${arguments_.join(' ')} timed out after ${options?.timeoutMs ?? drillCommandTimeoutMs}ms:\n${result.stderr}${result.stdout}`,
  );
  assert.equal(
    result.code,
    0,
    `${command} ${arguments_.join(' ')} failed:\n${result.stderr}${result.stdout}`,
  );
  return result;
}

async function reserveLoopbackPort() {
  const net = await import('node:net');
  const server = net.createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function compose(project, environment, arguments_) {
  const result = await run(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      productionComposeUrl.pathname,
      ...arguments_,
    ],
    { env: environment, timeoutMs: drillCommandTimeoutMs },
  );
  if (result.code !== 0 || result.timedOut) {
    const logs = await run(
      'docker',
      [
        'compose',
        '-p',
        project,
        '-f',
        productionComposeUrl.pathname,
        'logs',
        'migrate',
      ],
      { env: environment },
    );
    assert.fail(
      `docker compose ${arguments_.join(' ')} ${result.timedOut ? `timed out after ${drillCommandTimeoutMs}ms` : 'failed'}:\n${result.stderr}${result.stdout}\n${logs.stderr}${logs.stdout}`,
    );
  }
  return result;
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

test(
  'the local production-Compose drill pulls, migrates, health-gates, and restores without measuring an RTO',
  {},
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'valstara-e107-drill-'));
    const certificate = join(directory, 'origin-cert.pem');
    const privateKey = join(directory, 'origin-key.pem');
    const auditFile = join(directory, 'audit', 'deploy-audit.jsonl');
    const migrationPath = join(directory, '0012-local-deployment-drill.sql');
    const initialDockerfile = join(directory, 'Dockerfile.initial');
    const deployedDockerfile = join(directory, 'Dockerfile.deployed');
    const unhealthyDockerfile = join(directory, 'Dockerfile.unhealthy');
    const suffix = `${process.pid}-${Date.now()}`;
    const project = `valstara-e107-drill-${suffix}`;
    const registry = `valstara-e107-registry-${suffix}`;
    const registryPort = await reserveLoopbackPort();
    const repository = `localhost:${registryPort}/valstara-e107-drill-${suffix}`;
    const initialRelease = '1111111111111111111111111111111111111111';
    const deployedRelease = '2222222222222222222222222222222222222222';
    const unhealthyRelease = '3333333333333333333333333333333333333333';
    const sourceImage = `${repository}:source`;
    const initialImage = `${repository}:${initialRelease}`;
    const deployedImage = `${repository}:${deployedRelease}`;
    const unhealthyImage = `${repository}:${unhealthyRelease}`;
    const environment = {
      ...process.env,
      CADDY_ORIGIN_CERT_PATH: certificate,
      CADDY_ORIGIN_KEY_PATH: privateKey,
      COMPOSE_PROJECT_NAME: project,
      DEPLOY_AUDIT_FILE: auditFile,
      DEPLOY_COMPOSE_FILE: productionComposeUrl.pathname,
      DEPLOY_HEALTH_POLL_SECONDS: '1',
      DEPLOY_HEALTH_TIMEOUT_SECONDS: '10',
      P1_ALERT_WEBHOOK_TOKEN: 'local-production-drill-alert-token',
      P1_ALERT_WEBHOOK_URL: 'https://alerts.example.test/valstara',
      REFERRAL_SIGNING_SECRET: 'local-production-drill-referral-secret',
      SITE_HOST: 'valstara.com',
      UMAMI_APP_SECRET: 'local-production-drill-umami-secret',
      UMAMI_DB_PASSWORD: 'local-production-drill-umami-password',
      UMAMI_DB_USER: 'umami',
      VALSTARA_APP_DB_PASSWORD: 'local-production-drill-app-password',
      VALSTARA_DB_PASSWORD: 'local-production-drill-owner-password',
      VALSTARA_DB_USER: 'valstara',
      VALSTARA_IMAGE: initialImage,
      VALSTARA_RELEASE: initialRelease,
    };

    try {
      await runChecked('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        privateKey,
        '-out',
        certificate,
        '-days',
        '1',
        '-subj',
        '/CN=valstara.com',
        '-addext',
        'subjectAltName=DNS:valstara.com',
      ]);
      await runChecked('docker', [
        'run',
        '--detach',
        '--rm',
        '--name',
        registry,
        '--publish',
        `127.0.0.1:${registryPort}:5000`,
        'registry:2',
      ]);
      await writeFile(
        migrationPath,
        'CREATE TABLE local_deployment_drill_marker (id integer PRIMARY KEY);\n',
      );
      await writeFile(
        initialDockerfile,
        `FROM ${sourceImage}\nHEALTHCHECK --interval=1s --timeout=1s --start-period=0s --retries=2 CMD ["node", "-e", "fetch('http://127.0.0.1:4321/').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]\n`,
      );
      await writeFile(
        deployedDockerfile,
        `FROM ${initialImage}\nUSER root\nCOPY --chown=node:node 0012-local-deployment-drill.sql /app/src/server/db/migrations/0012-local-deployment-drill.sql\nUSER node\n`,
      );
      await runChecked('docker', ['build', '--tag', sourceImage, '.']);
      await runChecked('docker', [
        'build',
        '--file',
        initialDockerfile,
        '--tag',
        initialImage,
        directory,
      ]);
      await runChecked('docker', [
        'build',
        '--tag',
        deployedImage,
        '--file',
        deployedDockerfile,
        directory,
      ]);
      await writeFile(
        unhealthyDockerfile,
        `FROM ${deployedImage}\nHEALTHCHECK --interval=1s --timeout=1s --start-period=0s --retries=1 CMD ["sh", "-c", "exit 1"]\n`,
      );
      await runChecked('docker', [
        'build',
        '--file',
        unhealthyDockerfile,
        '--tag',
        unhealthyImage,
        directory,
      ]);

      for (const image of [initialImage, deployedImage, unhealthyImage]) {
        await runChecked('docker', ['push', image]);
      }
      await runChecked('docker', [
        'image',
        'rm',
        sourceImage,
        unhealthyImage,
        deployedImage,
        initialImage,
      ]);

      await compose(project, environment, [
        'up',
        '--detach',
        '--wait',
        'postgres',
        'migrate',
        'app',
      ]);
      await runChecked('sh', [deployUrl.pathname, initialImage], {
        env: environment,
      });

      const absentBeforePull = await run('docker', [
        'image',
        'inspect',
        deployedImage,
      ]);
      assert.notEqual(
        absentBeforePull.code,
        0,
        'candidate image was already local',
      );
      await runChecked('sh', [deployUrl.pathname, deployedImage], {
        env: environment,
      });
      await runChecked('docker', ['image', 'inspect', deployedImage]);

      const migrations = await compose(project, environment, [
        'exec',
        '--no-TTY',
        'postgres',
        'psql',
        '-X',
        '-q',
        '-A',
        '-t',
        '-U',
        'valstara',
        '-d',
        'valstara_waitlist',
        '-c',
        "SELECT filename FROM migration_ledger WHERE applied_by_release = '2222222222222222222222222222222222222222';",
      ]);
      assert.equal(migrations.stdout.trim(), '0012-local-deployment-drill.sql');

      const failedCandidate = await run(
        'sh',
        [deployUrl.pathname, unhealthyImage],
        {
          env: environment,
        },
      );
      assert.equal(failedCandidate.code, 1);
      assert.match(failedCandidate.stderr, /previous app remains serving/);
      const servingCandidate = await compose(project, environment, [
        'ps',
        '--quiet',
        'app',
      ]);
      const servingImage = await runChecked('docker', [
        'inspect',
        '--format',
        '{{.Config.Image}}',
        servingCandidate.stdout.trim(),
      ]);
      assert.equal(servingImage.stdout.trim(), deployedImage);

      await runChecked('sh', [rollbackUrl.pathname], { env: environment });
      const restoredContainer = await compose(project, environment, [
        'ps',
        '--quiet',
        'app',
      ]);
      const restoredImage = await runChecked('docker', [
        'inspect',
        '--format',
        '{{.Config.Image}}',
        restoredContainer.stdout.trim(),
      ]);
      assert.equal(restoredImage.stdout.trim(), initialImage);

      const records = (await readFile(auditFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.ok(
        records.some(
          (record) =>
            record.image === deployedImage &&
            record.outcome === 'succeeded' &&
            record.migrations.includes('0012-local-deployment-drill.sql'),
        ),
      );
      assert.ok(
        records.some(
          (record) =>
            record.image === unhealthyImage &&
            record.outcome === 'candidate_health_failed',
        ),
      );
      assert.equal(records.at(-1).outcome, 'rollback_succeeded');
    } finally {
      await run(
        'docker',
        [
          'compose',
          '-p',
          project,
          '-f',
          productionComposeUrl.pathname,
          'down',
          '--volumes',
          '--remove-orphans',
        ],
        { env: environment },
      );
      await run('docker', ['rm', '--force', registry]);
      await run('docker', [
        'image',
        'rm',
        '--force',
        sourceImage,
        unhealthyImage,
        deployedImage,
        initialImage,
      ]);
      await rm(directory, { force: true, recursive: true });
    }
  },
);

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
