import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// Everything `npm run build` reads from the repository, including the SEO
// check that runs before and after it. Git-ignored output it regenerates
// itself (public/images/og/) is not an input.
const inputPaths = [
  'src',
  'public',
  'astro.config.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'scripts/ci/seo-build-check.ts',
  'scripts/ci/provider-showcase-check.ts',
];

export const stampName = '.valstara-build-stamp.json';

// Measured 2026-10-23: of the environment, only NODE_ENV, COVERAGE_SOURCE_MAPS
// and PUBLIC_* variables change the build output. Secrets, URLs and other
// configuration are read by the server at runtime, not at build time.
export function buildEnvironment(environment) {
  return Object.keys(environment)
    .filter(
      (key) =>
        key === 'NODE_ENV' ||
        key === 'COVERAGE_SOURCE_MAPS' ||
        key.startsWith('PUBLIC_'),
    )
    .sort()
    .map((key) => [key, environment[key]]);
}

async function fileDigest(path) {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

export async function inputDigest(
  root = projectRoot,
  environment = process.env,
) {
  const tracked = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...inputPaths,
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  // Vite loads .env files from the root even though Git ignores them.
  const environmentFiles = (await readdir(root)).filter((name) =>
    name.startsWith('.env'),
  );
  const files = [
    ...new Set([
      ...tracked,
      ...environmentFiles,
      'node_modules/.package-lock.json',
    ]),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\0${await fileDigest(join(root, file))}\0`);
  }
  hash.update(JSON.stringify(buildEnvironment(environment)));
  return hash.digest('hex');
}

async function listFiles(directory) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

// A test may change dist/ after building, for example by deleting an image to
// exercise a fallback. The output fingerprint makes such a build stale.
export async function outputDigest(root = projectRoot) {
  const distRoot = join(root, 'dist');
  let files;
  try {
    files = await listFiles(distRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
  const hash = createHash('sha256');
  for (const file of files
    .map((path) => relative(distRoot, path).replaceAll('\\', '/'))
    .filter((path) => path !== stampName)
    .sort()) {
    hash.update(`${file}\0${await fileDigest(join(distRoot, file))}\0`);
  }
  return hash.digest('hex');
}

async function readStamp(root) {
  try {
    return JSON.parse(await readFile(join(root, 'dist', stampName), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Builds the app unless dist/ already holds a build of exactly these inputs,
 * under the same build-relevant environment, and is unchanged since.
 */
export async function ensureAppBuild({
  root = projectRoot,
  env = process.env,
} = {}) {
  const stamp = await readStamp(root);
  if (
    stamp !== null &&
    stamp.input === (await inputDigest(root, env)) &&
    stamp.output === (await outputDigest(root))
  ) {
    return { built: false };
  }
  try {
    await executeFile('npm', ['run', 'build'], {
      cwd: root,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `npm run build failed (exit ${error.code}):\n${error.stdout ?? ''}\n${error.stderr ?? ''}`,
      { cause: error },
    );
  }
  // The pre-build SEO step may rewrite a tracked input, so the stamp records
  // the inputs as they stand after the build.
  await writeFile(
    join(root, 'dist', stampName),
    `${JSON.stringify({
      input: await inputDigest(root, env),
      output: await outputDigest(root),
    })}\n`,
  );
  return { built: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { built } = await ensureAppBuild();
  console.log(
    built
      ? 'Built the app and stamped dist/.'
      : 'dist/ already holds this build; reused it.',
  );
}
