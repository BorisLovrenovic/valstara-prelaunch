import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import test from 'node:test';

const executableExtensions = new Set([
  '.cjs',
  '.htm',
  '.html',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);
const astroScriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gu;
const clientAttributionPattern =
  /\b(?:URLSearchParams|searchParams|referral_capture|utm_(?:source|medium|campaign|content|term))\b|(?:[?&]|[.#])ref(?:=|\b)|\blocation\s*\.\s*(?:search|href)\b/iu;

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesIn(path) : [path];
    }),
  );
  return files.flat();
}

function inlineScripts(source) {
  return [...source.matchAll(astroScriptPattern)].map(([, script]) => script);
}

async function browserDeliveredSources(root) {
  const sourceDirectory = join(root, 'src');
  const publicDirectory = join(root, 'public');
  const sourceFiles = await filesIn(sourceDirectory);
  const publicFiles = await filesIn(publicDirectory);
  const browserSources = [];

  for (const path of sourceFiles) {
    const source = await readFile(path, 'utf8');
    const extension = extname(path);
    const sourcePath = relative(root, path);

    if (extension === '.astro') {
      for (const [index, script] of inlineScripts(source).entries()) {
        browserSources.push({
          name: `${sourcePath} script ${index + 1}`,
          source: script,
        });
      }
    } else if (
      executableExtensions.has(extension) &&
      !sourcePath.startsWith('src/server/') &&
      !sourcePath.startsWith('src/pages/api/')
    ) {
      browserSources.push({ name: sourcePath, source });
    }
  }

  for (const path of publicFiles) {
    const extension = extname(path);
    if (!executableExtensions.has(extension)) {
      continue;
    }

    const source = await readFile(path, 'utf8');
    const sourcePath = relative(root, path);
    const scripts =
      extension === '.html' || extension === '.htm'
        ? inlineScripts(source)
        : [source];
    for (const [index, script] of scripts.entries()) {
      browserSources.push({
        name:
          scripts.length === 1
            ? sourcePath
            : `${sourcePath} script ${index + 1}`,
        source: script,
      });
    }
  }

  return browserSources;
}

function assertNoClientAttributionPath(browserSources) {
  for (const { name, source } of browserSources) {
    assert.doesNotMatch(source, clientAttributionPattern, name);
  }
}

test('all browser-delivered source and assets have no referral or UTM attribution path', async () => {
  const root = new URL('..', import.meta.url).pathname;
  assertNoClientAttributionPath(await browserDeliveredSources(root));
});

test('the repository scan rejects a ref reader mutated into a page client script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-e402-client-path-'));

  try {
    await mkdir(join(root, 'src/pages'), { recursive: true });
    await mkdir(join(root, 'public'));
    await writeFile(
      join(root, 'src/pages/index.astro'),
      `<script>const ref = new URL(window.location.href).searchParams.get('ref');</script>`,
    );

    await assert.rejects(async () =>
      assertNoClientAttributionPath(await browserDeliveredSources(root)),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
