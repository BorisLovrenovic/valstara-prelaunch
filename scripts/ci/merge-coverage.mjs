import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Every shard must have discovered the same files, and together the shards
 * must have run each discovered file exactly once. Otherwise a test could
 * silently drop out of CI.
 */
export function verifyShards(manifests) {
  if (manifests.length === 0) throw new Error('No shard reports were found.');
  const total = manifests[0].total;
  const indexes = manifests
    .map((manifest) => manifest.index)
    .sort((a, b) => a - b);
  const expected = Array.from({ length: total }, (_, index) => index + 1);
  if (
    manifests.some((manifest) => manifest.total !== total) ||
    JSON.stringify(indexes) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `Expected shard reports 1 to ${total} once each; got ${indexes.join(', ')}.`,
    );
  }
  const discovered = JSON.stringify(manifests[0].discovered);
  if (
    manifests.some(
      (manifest) => JSON.stringify(manifest.discovered) !== discovered,
    )
  ) {
    throw new Error('The shards discovered different test files.');
  }
  const runs = new Map();
  for (const manifest of manifests) {
    for (const file of manifest.files) {
      runs.set(file, [...(runs.get(file) ?? []), manifest.index]);
    }
  }
  const duplicated = [...runs].filter(([, shards]) => shards.length > 1);
  const missing = manifests[0].discovered.filter((file) => !runs.has(file));
  const unknown = [...runs.keys()].filter(
    (file) => !manifests[0].discovered.includes(file),
  );
  const problems = [
    ...duplicated.map(
      ([file, shards]) => `${file} ran in shards ${shards.join(', ')}`,
    ),
    ...missing.map((file) => `${file} ran in no shard`),
    ...unknown.map((file) => `${file} ran but was not discovered`),
  ];
  if (problems.length > 0) {
    throw new Error(
      `The shards did not run each test file once:\n${problems.join('\n')}`,
    );
  }
  return manifests[0].discovered.length;
}

/**
 * Parses the line data (DA) of an LCOV report, keying each source file
 * relative to the root its shard ran in.
 *
 * Only lines are merged. Line hits from separate runs sum exactly to what one
 * run over all the files reports, and the coverage gates measure lines. c8
 * derives function and branch entries per run, including placeholders for
 * files a run never loaded, so those cannot be combined faithfully.
 */
export function parseLcovRecords(lcov, root) {
  const records = new Map();
  let current;
  for (const line of lcov.split('\n')) {
    if (line.startsWith('SF:')) {
      const file = relative(root, resolve(root, line.slice(3))).replaceAll(
        '\\',
        '/',
      );
      current = records.get(file) ?? new Map();
      records.set(file, current);
    } else if (line === 'end_of_record') {
      current = undefined;
    } else if (current && line.startsWith('DA:')) {
      const [lineNumber, hits] = line.slice(3).split(',').map(Number);
      current.set(lineNumber, (current.get(lineNumber) ?? 0) + hits);
    }
  }
  return records;
}

/** Sums each file's line hits across shards. */
export function mergeLcovRecords(recordSets) {
  const merged = new Map();
  for (const records of recordSets) {
    for (const [file, lines] of records) {
      const target = merged.get(file) ?? new Map();
      merged.set(file, target);
      for (const [line, hits] of lines) {
        target.set(line, (target.get(line) ?? 0) + hits);
      }
    }
  }
  return merged;
}

const covered = (lines) =>
  [...lines.values()].filter((hits) => hits > 0).length;

export function formatLcov(records) {
  const output = [];
  for (const file of [...records.keys()].sort()) {
    const lines = records.get(file);
    output.push('TN:', `SF:${file}`);
    for (const [line, hits] of [...lines].sort(([a], [b]) => a - b)) {
      output.push(`DA:${line},${hits}`);
    }
    output.push(`LF:${lines.size}`, `LH:${covered(lines)}`, 'end_of_record');
  }
  return `${output.join('\n')}\n`;
}

/** Line coverage over `src/`, the tree the gates measure, and over all files. */
export function summarise(records) {
  const total = (filter) => {
    let hit = 0;
    let all = 0;
    for (const [file, lines] of records) {
      if (!filter(file)) continue;
      hit += covered(lines);
      all += lines.size;
    }
    const percentage = all === 0 ? '100.00' : ((hit / all) * 100).toFixed(2);
    return `${percentage}% (${hit}/${all})`;
  };
  return `src/ lines ${total((file) => file.startsWith('src/'))} · all reported lines ${total(() => true)}`;
}

async function main() {
  const directory = resolve(process.argv[2] ?? 'coverage-shards');
  const shardDirectories = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name));
  const shards = await Promise.all(
    shardDirectories.map(async (shardDirectory) => {
      const read = (name) => readFile(join(shardDirectory, name), 'utf8');
      return {
        manifest: JSON.parse(await read('shard.json')),
        lcov: await read('lcov.info'),
        timings: JSON.parse(await read('test-timings.json')),
      };
    }),
  );
  const fileCount = verifyShards(shards.map(({ manifest }) => manifest));
  const merged = mergeLcovRecords(
    shards.map(({ manifest, lcov }) => parseLcovRecords(lcov, manifest.root)),
  );
  const timings = Object.fromEntries(
    shards
      .flatMap(({ timings: shardTimings }) => Object.entries(shardTimings))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  await mkdir(join(projectRoot, 'coverage'), { recursive: true });
  await writeFile(join(projectRoot, 'coverage/lcov.info'), formatLcov(merged));
  await writeFile(
    join(projectRoot, 'coverage/test-timings.json'),
    `${JSON.stringify(timings, null, 2)}\n`,
  );
  console.log(`Every one of the ${fileCount} test files ran exactly once.`);
  for (const { manifest, timings: shardTimings } of shards.sort(
    (a, b) => a.manifest.index - b.manifest.index,
  )) {
    const seconds = Object.values(shardTimings).reduce(
      (sum, value) => sum + value,
      0,
    );
    console.log(
      `shard ${manifest.index}/${manifest.total}: ${manifest.files.length} files, ${Math.round(seconds)}s run, ${manifest.plannedSeconds}s planned`,
    );
  }
  console.log(`Merged line coverage: ${summarise(merged)}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
