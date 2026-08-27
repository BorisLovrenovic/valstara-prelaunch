import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test(
  'the pgBackRest drill creates encrypted full and differential backups, archives WAL, and restores known rows',
  { timeout: 120_000 },
  async () => {
    assert.ok(
      process.env.PGBACKREST_REPO1_CIPHER_PASS,
      'PGBACKREST_REPO1_CIPHER_PASS must be supplied by the test environment',
    );

    const { stdout } = await execFileAsync('npm', ['run', 'backup:drill'], {
      env: process.env,
      maxBuffer: 1024 * 1024,
    });

    assert.match(stdout, /pgBackRest local restore drill passed/);
    assert.match(stdout, /Local restore timing floor: \d+ ms/);
    assert.match(stdout, /not a production RTO/);
  },
);
