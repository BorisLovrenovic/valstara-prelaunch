import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function parseChangedLines(diff) {
  const changed = new Map();
  let currentFile;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }

    if (!currentFile || !line.startsWith('@@')) {
      continue;
    }

    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) {
      continue;
    }

    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const lines = changed.get(currentFile) ?? new Set();

    for (let offset = 0; offset < count; offset += 1) {
      lines.add(start + offset);
    }

    changed.set(currentFile, lines);
  }

  return changed;
}

export function parseLcov(lcov, root = projectRoot) {
  const coverage = new Map();
  let currentFile;

  for (const line of lcov.split('\n')) {
    if (line.startsWith('SF:')) {
      currentFile = relative(root, resolve(root, line.slice(3))).replaceAll(
        '\\',
        '/',
      );
      coverage.set(currentFile, new Map());
      continue;
    }

    if (!currentFile || !line.startsWith('DA:')) {
      continue;
    }

    const [lineNumber, hits] = line.slice(3).split(',').map(Number);
    coverage.get(currentFile)?.set(lineNumber, hits);
  }

  return coverage;
}

export function changedCoverage(changed, coverage, config) {
  let covered = 0;
  let total = 0;
  const filesWithoutCoverage = [];

  for (const [file, lines] of changed) {
    const isIncluded =
      config.includedRoots.some((root) => file.startsWith(root)) &&
      config.includedExtensions.includes(extname(file));

    if (!isIncluded) {
      continue;
    }

    const lineCoverage = coverage.get(file) ?? new Map();
    const hasChangedLineCoverage = [...lines].some((line) =>
      lineCoverage.has(line),
    );
    if (!hasChangedLineCoverage) {
      filesWithoutCoverage.push(file);
      continue;
    }

    for (const line of lines) {
      if (!lineCoverage.has(line)) {
        continue;
      }

      total += 1;
      if ((lineCoverage.get(line) ?? 0) > 0) {
        covered += 1;
      }
    }
  }

  return {
    covered,
    total,
    filesWithoutCoverage,
    percentage: total === 0 ? 100 : (covered / total) * 100,
  };
}

export function assertCoverage(result, minimum) {
  if (result.filesWithoutCoverage.length > 0) {
    throw new Error(
      `Changed executable source has no coverage entries: ${result.filesWithoutCoverage.join(', ')}.`,
    );
  }

  if (result.percentage < minimum) {
    throw new Error(
      `Changed-line coverage ${result.percentage.toFixed(2)}% (${result.covered}/${result.total}) is below ${minimum}%.`,
    );
  }
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const base =
    readArgument('--base') ?? process.env.COVERAGE_BASE_SHA ?? 'origin/main';
  const config = JSON.parse(
    await readFile(resolve(projectRoot, 'coverage.config.json'), 'utf8'),
  );
  const lcov = await readFile(
    resolve(projectRoot, 'coverage/lcov.info'),
    'utf8',
  );
  const diff = execFileSync(
    'git',
    ['diff', '--unified=0', '--diff-filter=ACMR', `${base}...HEAD`],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  const result = changedCoverage(
    parseChangedLines(diff),
    parseLcov(lcov),
    config,
  );

  assertCoverage(result, config.changedLinesMinimum);
  console.log(
    `Changed-line coverage ${result.percentage.toFixed(2)}% (${result.covered}/${result.total}); required ${config.changedLinesMinimum}%.`,
  );

  if (!config.criticalModules.enforced) {
    console.log(
      `Critical-module coverage is configured at ${config.criticalModules.minimum}% and remains deferred until those modules exist.`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
