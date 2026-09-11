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
      maxBuffer: 1024 * 1024,
    });

    assert.match(stdout, /pgBackRest local restore drill passed/);
    assert.match(
      stdout,
      /Local restore timing: \d+ ms \(floor only; not the production RTO\)\./,
    );
    assert.ok(sourceLedger.length > 0);
    const { stdout: containers } = await execFileAsync('docker', [
      'ps',
      '--all',
      '--quiet',
      '--filter',
      'name=^valstara-backup-restore-',
    ]);
    const { stdout: volumes } = await execFileAsync('docker', [
      'volume',
      'ls',
      '--quiet',
      '--filter',
      'label=valstara.backup-restore-scratch=true',
    ]);
    assert.equal(containers.trim(), '', 'the drill left a scratch container');
    assert.equal(volumes.trim(), '', 'the drill left a scratch volume');
  },
);
