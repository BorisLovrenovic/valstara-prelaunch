import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSeoBuild } from '../scripts/ci/seo-build-check.ts';
import {
  canonicalUrl,
  jsonLd,
  organisationData,
  organisationId,
  rulesPageData,
  sitemapPaths,
  validatePageMetadata,
} from '../src/server/seo.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the build fixture rejects missing metadata, duplicate metadata and a new uncovered page', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'valstara-seo-'));
  try {
    await cp(join(root, 'src/pages'), join(fixture, 'src/pages'), {
      recursive: true,
    });
    await cp(join(root, 'src/content'), join(fixture, 'src/content'), {
      recursive: true,
    });
    await checkSeoBuild(fixture);
    const renderedAbout = join(fixture, 'dist/client/about/index.html');
    await mkdir(join(fixture, 'dist/client/about'), { recursive: true });
    await writeFile(
      renderedAbout,
      '<html><head><title>About</title><link rel="canonical" href="https://valstara.com/about"></head></html>',
    );
    await assert.rejects(
      checkSeoBuild(fixture, true),
      /rendered description is missing/u,
    );
    const about = join(fixture, 'src/content/about.md');
    const original = await readFile(about, 'utf8');
    await writeFile(
      about,
      original.replace(/^description:.*$/mu, 'description:'),
    );
    await assert.rejects(checkSeoBuild(fixture), /missing or duplicated/u);
    await writeFile(about, original);
    const index = join(fixture, 'src/pages/index.astro');
    const indexSource = await readFile(index, 'utf8');
    await writeFile(
      index,
      indexSource.replace('title={landingCopy.meta.title}', "title={''}"),
    );
    await assert.rejects(
      checkSeoBuild(fixture),
      /metadata binding is missing/u,
    );
    await writeFile(index, indexSource);
    await writeFile(
      join(fixture, 'src/pages/new.astro'),
      '<main>New page</main>',
    );
    await assert.rejects(checkSeoBuild(fixture), /missing for \/new/u);
    assert.throws(
      () =>
        validatePageMetadata(
          ['/one', '/two'],
          [
            { pathname: '/one', title: 'Same', description: 'First' },
            { pathname: '/two', title: 'Same', description: 'Second' },
          ],
        ),
      /duplicated/u,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('sitemap routes reconcile with page files and expand every published rules revision', async () => {
  const pageFiles = (
    await readdir(join(root, 'src/pages'), { recursive: true })
  )
    .filter((file) => file.endsWith('.astro'))
    .map((file) => `src/pages/${file}`);
  const revisions = (await readdir(join(root, 'src/content/giveaway-rules')))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -3));
  const routes = sitemapPaths(pageFiles, revisions);
  const eligiblePaths: string[] = [];
  for (const file of pageFiles) {
    if (
      file.startsWith('src/pages/api/') ||
      file.endsWith('/me.astro') ||
      file.endsWith('/verify.astro')
    )
      continue;
    if (file.includes('[')) continue;
    const path = file
      .replace('src/pages/', '')
      .replace(/(?:\/index)?\.astro$/u, '');
    const eligiblePath = path === 'index' ? '/' : `/${path}`;
    eligiblePaths.push(eligiblePath);
    assert.ok(routes.includes(eligiblePath), file);
  }
  for (const version of revisions) {
    eligiblePaths.push(`/giveaway/rules/${version}`);
    assert.ok(routes.includes(`/giveaway/rules/${version}`));
  }
  const sitemap = await readFile(join(root, 'public/sitemap.xml'), 'utf8');
  const generatedUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    generatedUrls.toSorted(),
    eligiblePaths.map(canonicalUrl).toSorted(),
  );
  assert.ok(
    sitemapPaths([...pageFiles, 'src/pages/new.astro'], revisions).includes(
      '/new',
    ),
  );
  assert.ok(!routes.includes('/me'));
  assert.ok(!routes.includes('/verify'));
});

test('robots excludes only the named private and API route prefixes', async () => {
  const robots = await readFile(join(root, 'public/robots.txt'), 'utf8');
  const directives = robots.trim().split(/\r?\n/u);
  assert.deepEqual(directives, [
    'User-agent: *',
    'Disallow: /api/admin/',
    'Disallow: /api/',
    'Disallow: /me',
    'Disallow: /verify',
  ]);
  for (const publicRoute of [
    '/legit',
    '/guarantee',
    '/about',
    '/terms',
    '/privacy',
    '/giveaway/rules',
  ]) {
    assert.ok(
      !directives.some(
        (line) =>
          line.startsWith('Disallow: ') &&
          publicRoute.startsWith(line.slice(10)),
      ),
    );
  }
});

test('organisation and every rules-page schema have permanent URLs and only approved claims', async () => {
  const org = organisationData();
  assert.deepEqual(org, {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': organisationId,
    name: 'Valstara',
    legalName: '3NITY DIGITAL LIMITED',
    url: 'https://valstara.com/',
  });
  assert.equal(jsonLd({ name: '</script>' }), '{"name":"\\u003c/script>"}');
  const files = (
    await readdir(join(root, 'src/content/giveaway-rules'))
  ).filter((file) => file.endsWith('.md'));
  const revisions = await Promise.all(
    files.map(async (file) => {
      const source = await readFile(
        join(root, 'src/content/giveaway-rules', file),
        'utf8',
      );
      const value = (name: string) =>
        new RegExp(`^${name}:\\s*(.*)$`, 'mu').exec(source)?.[1]?.trim() ?? '';
      return {
        rulesVersion: value('rulesVersion'),
        publishedOn: value('publishedOn'),
        title: value('title'),
        description: value('description'),
      };
    }),
  );
  const current = revisions
    .toSorted((a, b) => a.publishedOn.localeCompare(b.publishedOn))
    .at(-1);
  assert.ok(current);
  for (const [revision, path] of [
    [current, '/giveaway/rules'],
    ...revisions.map(
      (revision) =>
        [revision, `/giveaway/rules/${revision.rulesVersion}`] as const,
    ),
  ] as const) {
    const data = rulesPageData(
      { ...revision, sha256: '', html: '', revision: 1 },
      path,
    );
    assert.deepEqual(
      Object.keys(data).sort(),
      [
        '@context',
        '@type',
        'name',
        'url',
        'publisher',
        'version',
        'datePublished',
      ].sort(),
    );
    assert.equal(data['@type'], 'WebPage');
    assert.equal(data.url, canonicalUrl(path));
    assert.deepEqual(data.publisher, { '@id': organisationId });
    assert.equal(data.version, revision.rulesVersion);
    assert.equal(data.datePublished, revision.publishedOn);
  }
});
