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
// Statements that load a module when the file runs. Type-only imports are
// erased by TypeScript and load nothing.
const importPatterns = [
  /\b(?:import|export)\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /\bimport\s+['"]([^'"]+)['"]/gu,
];
// A file the test reads as data: only its own content matters.
const readPattern =
  /\bnew URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu;

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// String and template literals in test code. A test that scans a directory or
// reads a file through `fs` names it as one of these, whatever helper it
// passes the path to: `'src/content'`, `` `${root}/src/pages` ``, or
// `'../src/islands/'` in a `new URL()`.
const literalPattern = /'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/gu;
// Read results that never come from the repository's tracked sources.
const unreadRoots = new Set(['.git', 'dist', 'node_modules']);

/**
 * Repository paths a test file names in its literals, each marked as a
 * directory or a file. A directory covers every file beneath it, including one
 * added after the test was written. Only literals that resolve to an existing
 * path below the root count, so routes, URLs and messages are ignored.
 */
export async function repositoryReads(root, file, source) {
  const reads = new Map();
  for (const match of source.matchAll(literalPattern)) {
    const text = match[1] ?? match[2] ?? match[3];
    for (const piece of text.split(/\$\{[^}]*\}/u)) {
      // A glob reads the directory its static prefix names.
      const literal = piece.split(/[*?[{]/u)[0];
      if (!literal.includes('/') || !/^[\w./@+-]+$/u.test(literal)) continue;
      const absolute = /^\.\.?\//u.test(literal)
        ? resolve(root, dirname(file), literal)
        : resolve(root, literal.replace(/^\/+/u, ''));
      const path = relative(root, absolute).replaceAll('\\', '/');
      if (path === '' || path.startsWith('..') || reads.has(path)) continue;
      if (unreadRoots.has(path.split('/')[0])) continue;
      try {
        reads.set(path, (await stat(absolute)).isDirectory());
      } catch {
        // Not a repository path: a route, a URL or a fixture name.
      }
    }
  }
  return reads;
}

/** Package names a source file imports by bare specifier, such as `pg`. */
export function packageImports(source) {
  const packages = new Set();
  for (const pattern of importPatterns) {
    for (const [, specifier] of source.matchAll(pattern)) {
      if (/^[./]/u.test(specifier) || specifier.includes(':')) continue;
      const parts = specifier.split('/');
      packages.add(
        specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0],
      );
    }
  }
  return packages;
}

const installedName = (path) =>
  path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);

/** Installed packages that appeared, disappeared or changed version. */
export function changedPackages(baseLock, currentLock) {
  const versions = (lock) =>
    new Map(
      Object.entries(lock.packages ?? {})
        .filter(([path]) => path.includes('node_modules/'))
        .map(([path, entry]) => [path, entry.version]),
    );
  const before = versions(baseLock);
  const after = versions(currentLock);
  const changed = new Set();
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) !== after.get(path)) changed.add(installedName(path));
  }
  return changed;
}

/**
 * The project's direct dependencies that a package change reaches: a changed
 * package that is itself direct, and every direct dependency that depends on a
 * changed package through the installed tree. Each maps to the changed
 * packages behind it.
 */
export function affectedDependencies(locks, changed) {
  const direct = new Set();
  const dependents = new Map();
  for (const lock of locks) {
    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
      const dependencies = Object.keys({
        ...entry.dependencies,
        ...entry.optionalDependencies,
        ...entry.peerDependencies,
        ...(path === '' ? entry.devDependencies : {}),
      });
      if (path === '') {
        for (const name of dependencies) direct.add(name);
        continue;
      }
      for (const name of dependencies) {
        dependents.set(
          name,
          (dependents.get(name) ?? new Set()).add(installedName(path)),
        );
      }
    }
  }
  const affected = new Map();
  for (const start of changed) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const name = queue.shift();
      if (direct.has(name)) {
        affected.set(name, (affected.get(name) ?? new Set()).add(start));
      }
      for (const parent of dependents.get(name) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
  }
  return affected;
}

/**
 * Repository files a source file names by relative path, each marked `import`
 * when it runs with the file or `read` when the file only reads it.
 */
