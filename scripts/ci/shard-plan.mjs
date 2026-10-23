import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const hook = fileURLToPath(new URL('./discovery-hook.mjs', import.meta.url));
export const timingsPath = 'scripts/ci/shard-timings.json';

export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/u.exec(value ?? '');
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || total < 1 || index < 1 || index > total) {
    throw new Error(
      `--shard must look like 2/4, with 1 <= index <= total; got ${value}.`,
    );
  }
  return { index, total };
}

/**
 * The test files `npm test` runs, in Node's own order. Node discovers them;
 * a hook in each child records its file and exits before any test runs, so
 * the list can never drift from the runner's discovery rules.
 */
export async function discoverTestFiles(root = projectRoot) {
  const directory = await mkdtemp(join(tmpdir(), 'valstara-test-files-'));
  const listPath = join(directory, 'files.txt');
  const environment = { ...process.env, VALSTARA_TEST_FILE_LIST: listPath };
  delete environment.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(
      process.execPath,
      ['--import', hook, '--import', 'tsx', '--test', '--test-concurrency=1'],
      { cwd: root, encoding: 'utf8', env: environment },
    );
    if (result.status !== 0) {
      throw new Error(
        `Test discovery failed:\n${result.stdout}\n${result.stderr}`,
      );
    }
    const files = (await readFile(listPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((file) => relative(root, file).replaceAll('\\', '/'))
      .sort();
    if (files.length === 0) throw new Error('Test discovery found no files.');
    return files;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Splits files into `total` shards of similar recorded duration: the longest
 * file goes first, each onto the currently lightest shard. A file with no
 * recorded timing weighs the median, so a new file is still assigned once.
 * Every file lands in exactly one shard, and the plan is deterministic.
 */
export function planShards(files, timings, total) {
  const known = files
    .map((file) => timings[file])
    .filter((seconds) => Number.isFinite(seconds));
  const fallback = known.length > 0 ? median(known) : 1;
  const weighted = files
    .map((file) => ({
      file,
      seconds: Number.isFinite(timings[file]) ? timings[file] : fallback,
    }))
    .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
  const shards = Array.from({ length: total }, () => ({
    files: [],
    seconds: 0,
  }));
  for (const { file, seconds } of weighted) {
    let lightest = 0;
    for (let index = 1; index < shards.length; index += 1) {
      if (shards[index].seconds < shards[lightest].seconds) lightest = index;
    }
    shards[lightest].files.push(file);
    shards[lightest].seconds += seconds;
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

export async function readTimings(root = projectRoot) {
  return JSON.parse(await readFile(join(root, timingsPath), 'utf8'));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const totalIndex = process.argv.indexOf('--total');
  const total = totalIndex === -1 ? 4 : Number(process.argv[totalIndex + 1]);
  const files = await discoverTestFiles();
  const plan = planShards(files, await readTimings(), total);
  plan.forEach((shard, index) => {
    console.log(
      `shard ${index + 1}/${total}: ${shard.files.length} files, ~${Math.round(shard.seconds)}s recorded`,
    );
  });
}
