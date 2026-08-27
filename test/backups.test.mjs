import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function composeQuery() {
  const { stdout } = await execFileAsync('docker', [
    'compose',
    '-f',
    'infra/compose/docker-compose.yml',
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --field-separator "|" --command "SELECT filename, checksum FROM migration_ledger ORDER BY filename"',
  ]);
  return stdout.trim();
}

async function runScheduledBackup({ day, stateDirectory }) {
  const executableDirectory = await mkdtemp(
    join(tmpdir(), 'valstara-backup-bin-'),
  );
  const callsPath = join(executableDirectory, 'calls');
  const datePath = join(executableDirectory, 'date');
  const runuserPath = join(executableDirectory, 'runuser');
  const schedulePath = 'infra/backups/pgbackrest-schedule.sh';

  await writeFile(
    datePath,
    `#!/bin/sh\ncase "\${2:-$1}" in\n  '+%F') printf '%s\\n' '2026-08-30' ;;\n  '+%H') printf '%s\\n' '02' ;;\n  '+%u') printf '%s\\n' '${day}' ;;\nesac\n`,
  );
  await writeFile(
    runuserPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>'${callsPath}'\n`,
  );
  await chmod(datePath, 0o755);
  await chmod(runuserPath, 0o755);

  try {
    await execFileAsync('sh', [schedulePath], {
      env: {
        ...process.env,
        PATH: `${executableDirectory}:${process.env.PATH}`,
        PGBACKREST_SCHEDULE_ONCE: 'true',
        PGBACKREST_SCHEDULE_STATE_FILE: join(stateDirectory, 'last-backup'),
      },
    });
    return readFile(callsPath, 'utf8').catch(() => '');
  } finally {
    await rm(executableDirectory, { force: true, recursive: true });
  }
}

test('the production scheduler runs weekly full and daily differential backups once per UTC date', async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), 'valstara-backup-state-'),
  );

  try {
    const sundayCall = await runScheduledBackup({ day: 7, stateDirectory });
    assert.match(sundayCall, /stanza-create/);
    assert.match(sundayCall, /--type=full/);

    const duplicateSundayCall = await runScheduledBackup({
      day: 7,
      stateDirectory,
    });
    assert.equal(duplicateSundayCall, '');

    await rm(join(stateDirectory, 'last-backup'));
    const mondayCall = await runScheduledBackup({ day: 1, stateDirectory });
    assert.match(mondayCall, /--type=diff/);
  } finally {
    await rm(stateDirectory, { force: true, recursive: true });
  }
});

test(
  'the pgBackRest drill creates encrypted full and differential backups, archives WAL, and restores known rows',
  { timeout: 120_000 },
  async () => {
    assert.ok(
      process.env.PGBACKREST_REPO1_CIPHER_PASS,
      'PGBACKREST_REPO1_CIPHER_PASS must be supplied by the test environment',
    );

    const sourceLedger = await composeQuery();
    const { stdout } = await execFileAsync('npm', ['run', 'backup:drill'], {
      env: {
        ...process.env,
        RESTORE_DRILL_KEEP_SCRATCH: '1',
      },
      maxBuffer: 1024 * 1024,
    });

    assert.match(stdout, /pgBackRest local restore drill passed/);
    assert.match(stdout, /Local restore timing: \d+ ms/);
    const container = stdout.match(/Scratch restore container: (\S+)/)?.[1];
    const volume = stdout.match(/Scratch restore volume: (\S+)/)?.[1];
    const databaseUser = stdout.match(/Restored database user: (\S+)/)?.[1];
    assert.ok(
      container,
      'the drill did not expose its scratch restore container',
    );
    assert.ok(volume, 'the drill did not expose its scratch restore volume');
    assert.ok(
      databaseUser,
      'the drill did not expose its restored database user',
    );

    try {
      const { stdout: restoredLedger } = await execFileAsync('docker', [
        'exec',
        container,
        'psql',
        '--username',
        databaseUser,
        '--dbname',
        'valstara_waitlist',
        '--tuples-only',
        '--no-align',
        '--field-separator',
        '|',
        '--command',
        'SELECT filename, checksum FROM migration_ledger ORDER BY filename',
      ]);
      assert.equal(restoredLedger.trim(), sourceLedger);
    } finally {
      await execFileAsync('docker', ['rm', '--force', container]).catch(
        () => {},
      );
      await execFileAsync('docker', ['volume', 'rm', volume]).catch(() => {});
    }
  },
);
