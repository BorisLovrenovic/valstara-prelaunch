import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('built pages emit unique metadata, permanent canonicals and valid organisation/rules data without changing published article hashes', async () => {
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

  const versions = (await readdir(join(root, 'src/content/giveaway-rules')))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -3));
  const paths = [
    '/',
    '/about',
    '/guarantee',
    '/legit',
    '/terms',
    '/privacy',
    '/privacy/storage',
    '/giveaway/rules',
    ...versions.map((version) => `/giveaway/rules/${version}`),
  ];
  const titles = new Set();
  const descriptions = new Set();
  const structured = new Map();
  for (const path of paths) {
    // The landing and /legit routes are server-rendered. /legit's emitted
    // metadata is checked by the E9-08 rendered-page test.
    if (path === '/' || path === '/legit') continue;
    const html = await readFile(
      join(root, 'dist/client', path, 'index.html'),
      'utf8',
    );
    const title = /<title>([^<]+)<\/title>/u.exec(html)?.[1];
    const description =
      /<meta name="description" content="([^"]+)"\s*\/?\s*>/u.exec(html)?.[1];
    const canonical = /<link rel="canonical" href="([^"]+)"\s*\/?\s*>/u.exec(
      html,
    )?.[1];
    assert.ok(title, path);
    assert.ok(description, path);
    assert.ok(!titles.has(title), `duplicate title at ${path}`);
    assert.ok(
      !descriptions.has(description),
      `duplicate description at ${path}`,
    );
    titles.add(title);
    descriptions.add(description);
    assert.equal(canonical, `https://valstara.com${path}`);
    const jsonLd = [
      ...html.matchAll(
        /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gu,
      ),
    ].map((match) => JSON.parse(match[1]));
    const organisation = jsonLd.find(
      (data) => data['@type'] === 'Organization',
    );
    assert.ok(organisation, `missing Organisation at ${path}`);
    assert.equal(organisation['@context'], 'https://schema.org');
    assert.equal(organisation['@id'], 'https://valstara.com/#organization');
    assert.equal(organisation.url, 'https://valstara.com/');
    if (path.startsWith('/giveaway/rules')) {
      const webPage = jsonLd.find((data) => data['@type'] === 'WebPage');
      assert.ok(webPage, `missing WebPage at ${path}`);
      assert.equal(webPage['@context'], 'https://schema.org');
      assert.equal(webPage.url, canonical);
      assert.deepEqual(webPage.publisher, { '@id': organisation['@id'] });
      assert.deepEqual(
        Object.keys(webPage).sort(),
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
      assert.match(webPage.datePublished, /^\d{4}-\d{2}-\d{2}$/u);
      structured.set(path, webPage);
      const article =
        /<article[^>]*data-rules-version="([^"]+)"[^>]*data-rules-sha256="([a-f0-9]{64})"[^>]*>([\s\S]*?)<\/article>/u.exec(
          html,
        );
      assert.ok(article, `missing rules article at ${path}`);
      assert.equal(webPage.version, article[1]);
      assert.equal(
        createHash('sha256').update(article[3], 'utf8').digest('hex'),
        article[2],
      );
      const source = await readFile(
        join(root, 'src/content/giveaway-rules', `${article[1]}.md`),
        'utf8',
      );
      assert.equal(
        article[2],
        /^sha256: ['"]?([a-f0-9]{64})/mu.exec(source)?.[1],
      );
    }
  }
  assert.equal(structured.size, versions.length + 1);
  for (const version of versions)
    assert.ok(structured.has(`/giveaway/rules/${version}`));

  const sitemap = await readFile(join(root, 'dist/client/sitemap.xml'), 'utf8');
  for (const path of paths)
    assert.ok(sitemap.includes(`<loc>https://valstara.com${path}</loc>`), path);
  assert.ok(!sitemap.includes('<loc>https://valstara.com/me</loc>'));
  assert.ok(!sitemap.includes('<loc>https://valstara.com/verify</loc>'));
});
