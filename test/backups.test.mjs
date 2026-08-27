import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

test(
  'the pgBackRest drill creates encrypted full and differential backups, archives WAL, and restores known rows',
  { timeout: 120_000 },
  async () => {
    const sourceLedger = await composeQuery();
    const { stdout } = await execFileAsync('npm', ['run', 'backup:drill'], {
      env: {
        ...process.env,
        RESTORE_DRILL_KEEP_SCRATCH: '1',
      },
      maxBuffer: 1024 * 1024,
    });

    assert.match(stdout, /pgBackRest local restore drill passed/);
    assert.match(
      stdout,
      /Local restore timing: \d+ ms \(floor only; not the production RTO\)\./,
    );
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
