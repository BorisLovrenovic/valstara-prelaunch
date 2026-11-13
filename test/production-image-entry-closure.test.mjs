import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// QA gate 7 (G7-1-B1): the runtime image runs some services straight from
// TypeScript source under native Node (`node ./src/...ts`), so every module
// those entry points load must be copied into the runtime stage. Before this
// test, nothing compared the Dockerfile's COPY list with what the entry points
// import, and the maintenance worker could not start from the image.

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dockerfileUrl = new URL('../Dockerfile', import.meta.url);
const composeUrl = new URL(
  '../infra/compose/docker-compose.production.yml',
  import.meta.url,
);
// Operator commands the runbook runs inside the production image (G7-1-I5).
const runbookUrl = new URL('../docs/ops/runbook.md', import.meta.url);

// Statements that load a module at runtime. `import type` and `export type`
// are erased by native type stripping; `import { type X } from` still loads.
const loadPatterns = [
  /\bimport\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gu,
  /\bexport\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /\bimport\s+['"]([^'"]+)['"]/gu,
];

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gu, '$1');
}

/** Source paths the Dockerfile's final (runtime) stage copies from the build. */
export function runtimeCopies(dockerfile) {
  const stages = dockerfile.split(/^FROM\s/mu);
  const runtime = stages.at(-1) ?? '';
  const copies = [];
  for (const match of runtime.matchAll(
    /^COPY\s+(?:--\S+\s+)*\/app\/(\S+)\s+\S+\s*$/gmu,
  )) {
    copies.push(match[1].replace(/\/$/u, ''));
  }
  return copies;
}

/** `node ./src/...ts` entry points the production services and runbook run. */
export function sourceEntryPoints(...texts) {
  const entries = new Set();
  for (const text of texts) {
    for (const match of text.matchAll(/node['",\s]+\.\/(src\/[^'"\s&]+\.ts)/gu))
      entries.add(match[1]);
  }
  return [...entries].sort();
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Every repository file an entry point loads, transitively. */
export async function moduleClosure(entry) {
  const seen = new Set();
  const pending = [resolve(root, entry)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(?:[cm]?[jt]s)$/u.test(file)) continue;
    const source = withoutComments(await readFile(file, 'utf8'));
    for (const pattern of loadPatterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (!(await isFile(target)))
          throw new Error(
            `${relative(root, file)} loads a missing file: ${specifier}`,
          );
        pending.push(target);
      }
    }
  }
  return [...seen].map((file) => relative(root, file)).sort();
}

export function uncopied(files, copies) {
  return files.filter(
    (file) =>
      !copies.some((copy) => file === copy || file.startsWith(`${copy}/`)),
  );
}

test('every production source entry point loads only files the runtime image copies', async () => {
  const [dockerfile, compose, runbook] = await Promise.all([
    readFile(dockerfileUrl, 'utf8'),
    readFile(composeUrl, 'utf8'),
    readFile(runbookUrl, 'utf8'),
  ]);
  const copies = runtimeCopies(dockerfile);
  const entries = sourceEntryPoints(compose, dockerfile, runbook);
  // The app's config check, the migration runner, the maintenance worker, its
  // heartbeat health check (G7-1-I2) and the runbook's flag CLI.
  assert.deepEqual(entries, [
    'src/server/config.ts',
    'src/server/db/run-migrations.ts',
    'src/server/flags/cli.ts',
    'src/server/subscriber/heartbeat-check.ts',
    'src/server/subscriber/run-maintenance.ts',
  ]);

  const missing = {};
  for (const entry of entries) {
    const absent = uncopied(await moduleClosure(entry), copies);
    if (absent.length > 0) missing[entry] = absent;
  }
  assert.deepEqual(
    missing,
    {},
    'The runtime image omits modules a production entry point imports',
  );
});

test('the closure check reports a module whose COPY line is removed', async () => {
  const dockerfile = await readFile(dockerfileUrl, 'utf8');
  const planted = dockerfile.replace(
    /^COPY .*\/app\/src\/server\/db .*$/mu,
    '',
  );
  assert.notEqual(planted, dockerfile, 'the planted removal applied');
  const absent = uncopied(
    await moduleClosure('src/server/db/run-migrations.ts'),
    runtimeCopies(planted),
  );
  assert.ok(
    absent.includes('src/server/db/run-migrations.ts'),
    `the removed db directory is reported: ${absent.join(', ')}`,
  );
});
