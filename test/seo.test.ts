import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  checkSeoBuild,
  collectSeoPages,
  generateOpenGraphImages,
  socialCardSvg,
} from '../scripts/ci/seo-build-check.ts';
import {
  canonicalUrl,
  jsonLd,
  organisationData,
  organisationId,
  rulesPageData,
  socialFallbackImageUrl,
  socialImageUrl,
  socialPageKind,
  socialPageKinds,
  sitemapPaths,
  validatePageMetadata,
} from '../src/server/seo.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const executeFile = promisify(execFile);
const digest = (image: Buffer) =>
  createHash('sha256').update(image).digest('hex');

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

test('the published llms.txt summarizes only existing public routes', async () => {
  const llms = await readFile(join(root, 'public/llms.txt'), 'utf8');
  assert.match(llms, /^# Valstara\n/u);
  for (const path of [
    '/about',
    '/legit',
    '/guarantee',
    '/giveaway/rules',
    '/terms',
    '/privacy',
    '/privacy/storage',
  ]) {
    assert.ok(llms.includes(`https://valstara.com${path}`), path);
  }
  assert.doesNotMatch(llms, /https?:\/\/(?!valstara\.com)/u);
  assert.doesNotMatch(llms, /\/api\/|\/me(?:\b|\/)|\/verify\b/u);
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

test('build generates page-specific PNGs and typed fallback crops from brand tokens', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'valstara-og-'));
  try {
    await cp(join(root, 'src/pages'), join(fixture, 'src/pages'), {
      recursive: true,
    });
    await cp(join(root, 'src/content'), join(fixture, 'src/content'), {
      recursive: true,
    });
    await cp(
      join(root, 'src/styles/tokens.css'),
      join(fixture, 'src/styles/tokens.css'),
    );
    await mkdir(join(fixture, 'public/fonts'), { recursive: true });
    await cp(
      join(root, 'public/fonts/instrument-sans-latin-wght-normal.woff'),
      join(fixture, 'public/fonts/instrument-sans-latin-wght-normal.woff'),
    );
    const { pages } = await collectSeoPages(fixture);
    await generateOpenGraphImages(fixture);

    assert.ok(pages.length > 0);
    const landingImagePath = new URL(socialImageUrl('/')).pathname;
    const termsImagePath = new URL(socialImageUrl('/terms')).pathname;
    assert.notDeepEqual(
      await readFile(join(fixture, 'public', landingImagePath.slice(1))),
      await readFile(join(fixture, 'public', termsImagePath.slice(1))),
      'page titles produce page-specific images',
    );
    const revisions = pages.filter((page) =>
      page.pathname.startsWith('/giveaway/rules/'),
    );
    assert.ok(revisions.length >= 2);
    for (const revision of revisions) {
      const rulesVersion = revision.pathname.split('/').at(-1);
      assert.ok(rulesVersion);
      const svg = socialCardSvg(revision.title, {
        paper: '#fafafa',
        ink: '#101014',
        coral: '#e8654a',
        font: 'Instrument Sans, sans-serif',
      });
      assert.match(
        svg,
        new RegExp(`>…?${rulesVersion}</tspan>`, 'u'),
        `${rulesVersion} must remain intact in the rendered card title`,
      );
    }
    assert.notEqual(
      digest(
        await readFile(
          join(
            fixture,
            'public',
            new URL(socialImageUrl(revisions[0].pathname)).pathname.slice(1),
          ),
        ),
      ),
      digest(
        await readFile(
          join(
            fixture,
            'public',
            new URL(socialImageUrl(revisions[1].pathname)).pathname.slice(1),
          ),
        ),
      ),
      'published revision suffixes remain visible in their cards',
    );
    const originalLanding = await readFile(
      join(fixture, 'public', landingImagePath.slice(1)),
    );
    const tokensPath = join(fixture, 'src/styles/tokens.css');
    const originalTokens = await readFile(tokensPath, 'utf8');
    await cp(
      join(root, 'public/fonts/jetbrains-mono-latin-wght-normal.woff'),
      join(fixture, 'public/fonts/jetbrains-mono-latin-wght-normal.woff'),
    );
    await writeFile(
      tokensPath,
      originalTokens
        .replace(
          "font-family: 'Instrument Sans';",
          "font-family: 'JetBrains Mono';",
        )
        .replaceAll(
          'instrument-sans-latin-wght-normal.woff',
          'jetbrains-mono-latin-wght-normal.woff',
        )
        .replace(
          "--font-sans:\n    'Instrument Sans'",
          "--font-sans:\n    'JetBrains Mono'",
        ),
    );
    await generateOpenGraphImages(fixture);
    assert.notEqual(
      digest(
        await readFile(join(fixture, 'public', landingImagePath.slice(1))),
      ),
      digest(originalLanding),
      'changing the local font and font token changes the rendered pixels',
    );
    for (const page of pages) {
      const imagePath = new URL(socialImageUrl(page.pathname)).pathname;
      const metadata = await sharp(
        join(fixture, 'public', imagePath.slice(1)),
      ).metadata();
      assert.equal(metadata.format, 'png', page.pathname);
      assert.equal(metadata.width, 1200, page.pathname);
      assert.equal(metadata.height, 630, page.pathname);
    }

    for (const kind of socialPageKinds) {
      const fallbackPath = new URL(socialFallbackImageUrl(kind)).pathname;
      const imagePath = join(fixture, 'public', fallbackPath.slice(1));
      const metadata = await sharp(imagePath).metadata();
      assert.equal(metadata.width, 1200, kind);
      assert.equal(metadata.height, 630, kind);
    }

    const landingPath = new URL(socialImageUrl('/')).pathname;
    const landingImage = join(fixture, 'public', landingPath.slice(1));
    const crops = [
      { name: 'Meta and Slack', width: 1200, height: 630 },
      { name: 'X', width: 1200, height: 628 },
      { name: 'LinkedIn', width: 1200, height: 627 },
    ];
    for (const crop of crops) {
      const result = await sharp(landingImage)
        .extract({ left: 0, top: 0, width: crop.width, height: crop.height })
        .png()
        .toBuffer({ resolveWithObject: true });
      assert.equal(result.info.width, crop.width, crop.name);
      assert.equal(result.info.height, crop.height, crop.name);
      assert.ok(result.data.length > 0, crop.name);
    }

    assert.equal(
      socialPageKind('/giveaway/rules/VAL-GW-LAUNCH-20261001-r1'),
      'rules',
    );
    assert.equal(socialPageKind('/privacy/storage'), 'legal');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('a missing page PNG serves the typed fallback through both rendered card layouts', async () => {
  await executeFile('npm', ['run', 'build'], { cwd: root });
  for (const pathname of ['/terms', '/about']) {
    const imageUrl = socialImageUrl(pathname);
    const kind = socialPageKind(pathname);
    const fallbackUrl = socialFallbackImageUrl(kind);
    const imagePath = join(
      root,
      'dist/client',
      new URL(imageUrl).pathname.slice(1),
    );
    const fallbackPath = join(
      root,
      'dist/client',
      new URL(fallbackUrl).pathname.slice(1),
    );
    const htmlPath = join(root, 'dist/client', pathname.slice(1), 'index.html');
    await rm(imagePath);
    try {
      await checkSeoBuild(root, true);
      const head =
        /<head\b[^>]*>([\s\S]*?)<\/head>/u.exec(
          await readFile(htmlPath, 'utf8'),
        )?.[1] ?? '';
      const twitterImage =
        /<meta\s+name="twitter:image"\s+content="([^"]+)"/u.exec(head)?.[1];
      assert.equal(twitterImage, imageUrl);
      assert.deepEqual(await readFile(imagePath), await readFile(fallbackPath));
      assert.ok(head.includes(`content="${fallbackUrl}"`));
    } finally {
      await cp(fallbackPath, imagePath);
    }
  }
});

test('social card SVG escapes the page title and uses supplied token values', () => {
  const svg = socialCardSvg('A <clear> & honest title', {
    paper: '#fafafa',
    ink: '#101014',
    coral: '#e8654a',
    font: 'Instrument Sans, sans-serif',
  });
  assert.match(svg, /A &lt;clear&gt; &amp; honest/u);
  assert.match(svg, />title</u);
  assert.match(svg, /fill="#fafafa"/u);
  assert.match(svg, /fill="#e8654a"/u);
  assert.match(svg, /font-family="Instrument Sans, sans-serif"/u);
  assert.doesNotMatch(svg, /<clear>/u);
});
