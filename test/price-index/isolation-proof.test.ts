import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import ts from 'typescript';

import { ensureAppBuild } from '../../scripts/ci/app-build.mjs';
import { renderLanding } from '../helpers/landing-render.mjs';
import { projectRoot } from '../helpers/price-index-run.ts';

// E11.6-07: the isolation proof. The tool cannot affect the site:
//
// - the built site contains no code from the tool's src/http, src/sources,
//   src/cli or src/reports, checked against the build output;
// - the site builds and serves with the tool absent.
//
// The third part, that the tool's failure modes alter no file the site
// reads, is asserted on every failure mode in scrape-run.test.ts,
// scrape-dry-run.test.ts and cli-exit.test.ts (`siteReadDirectories`).
//
// Code is recognised by its string literals: every message, label and
// format string of at least 16 printable characters with a space in it.
// Bundling and minifying rename identifiers but keep string literals, so if
// any module of those directories were bundled, its literals would be in the
// output. A path naming the directories (a source map, a module id) counts
// too.

const execute = promisify(execFile);
const toolDirectories = ['http', 'sources', 'cli', 'reports'].map(
  (name) => `packages/price-index/src/${name}`,
);
const textOutput = /\.(?:[cm]?js|html|css|json|map|txt|xml|svg)$/u;

/** The distinctive string literals of the TypeScript files under `directory`. */
async function markers(directory: string): Promise<string[]> {
  const found = new Set<string>();
  const names = (
    await readdir(join(projectRoot, directory), {
      recursive: true,
    })
  )
    .map(String)
    .filter((name) => name.endsWith('.ts'));
  for (const name of names) {
    const source = ts.createSourceFile(
      name,
      await readFile(join(projectRoot, directory, name), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const text = node.text.trim();
        // Printable ASCII without quotes or backslashes, so no bundler
        // escapes it differently from the source.
        if (
          text.length >= 16 &&
          text.includes(' ') &&
          /^[\x20-\x7e]+$/u.test(text) &&
          !/["'`\\]/u.test(text)
        ) {
          found.add(text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found];
}

interface Finding {
  file: string;
  directory: string;
  marker: string;
}

/** Every file of a build output that carries code or a path of the tool. */
async function toolCodeIn(
  outputRoot: string,
  byDirectory: ReadonlyMap<string, readonly string[]>,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const entries = await readdir(outputRoot, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile() || !textOutput.test(entry.name)) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const text = await readFile(path, 'utf8');
    for (const [directory, literals] of byDirectory) {
      const marker = [directory, ...literals].find((literal) =>
        text.includes(literal),
      );
      if (marker !== undefined) {
        findings.push({ file: relative(outputRoot, path), directory, marker });
      }
    }
  }
  return findings;
}

async function allMarkers(): Promise<Map<string, string[]>> {
  const byDirectory = new Map<string, string[]>();
  for (const directory of toolDirectories) {
    byDirectory.set(directory, await markers(directory));
  }
  return byDirectory;
}

test('the scan has markers for every tool directory, and finds tool code planted in an output', async () => {
  const byDirectory = await allMarkers();
  for (const [directory, literals] of byDirectory) {
    assert.ok(
      literals.length >= 4,
      `${directory} has only ${literals.length} markers, too few to detect it`,
    );
  }
  const output = await mkdtemp(join(tmpdir(), 'valstara-isolation-red-'));
  try {
    await mkdir(join(output, 'server/chunks'), { recursive: true });
    await writeFile(join(output, 'server/chunks/clean.mjs'), 'export {};\n');
    // One module of each directory, as a bundler would inline it.
    for (const [index, [, literals]] of [...byDirectory].entries()) {
      await writeFile(
        join(output, `server/chunks/planted-${index}.mjs`),
        `const message = "${literals.at(-1)}";\nexport { message };\n`,
      );
    }
    await writeFile(
      join(output, 'server/entry.mjs.map'),
      '{"sources":["../../packages/price-index/src/cli/main.ts"]}\n',
    );
    const findings = await toolCodeIn(output, byDirectory);
    assert.deepEqual(
      [...new Set(findings.map((finding) => finding.directory))].sort(),
      [...toolDirectories].sort(),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.file === 'server/entry.mjs.map' &&
          finding.marker === 'packages/price-index/src/cli',
      ),
    );
    assert.ok(!findings.some((finding) => finding.file.endsWith('clean.mjs')));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('the built site contains no code from src/http, src/sources, src/cli or src/reports', async () => {
  await ensureAppBuild();
  const findings = await toolCodeIn(
    join(projectRoot, 'dist'),
    await allMarkers(),
  );
  assert.deepEqual(findings, []);
});

/** The repository's files, as git lists them, apart from the tool. */
function filesWithoutTheTool(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean)
    .filter((file) => {
      if (file === 'config/price-index.json') {
        return false;
      }
      if (!file.startsWith('packages/price-index/')) {
        return true;
      }
      // What ADR-033 lets the site import stays; the rest of the tool goes.
      return (
        file.startsWith('packages/price-index/src/publish/') ||
        file.startsWith('packages/price-index/src/schema/')
      );
    })
    .filter((file) => existsSync(join(projectRoot, file)));
}

test('the site builds and serves with the tool absent', async () => {
  const copy = await mkdtemp(join(tmpdir(), 'valstara-without-tool-'));
  try {
    for (const file of filesWithoutTheTool()) {
      await mkdir(dirname(join(copy, file)), { recursive: true });
      await copyFile(join(projectRoot, file), join(copy, file));
    }
    await symlink(
      join(projectRoot, 'node_modules'),
      join(copy, 'node_modules'),
    );
    for (const absent of [
      'packages/price-index/src/cli',
      'packages/price-index/src/http',
      'packages/price-index/src/sources',
      'packages/price-index/src/reports',
      'packages/price-index/src/pipeline',
      'packages/price-index/test',
      'config/price-index.json',
      'data/raw',
    ]) {
      assert.ok(!existsSync(join(copy, absent)), `${absent} is in the copy`);
    }

    try {
      await execute('npm', ['run', 'build'], {
        cwd: copy,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      assert.fail(
        `the site did not build without the tool:\n${failed.stdout ?? ''}\n${failed.stderr ?? ''}`,
      );
    }
    // renderLanding's inferred type omits `root`, which it takes.
    const render = renderLanding as (options: {
      root: string;
    }) => Promise<{ body: string }>;
    const page = await render({ root: copy });
    assert.match(page.body, /<html\b/u);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});
