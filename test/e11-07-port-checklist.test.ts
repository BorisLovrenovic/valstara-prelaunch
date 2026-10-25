import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { validateRulesCatalog } from '../src/server/giveaway/rules.ts';
import { currentRulesFromFiles } from '../src/server/giveaway/current-rules-file.ts';

const root = new URL('../', import.meta.url);
const source = (path: string) => new URL(path, root);

function frontmatterValue(markdown: string, key: string): string {
  const frontmatter = /^---\n(?<body>[\s\S]*?)\n---/u.exec(markdown)?.groups
    ?.body;
  assert.ok(frontmatter, 'Markdown frontmatter is required');
  const value = new RegExp(`^${key}: ['"]?(?<value>[^'"\n]+)['"]?$`, 'mu').exec(
    frontmatter,
  )?.groups?.value;
  assert.ok(value, `${key} is required`);
  return value;
}

test('the checklist maps every portable Markdown source to one known storefront route and back', async () => {
  const checklist = await readFile(source('docs/brand/tokens.md'), 'utf8');
  async function contentFiles(directory: string): Promise<string[]> {
    const entries = (
      await readdir(source(directory), { withFileTypes: true })
    ).filter((entry) => !entry.name.startsWith('.'));
    return (
      await Promise.all(
        entries.map(async (entry) => {
          const path = `${directory}/${entry.name}`;
          return entry.isDirectory() ? contentFiles(path) : [path];
        }),
      )
    ).flat();
  }
  const allContentFiles = await contentFiles('src/content');
  const rulesFiles = (await readdir(source('src/content/giveaway-rules')))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `src/content/giveaway-rules/${file}`);
  const markdownFiles = allContentFiles
    .filter((file) => file.endsWith('.md'))
    .sort();
  assert.deepEqual(
    allContentFiles.filter((file) => !file.endsWith('.md')),
    [
      'src/content/giveaway-award-catalog.json',
      'src/content/provider-showcase.json',
      'src/content/provider-showcase.ts',
    ],
  );
  const rows = [
    ...checklist.matchAll(
      /^\| `(src\/content\/[^`]+\.md)` \| `([^`]+)`(?: and `([^`]+)`)? \|/gmu,
    ),
  ].map((match) => ({
    file: match[1],
    primary: match[2],
    secondary: match[3],
  }));

  assert.deepEqual(rows.map((row) => row.file).sort(), markdownFiles);
  const expectedTargets = new Set([
    '/legit',
    '/guarantee',
    '/about',
    '/terms',
    '/privacy',
    '/privacy/storage',
    '/giveaway/rules',
    ...rulesFiles.map(
      (file) => `/giveaway/rules/${file.split('/').at(-1)?.slice(0, -3)}`,
    ),
  ]);
  const actualTargets = rows.flatMap((row) =>
    [row.primary, row.secondary].filter(Boolean),
  );
  assert.equal(actualTargets.length, new Set(actualTargets).size);
  assert.deepEqual(new Set(actualTargets), expectedTargets);
  const currentVersion = (await currentRulesFromFiles()).rulesVersion;

  for (const row of rows) {
    const markdown = await readFile(source(row.file), 'utf8');
    const target = frontmatterValue(markdown, 'portTarget');
    if (row.file.includes('/giveaway-rules/')) {
      const version = row.file.split('/').at(-1)?.slice(0, -3);
      assert.equal(frontmatterValue(markdown, 'rulesVersion'), version);
      assert.equal(row.primary, `/giveaway/rules/${version}`);
      assert.equal(
        row.secondary,
        version === currentVersion ? '/giveaway/rules' : undefined,
      );
    } else {
      assert.equal(row.secondary, undefined);
    }
    assert.equal(
      row.file.includes('/giveaway-rules/') ? '/giveaway/rules' : row.primary,
      target,
    );
  }
  assert.match(
    checklist,
    /giveaway-award-catalog\.json.*no storefront port target/u,
  );
});

test('the runbook current rules version agrees with the catalog used by currentRules()', async () => {
  const runbook = await readFile(source('docs/ops/launch-cutover.md'), 'utf8');
  const files = (await readdir(source('src/content/giveaway-rules'))).filter(
    (file) => file.endsWith('.md'),
  );
  const revisions = await Promise.all(
    files.map(async (file) => {
      const markdown = await readFile(
        source(`src/content/giveaway-rules/${file}`),
        'utf8',
      );
      return {
        rulesVersion: frontmatterValue(markdown, 'rulesVersion'),
        publishedOn: frontmatterValue(markdown, 'publishedOn'),
        revision: Number(frontmatterValue(markdown, 'revision')),
        sha256: frontmatterValue(markdown, 'sha256'),
        html: '',
        title: '',
        description: '',
      };
    }),
  );
  const current = validateRulesCatalog(revisions).current;
  assert.match(
    runbook,
    new RegExp(`The current revision is \`${current.rulesVersion}\``),
  );
  for (const revision of revisions) {
    assert.match(runbook, new RegExp(revision.rulesVersion));
  }
  const catalog = await readFile(
    source('src/server/giveaway/rules-catalog.ts'),
    'utf8',
  );
  assert.match(
    catalog,
    /export function currentRules\(\)\s*\{\s*return catalog\.current;/u,
  );
});

test('the token file is directly copyable and every font URL has a bundled asset', async () => {
  const css = await readFile(source('src/styles/tokens.css'), 'utf8');
  assert.doesNotMatch(css, /@import\b|@apply\b|@tailwind\b|theme\(/u);
  const urls = [...css.matchAll(/url\(['"]?(\/fonts\/[^)'"\s]+)['"]?\)/gu)].map(
    (match) => match[1],
  );
  assert.equal(urls.length, 4);
  const assets = (await readdir(source('public/fonts'))).sort();
  assert.deepEqual(assets, [
    'OFL-Instrument-Sans.txt',
    'OFL-JetBrains-Mono.txt',
    'instrument-sans-latin-wght-normal.woff',
    'instrument-sans-latin-wght-normal.woff2',
    'jetbrains-mono-latin-wght-normal.woff',
    'jetbrains-mono-latin-wght-normal.woff2',
  ]);
  for (const url of urls) {
    assert.ok(assets.includes(url.split('/').at(-1) ?? ''));
  }
});

test('every source page and API route has a recorded cutover disposition', async () => {
  const runbook = await readFile(source('docs/ops/launch-cutover.md'), 'utf8');
  async function files(directory: string): Promise<string[]> {
    const entries = await readdir(source(directory), { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = `${directory}/${entry.name}`;
        return entry.isDirectory() ? files(path) : [path];
      }),
    );
    return nested.flat();
  }
  const pages = (await files('src/pages')).filter((file) =>
    /\.(astro|ts)$/u.test(file),
  );
  const routes = pages.map((file) => {
    const route =
      file
        .replace(/^src\/pages/u, '')
        .replace(/\.(astro|ts)$/u, '')
        .replace(/\/index$/u, '') || '/';
    if (route === '/giveaway/rules/[rulesVersion]')
      return '/giveaway/rules/<rules_version>';
    if (route === '/api/webhooks/[provider]') return '/api/webhooks/<provider>';
    if (route === '/api/admin/fraud/[id]') return '/api/admin/fraud/<id>';
    return route;
  });
  assert.equal(new Set(routes).size, routes.length);
  for (const route of routes) {
    assert.ok(runbook.includes(`\`${route}\``), `${route} lacks a disposition`);
  }
});