export async function localDependencies(root, file, source) {
  const dependencies = new Map();
  const add = async (specifier, kind) => {
    if (!specifier.startsWith('.')) return;
    const base = resolve(root, dirname(file), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`]) {
      const path = relative(root, candidate).replaceAll('\\', '/');
      if (path.startsWith('..') || path.includes('node_modules/')) return;
      if (await isFile(candidate)) {
        if (dependencies.get(path) !== 'import') dependencies.set(path, kind);
        return;
      }
    }
  };
  for (const pattern of importPatterns) {
    for (const [, specifier] of source.matchAll(pattern)) {
      await add(specifier, 'import');
    }
  }
  for (const [, specifier] of source.matchAll(readPattern)) {
    await add(specifier, 'read');
  }
  return dependencies;
}

/**
 * Picks the test files a change needs: changed tests, tests whose import graph
 * reaches a changed file or a package a dependency change affects, named
 * suites, and the browser suites when a change can reach a rendered page.
 * Returns each file with the reason it was picked.
 */
export async function selectTests({
  root,
  changedFiles,
  candidates,
  named = [],
  dependencies = new Map(),
}) {
  const changed = new Set(changedFiles);
  const selected = new Map();
  const reasons = new Map();

  async function reachedChange(file, visiting = new Set()) {
    if (reasons.has(file)) return reasons.get(file);
    if (visiting.has(file)) return null;
    visiting.add(file);
    let found = null;
    if (codeExtensions.has(extname(file))) {
      const source = await readFile(resolve(root, file), 'utf8');
      for (const name of packageImports(source)) {
        if (dependencies.has(name)) {
          found = `uses ${name}, affected by changed ${[...dependencies.get(name)].sort().join(', ')}`;
          break;
        }
      }
      for (const [dependency, kind] of found
        ? []
        : await localDependencies(root, file, source)) {
        if (changed.has(dependency)) found = `imports ${dependency}`;
        else if (kind === 'import') {
          found = await reachedChange(dependency, visiting);
        }
        if (found) break;
      }
      // Test code (a test or a helper it imports) that reads the repository
      // through `fs`: a changed file it names, or any change beneath a
      // directory it names, such as a component added to a scanned folder.
      if (!found && file.startsWith('test/')) {
        for (const [path, directory] of await repositoryReads(
          root,
          file,
          source,
        )) {
          const hit = directory
            ? changedFiles.find((changedFile) =>
                changedFile.startsWith(`${path}/`),
              )
            : changed.has(path) && path;
          if (hit) {
            found = directory ? `reads ${path}/ (${hit})` : `reads ${hit}`;
            break;
          }
        }
      }
    }
    visiting.delete(file);
    reasons.set(file, found);
    return found;
  }

  for (const file of named) selected.set(file, 'named');
  for (const file of candidates) {
    if (selected.has(file)) continue;
    if (changed.has(file)) {
      selected.set(file, 'changed');
      continue;
    }
    const reason = await reachedChange(file);
    if (reason) selected.set(file, reason);
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

export function mergeBaseOf(root, base) {
  return git(root, ['merge-base', 'HEAD', base]).trim();
}

export function changedFilesSince(root, base) {
  const mergeBase = mergeBaseOf(root, base);
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
  let dependencies = new Map();
  if (changedFiles.includes('package-lock.json')) {
    let baseLock = {};
    try {
      baseLock = JSON.parse(
        git(projectRoot, [
          'show',
          `${mergeBaseOf(projectRoot, base)}:package-lock.json`,
        ]),
      );
    } catch {
      // A lockfile new since the base: every installed package is new.
    }
    const currentLock = JSON.parse(
      await readFile(resolve(projectRoot, 'package-lock.json'), 'utf8'),
    );
    const packages = changedPackages(baseLock, currentLock);
    dependencies = affectedDependencies([baseLock, currentLock], packages);
    console.log(
      `Dependency change: ${[...packages].sort().join(', ') || 'none installed'}; reaches ${[...dependencies.keys()].sort().join(', ') || 'no direct dependency'}.`,
    );
  }
  const selected = await selectTests({
    root: projectRoot,
    changedFiles,
    candidates,
    named,
    dependencies,
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
