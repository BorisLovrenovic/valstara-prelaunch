import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// E11.6-02: `npm run check` fails on an invalid price-index config file. The
// red path plants a catalogue with a duplicate service in a copy of the
// project's manifest, configuration and tool, and runs the real
// `npm run check` there.

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function run(cwd, command, args) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: environment });
}

async function projectCopy() {
  const root = await mkdtemp(join(tmpdir(), 'valstara-price-index-check-'));
  for (const path of ['package.json', 'config', 'packages/price-index/src']) {
    await cp(join(projectRoot, path), join(root, path), { recursive: true });
  }
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));
  return root;
}

test('npm run check runs price-index validate before any other check', async () => {
  const { scripts } = JSON.parse(
    await readFile(join(projectRoot, 'package.json'), 'utf8'),
  );
  assert.equal(
    scripts['price-index'],
    'tsx packages/price-index/src/cli/main.ts',
  );
  assert.match(scripts.check, /^npm run price-index -- validate && /);
});

test('npm run price-index -- validate passes on the committed configuration', () => {
  const result = run(projectRoot, 'npm', [
    'run',
    'price-index',
    '--',
    'validate',
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /configuration is valid/);
});

test('npm run check fails on a planted invalid config file', async () => {
  const root = await projectCopy();
  try {
    const path = join(root, 'config', 'catalogue.json');
    const catalogue = JSON.parse(await readFile(path, 'utf8'));
    catalogue.services.push(catalogue.services[0]);
    await writeFile(path, `${JSON.stringify(catalogue, null, 2)}\n`);

    const result = run(root, 'npm', ['run', 'check']);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    assert.match(
      output,
      /config\/catalogue\.json \(services\): duplicate service_id adobe-creative-cloud/,
    );
    // It stopped at validate: the lint step never started.
    assert.doesNotMatch(output, /> eslint \./);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
