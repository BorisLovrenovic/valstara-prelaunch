import assert from 'node:assert/strict';
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
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  checkRenderedHead,
  checkSeoBuild,
  collectSeoPages,
  copyMissingCardsFromFallback,
  generateOpenGraphImages,
  generateSitemap,
  socialCardSvg,
} from '../scripts/ci/seo-build-check.ts';
import {
  canonicalUrl,
  childSitemaps,
  sitemapIndexXml,
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
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { readPriceSiteInputs } from '../src/server/prices/files.ts';
import { createPriceSite } from '../src/server/prices/site.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (image: Buffer) =>
  createHash('sha256').update(image).digest('hex');

// E11.6-10: the price route's pages come from the price data, so a fixture
// copy of the pages carries the data files the route reads: the repository's
// own, or the price-page fixture dataset.
async function copyPriceData(
  fixture: string,
  source: 'repository' | 'price-fixture' = 'repository',
): Promise<void> {
  await mkdir(join(fixture, 'config'), { recursive: true });
  await mkdir(join(fixture, 'data/price-index'), { recursive: true });
  const fixtures = join(root, 'test/fixtures/price-index/pages');
  const files: [string, string, string][] =
    source === 'repository'
      ? [
          ['config/catalogue.json', root, 'config/catalogue.json'],
          ['config/markets.json', root, 'config/markets.json'],
          [
            'data/price-index/published-urls.json',
            root,
            'data/price-index/published-urls.json',
          ],
          [
            'data/price-index/changes.json',
            root,
            'data/price-index/changes.json',
          ],
          ['config/valstara-prices.json', root, 'config/valstara-prices.json'],
        ]
      : [
          ['config/catalogue.json', fixtures, 'catalogue.json'],
          ['config/markets.json', fixtures, 'markets.json'],
          ['data/price-index/latest.json', fixtures, 'latest.json'],
          [
            'data/price-index/published-urls.json',
            fixtures,
            'published-urls.json',
          ],
          ['data/price-index/changes.json', fixtures, 'changes.json'],
          ['config/valstara-prices.json', fixtures, 'valstara-prices.json'],
          // E11.6-13: the fixture's two monthly reports.
          [
            'data/price-index/monthly/2026-09.json',
            fixtures,
            'monthly/2026-09.json',
          ],
          [
            'data/price-index/monthly/2026-10.json',
            fixtures,
            'monthly/2026-10.json',
          ],
        ];
  // The repository's data has no monthly report yet.
  await rm(join(fixture, 'data/price-index/monthly'), {
    recursive: true,
    force: true,
  });
  for (const [target, from, name] of files) {
    await mkdir(dirname(join(fixture, target)), { recursive: true });
    await cp(join(from, name), join(fixture, target));
  }
}

test('the build fixture rejects missing metadata, duplicate metadata and a new uncovered page', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'valstara-seo-'));
  try {
    await cp(join(root, 'src/pages'), join(fixture, 'src/pages'), {
      recursive: true,
    });
    await cp(join(root, 'src/content'), join(fixture, 'src/content'), {
      recursive: true,
    });
    await copyPriceData(fixture);
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

test('sitemap routes reconcile with page files and include only the current rules revision', async () => {
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
      file.endsWith('/verify.astro') ||
      file === 'src/pages/partners/dashboard.astro' ||
      file === 'src/pages/partners/dashboard/flyer.astro' ||
      file.endsWith('/404.astro') ||
      file.endsWith('/500.astro') ||
      // The price routes have their own child sitemaps (E11.6-10, E11.6-12).
      file.startsWith('src/pages/prices/') ||
      // E11.8-01: the Trust Ledger follows its flag, so it is listed only by
      // its own child sitemap, served on request.
      file === 'src/pages/trust-ledger.astro'
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
  const currentVersion = 'VAL-GW-LAUNCH-20261126-r1';
  assert.ok(revisions.includes(currentVersion));
  eligiblePaths.push(`/giveaway/rules/${currentVersion}`);
  assert.ok(routes.includes(`/giveaway/rules/${currentVersion}`));
  for (const version of revisions.filter((value) => value !== currentVersion))
    assert.ok(!routes.includes(`/giveaway/rules/${version}`));
  // E11.6-10: the site's own routes moved, unchanged, to pages.xml.
  const sitemap = await readFile(
    join(root, 'public/sitemaps/pages.xml'),
    'utf8',
  );
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
  assert.ok(pageFiles.includes('src/pages/trust-ledger.astro'));
  assert.ok(!routes.includes('/trust-ledger'));
  assert.ok(pageFiles.includes('src/pages/partners/dashboard.astro'));
  assert.ok(!routes.includes('/partners/dashboard'));
  // E11.7-11: the print flyer is private too.
  assert.ok(pageFiles.includes('src/pages/partners/dashboard/flyer.astro'));
  assert.ok(!routes.includes('/partners/dashboard/flyer'));
  // E11.5-10: the branded error pages are noindex and never in the sitemap.
  assert.ok(pageFiles.includes('src/pages/404.astro'));
  assert.ok(pageFiles.includes('src/pages/500.astro'));
  assert.ok(!routes.includes('/404'));
  assert.ok(!routes.includes('/500'));
  assert.ok(!generatedUrls.some((url) => /\/(?:404|500)$/u.test(url)));
});

test('sitemap excludes r2 when r10 is published on the same day', () => {
  const r2 = 'VAL-GW-LAUNCH-20261009-r2';
  const r10 = 'VAL-GW-LAUNCH-20261009-r10';
  const routes = sitemapPaths(
    ['src/pages/giveaway/rules/index.astro'],
    [r10, r2],
  );
  assert.ok(routes.includes(`/giveaway/rules/${r10}`));
  assert.ok(!routes.includes(`/giveaway/rules/${r2}`));
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
    'Disallow: /partners/dashboard',
  ]);
  // The noindex error pages stay crawlable: a disallowed page's noindex is
  // never read (E11.5-10).
  for (const publicRoute of [
    '/404',
    '/500',
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

test('the branded 404 and 500 pages are built noindex and send no page view', async () => {
  await ensureAppBuild();
  for (const page of ['404', '500']) {
    const html = await readFile(join(root, `dist/client/${page}.html`), 'utf8');
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/u.exec(html)?.[1] ?? '';
    assert.equal(
      [...head.matchAll(/<meta name="robots" content="noindex">/gu)].length,
      1,
      `${page} is noindex`,
    );
    assert.doesNotMatch(html, /page-view\.js/u, `${page} sends no page view`);
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
      {
        ...revision,
        sha256: '',
        html: '',
        revision: 1,
        prizeCount: 5,
        prizeApproxRetailValueEur: 300,
      },
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
    // A service × market card sets its price line in the monospace token.
    await cp(
      join(root, 'public/fonts/jetbrains-mono-latin-wght-normal.woff'),
      join(fixture, 'public/fonts/jetbrains-mono-latin-wght-normal.woff'),
    );
    await copyPriceData(fixture);
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
    // Every page has its own card, the price pages included (E11.6-14),
    // except a ledger URL that publishes no page.
    const unavailable = new Set(
      createPriceSite(await readPriceSiteInputs(fixture))
        .routes.filter((route) => route.kind === 'unavailable')
        .map((route) => route.path),
    );
    for (const page of pages.filter(
      ({ pathname }) => !unavailable.has(pathname),
    )) {
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
  await ensureAppBuild();
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

// E11.6-10: the sitemap index, the price sitemap and the price pages in the
// E9-06 and E9-07 checks.

test('the committed /sitemap.xml is an index over pages.xml and the price sitemap', async () => {
  const index = await readFile(join(root, 'public/sitemap.xml'), 'utf8');
  assert.equal(index, sitemapIndexXml());
  assert.deepEqual(
    [...index.matchAll(/<sitemap><loc>([^<]+)<\/loc><\/sitemap>/gu)].map(
      (match) => match[1],
    ),
    [
      'https://valstara.com/sitemaps/pages.xml',
      'https://valstara.com/sitemaps/prices-service-market.xml',
      // E11.6-12: `/prices`, the service hubs and the market hubs.
      'https://valstara.com/sitemaps/prices-index.xml',
      'https://valstara.com/sitemaps/prices-service-hubs.xml',
      'https://valstara.com/sitemaps/prices-market-hubs.xml',
      // E11.6-13: the monthly reports.
      'https://valstara.com/sitemaps/price-index-monthly.xml',
      // E11.8-01: the Trust Ledger's, served on request.
      'https://valstara.com/sitemaps/trust-ledger.xml',
    ],
  );
  assert.deepEqual(Object.values(childSitemaps), [
    '/sitemaps/pages.xml',
    '/sitemaps/prices-service-market.xml',
    '/sitemaps/prices-index.xml',
    '/sitemaps/prices-service-hubs.xml',
    '/sitemaps/prices-market-hubs.xml',
    '/sitemaps/price-index-monthly.xml',
    '/sitemaps/trust-ledger.xml',
  ]);
});

async function priceFixture(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), 'valstara-seo-prices-'));
  await cp(join(root, 'src/pages'), join(fixture, 'src/pages'), {
    recursive: true,
  });
  await cp(join(root, 'src/content'), join(fixture, 'src/content'), {
    recursive: true,
  });
  await copyPriceData(fixture, 'price-fixture');
  return fixture;
}

test('the build writes the price sitemap from the data: generated pages only, each with its verification date', async () => {
  const fixture = await priceFixture();
  try {
    await generateSitemap(fixture);
    const prices = await readFile(
      join(fixture, 'public', childSitemaps.pricesServiceMarket),
      'utf8',
    );
    assert.deepEqual(
      [
        ...prices.matchAll(
          /<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/url>/gu,
        ),
      ].map(([, loc, lastmod]) => [loc, lastmod]),
      [
        ['https://valstara.com/prices/apple-music/sweden', '2026-11-21'],
        ['https://valstara.com/prices/duolingo/france', '2026-11-26'],
        ['https://valstara.com/prices/netflix/sweden', '2026-11-25'],
        ['https://valstara.com/prices/netflix/united-states', '2026-11-27'],
        ['https://valstara.com/prices/spotify/france', '2026-11-22'],
        ['https://valstara.com/prices/spotify/sweden', '2026-11-28'],
        ['https://valstara.com/prices/spotify/united-kingdom', '2026-11-28'],
        ['https://valstara.com/prices/spotify/united-states', '2026-11-27'],
      ],
    );
    // The unavailable ledger URLs are noindex, and absent.
    assert.doesNotMatch(
      prices,
      /chatgpt|crunchyroll|finland|apple-music\/united-states/u,
    );
    // E11.6-13: the monthly reports have their own child sitemap, each dated
    // by the build of the snapshot it reports, not the site's build date.
    const monthly = await readFile(
      join(fixture, 'public', childSitemaps.priceIndexMonthly),
      'utf8',
    );
    assert.deepEqual(
      [
        ...monthly.matchAll(
          /<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/url>/gu,
        ),
      ].map(([, loc, lastmod]) => [loc, lastmod]),
      [
        ['https://valstara.com/price-index/2026-09', '2026-09-29'],
        ['https://valstara.com/price-index/2026-10', '2026-10-30'],
      ],
    );
    // The site's own routes keep exactly the committed pages.xml.
    assert.equal(
      await readFile(join(fixture, 'public', childSitemaps.pages), 'utf8'),
      await readFile(join(root, 'public', childSitemaps.pages), 'utf8'),
    );
    assert.equal(
      await readFile(join(fixture, 'public/sitemap.xml'), 'utf8'),
      sitemapIndexXml(),
    );
    // With the repository's data (no latest.json yet), the price sitemap is
    // an empty set.
    await copyPriceData(fixture);
    await rm(join(fixture, 'data/price-index/latest.json'));
    await generateSitemap(fixture);
    assert.doesNotMatch(
      await readFile(
        join(fixture, 'public', childSitemaps.pricesServiceMarket),
        'utf8',
      ),
      /<url>/u,
    );
    // And with no monthly report, so is the monthly sitemap.
    assert.doesNotMatch(
      await readFile(
        join(fixture, 'public', childSitemaps.priceIndexMonthly),
        'utf8',
      ),
      /<url>/u,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('every generated price page has its own card, and an unavailable ledger URL takes the typed prices card', async () => {
  const fixture = await priceFixture();
  try {
    const { pages } = await collectSeoPages(fixture);
    const prices = pages.filter((page) => page.pathname.startsWith('/prices/'));
    assert.deepEqual(
      prices.map((page) => page.pathname),
      [
        '/prices/apple-music/sweden',
        '/prices/apple-music/united-states',
        '/prices/chatgpt/united-kingdom',
        '/prices/crunchyroll/sweden',
        '/prices/duolingo/france',
        '/prices/netflix/sweden',
        '/prices/netflix/united-states',
        '/prices/spotify/finland',
        '/prices/spotify/france',
        '/prices/spotify/sweden',
        '/prices/spotify/united-kingdom',
        '/prices/spotify/united-states',
        // E11.6-12: the service and market hubs the data makes.
        '/prices/apple-music',
        '/prices/countries/france',
        '/prices/countries/sweden',
        '/prices/countries/united-kingdom',
        '/prices/countries/united-states',
        '/prices/duolingo',
        '/prices/netflix',
        '/prices/spotify',
      ],
    );
    assert.ok(
      prices.every((page) => socialPageKind(page.pathname) === 'prices'),
    );
    // E11.6-13: the methodology and the monthly reports are price pages.
    const priceIndexPages = pages.filter(
      (page) =>
        page.pathname === '/price-index' ||
        page.pathname.startsWith('/price-index/'),
    );
    assert.deepEqual(
      priceIndexPages.map((page) => page.pathname),
      ['/price-index', '/price-index/2026-10', '/price-index/2026-09'],
    );
    assert.ok(
      priceIndexPages.every(
        (page) => socialPageKind(page.pathname) === 'prices',
      ),
    );
    assert.ok(socialPageKinds.includes('prices'));
    await checkSeoBuild(fixture);

    await cp(
      join(root, 'src/styles/tokens.css'),
      join(fixture, 'src/styles/tokens.css'),
    );
    await cp(join(root, 'public/fonts'), join(fixture, 'public/fonts'), {
      recursive: true,
    });
    await generateOpenGraphImages(fixture);
    const cardPath = (pathname: string) =>
      join(
        fixture,
        'public',
        new URL(socialImageUrl(pathname)).pathname.slice(1),
      );
    const fallbackPath = join(fixture, 'public/images/og/fallback/prices.png');
    const fallback = await readFile(fallbackPath);
    const fallbackMetadata = await sharp(fallback).metadata();
    assert.deepEqual(
      [fallbackMetadata.width, fallbackMetadata.height],
      [1200, 630],
    );
    // The ledger URLs the fixture data publishes no page for.
    const unavailable = [
      '/prices/apple-music/united-states',
      '/prices/chatgpt/united-kingdom',
      '/prices/crunchyroll/sweden',
      '/prices/spotify/finland',
    ];
    const own = [
      ...prices,
      ...priceIndexPages,
      ...pages.filter((page) => page.pathname === '/prices'),
    ].filter((page) => !unavailable.includes(page.pathname));
    assert.equal(own.length, 20);
    const digests = new Set<string>();
    for (const page of own) {
      const card = await readFile(cardPath(page.pathname));
      const metadata = await sharp(card).metadata();
      assert.equal(metadata.format, 'png', page.pathname);
      assert.deepEqual(
        [metadata.width, metadata.height],
        [1200, 630],
        page.pathname,
      );
      assert.notEqual(digest(card), digest(fallback), page.pathname);
      digests.add(digest(card));
    }
    assert.equal(digests.size, own.length, 'each price page has its own card');
    for (const pathname of unavailable) {
      await assert.rejects(
        readFile(cardPath(pathname)),
        { code: 'ENOENT' },
        `${pathname} publishes no page, so it has no card of its own`,
      );
    }

    // At postbuild, a page without its own card (an unavailable ledger URL,
    // or a generated page whose card is lost) is given the typed prices card.
    await cp(
      join(fixture, 'public/images'),
      join(fixture, 'dist/client/images'),
      {
        recursive: true,
      },
    );
    const lost = '/prices/netflix/sweden';
    await rm(
      join(
        fixture,
        'dist/client',
        new URL(socialImageUrl(lost)).pathname.slice(1),
      ),
    );
    const copied = await copyMissingCardsFromFallback(fixture, pages);
    assert.deepEqual(copied.toSorted(), [...unavailable, lost].toSorted());
    for (const pathname of [...unavailable, lost]) {
      assert.equal(
        digest(
          await readFile(
            join(
              fixture,
              'dist/client',
              new URL(socialImageUrl(pathname)).pathname.slice(1),
            ),
          ),
        ),
        digest(fallback),
        pathname,
      );
    }

    // A further data route without its expansion fails the build check.
    // E11.6-12's hubs took `prices/[service]/index.astro`, so the planted
    // route is one no ticket builds.
    await mkdir(join(fixture, 'src/pages/prices/regions'), {
      recursive: true,
    });
    await writeFile(
      join(fixture, 'src/pages/prices/regions/[region].astro'),
      '<main></main>',
    );
    await assert.rejects(checkSeoBuild(fixture), /route expansion is missing/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('the rendered-head check refuses a duplicate price title and a missing prices fallback', () => {
  const head = (path: string, title: string, fallback: string) =>
    `<html><head><title>${title}</title><meta name="description" content="${title} description"><link rel="canonical" href="${canonicalUrl(path)}"><meta property="og:image" content="${socialImageUrl(path)}"><meta property="og:image" content="${fallback}"><meta name="twitter:card" content="summary_large_image"></head></html>`;
  const seen = { titles: new Set<string>(), descriptions: new Set<string>() };
  const prices = socialFallbackImageUrl('prices');
  checkRenderedHead(
    head('/prices/spotify/sweden', 'Spotify', prices),
    '/prices/spotify/sweden',
    seen,
  );
  assert.throws(
    () =>
      checkRenderedHead(
        head('/prices/spotify/norway', 'Spotify', prices),
        '/prices/spotify/norway',
        seen,
      ),
    /title is missing or duplicated/u,
  );
  assert.throws(
    () =>
      checkRenderedHead(
        head(
          '/prices/netflix/sweden',
          'Netflix',
          socialFallbackImageUrl('campaign'),
        ),
        '/prices/netflix/sweden',
        seen,
      ),
    /social card metadata is missing/u,
  );
});
