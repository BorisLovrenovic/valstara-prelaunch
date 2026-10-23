import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverTestFiles } from './shard-plan.mjs';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// The rendered-page privacy suites (`npm run test:privacy`) and the axe suite
// (`npm run test:a11y`). Any change that can reach the browser runs them.
export const browserSuites = [
  'test/e1-11-rendered-page.test.mjs',
  'test/signup-form-rendered-page.test.mjs',
  'test/accessibility.test.mjs',
];

const browserPaths = [
  'src/pages/',
  'src/components/',
  'src/islands/',
  'src/layouts/',
  'src/styles/',
  'src/copy/',
  'src/content/',
  'src/middleware.ts',
  'public/',
  'astro.config.mjs',
];

export function reachesBrowser(file) {
  return browserPaths.some((path) => file === path || file.startsWith(path));
}

const codeExtensions = new Set([
  '.astro',
  '.cjs',
  '.js',
  '.mjs',
  '.mts',
  '.ts',
]);
const specifierPatterns = [
  /\bfrom\s*['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /\bimport\s+['"]([^'"]+)['"]/gu,
  /\bnew URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu,
];

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Repository files a source file names by relative path. */
export async function localDependencies(root, file, source) {
  const dependencies = new Set();
  for (const pattern of specifierPatterns) {
    for (const [, specifier] of source.matchAll(pattern)) {
      if (!specifier.startsWith('.')) continue;
      const base = resolve(root, dirname(file), specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.mjs`,
        `${base}.js`,
      ]) {
        const path = relative(root, candidate).replaceAll('\\', '/');
        if (path.startsWith('..') || path.includes('node_modules/')) break;
        if (await isFile(candidate)) {
          dependencies.add(path);
          break;
        }
      }
    }
  }
  return dependencies;
}

/**
 * Picks the test files a change needs: changed tests, tests whose import graph
 * reaches a changed file, named suites, and the browser suites when a change
 * can reach a rendered page. Returns each file with the reason it was picked.
 */
export async function selectTests({
  root,
  changedFiles,
  candidates,
  named = [],
}) {
  const changed = new Set(changedFiles);
  const selected = new Map();
  const reachedFrom = new Map();

  async function changedDependency(file, visiting = new Set()) {
    if (reachedFrom.has(file)) return reachedFrom.get(file);
    if (visiting.has(file)) return null;
    visiting.add(file);
    let found = null;
    if (codeExtensions.has(extname(file))) {
      const source = await readFile(resolve(root, file), 'utf8');
      for (const dependency of await localDependencies(root, file, source)) {
        found = changed.has(dependency)
          ? dependency
          : await changedDependency(dependency, visiting);
        if (found) break;
      }
    }
    visiting.delete(file);
    reachedFrom.set(file, found);
    return found;
  }

  for (const file of named) selected.set(file, 'named');
  for (const file of candidates) {
    if (selected.has(file)) continue;
    if (changed.has(file)) {
      selected.set(file, 'changed');
      continue;
    }
    const dependency = await changedDependency(file);
    if (dependency) selected.set(file, `imports ${dependency}`);
  }
  const browserChange = changedFiles.find(reachesBrowser);
  if (browserChange) {
    for (const suite of browserSuites) {
      if (!selected.has(suite)) {
        selected.set(suite, `browser-facing change: ${browserChange}`);
      }
    }
  }
  return new Map([...selected].sort(([a], [b]) => a.localeCompare(b)));
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

export function changedFilesSince(root, base) {
  const mergeBase = git(root, ['merge-base', 'HEAD', base]).trim();
  const lines = [
    ...git(root, ['diff', '--name-only', mergeBase]).split('\n'),
    ...git(root, ['ls-files', '--others', '--exclude-standard']).split('\n'),
  ];
  return [...new Set(lines.filter(Boolean))].sort();
}

function defaultBase(root) {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', 'origin/main']);
    return 'origin/main';
  } catch {
    return 'main';
  }
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const baseIndex = argumentsList.indexOf('--base');
  const base =
    baseIndex === -1 ? defaultBase(projectRoot) : argumentsList[baseIndex + 1];
  const dryRun = argumentsList.includes('--dry-run');
  const named = argumentsList.filter(
    (argument, index) =>
      !argument.startsWith('--') && argumentsList[index - 1] !== '--base',
  );
  const candidates = await discoverTestFiles(projectRoot);
  const unknown = named.filter((file) => !candidates.includes(file));
  if (unknown.length > 0) {
    throw new Error(`Not a test file npm test runs: ${unknown.join(', ')}`);
  }
  const changedFiles = changedFilesSince(projectRoot, base);
  const selected = await selectTests({
    root: projectRoot,
    changedFiles,
    candidates,
    named,
  });
  console.log(`${changedFiles.length} files changed since ${base}.`);
  if (selected.size === 0) {
    console.log('No test file is affected; nothing to run.');
    return;
  }
  for (const [file, reason] of selected) console.log(`  ${file}  (${reason})`);
  if (dryRun) return;
  const result = spawnSync('npm', ['test', '--', ...selected.keys()], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
