import { seoCopy } from '../copy/seo.ts';
import { compareRulesRevisions, type RulesRevision } from './giveaway/rules.ts';

export const siteOrigin = 'https://valstara.com';
export const organisationId = `${siteOrigin}/#organization`;

export const socialPageKinds = [
  'landing',
  'trust',
  'legal',
  'campaign',
  'rules',
  // E11.6-10: the price pages. Each has its own card from E11.6-14; a ledger
  // URL that publishes no page takes this typed fallback.
  'prices',
] as const;
export type SocialPageKind = (typeof socialPageKinds)[number];

function socialPathname(pathname: string): string {
  return pathname === '/' ? '/' : pathname.replace(/\/+$/u, '');
}

export function socialPageKind(pathname: string): SocialPageKind {
  const path = socialPathname(pathname);
  if (path === '/') return 'landing';
  if (['/legit', '/guarantee', '/about'].includes(path)) return 'trust';
  if (['/terms', '/privacy', '/privacy/storage'].includes(path)) return 'legal';
  if (path === '/giveaway/rules' || path.startsWith('/giveaway/rules/')) {
    return 'rules';
  }
  if (path === '/prices' || path.startsWith('/prices/')) return 'prices';
  // E11.6-13: the methodology and the monthly reports are price pages too.
  if (path === '/price-index' || path.startsWith('/price-index/')) {
    return 'prices';
  }
  return 'campaign';
}

function socialImageKey(pathname: string): string {
  return Buffer.from(pathname).toString('base64url');
}

export function socialImageUrl(pathname: string): string {
  return `${siteOrigin}/images/og/${socialImageKey(socialPathname(pathname))}.png`;
}

export function socialFallbackImageUrl(kind: SocialPageKind): string {
  return `${siteOrigin}/images/og/fallback/${kind}.png`;
}

export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c');
}

export function canonicalUrl(pathname: string): string {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) {
    throw new Error(`Invalid canonical pathname: ${pathname}`);
  }
  const permanentPath = pathname === '/' ? '/' : pathname.replace(/\/+$/u, '');
  return new URL(permanentPath, siteOrigin).toString();
}

export function organisationData() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': organisationId,
    name: seoCopy.organisationName,
    legalName: seoCopy.organisationLegalName,
    url: `${siteOrigin}/`,
  } as const;
}

export function rulesPageMetadata(
  revision: Pick<RulesRevision, 'title' | 'description' | 'rulesVersion'>,
  current: boolean,
) {
  const suffix = current
    ? seoCopy.currentRulesSuffix
    : `${seoCopy.revisionRulesPrefix}${revision.rulesVersion}`;
  return {
    title: `${revision.title}${suffix}`,
    description: `${revision.description}${suffix}`,
  };
}

export function rulesPageData(revision: RulesRevision, pathname: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: rulesPageMetadata(
      revision,
      pathname.replace(/\/+$/u, '') === '/giveaway/rules',
    ).title,
    url: canonicalUrl(pathname),
    publisher: { '@id': organisationId },
    version: revision.rulesVersion,
    datePublished: revision.publishedOn,
  } as const;
}

export interface PageMetadata {
  pathname: string;
  title: string;
  description: string;
}

export function validatePageMetadata(
  routes: readonly string[],
  pages: readonly PageMetadata[],
): void {
  const routeSet = new Set(routes);
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  const paths = new Set<string>();
  for (const page of pages) {
    if (!routeSet.has(page.pathname) || paths.has(page.pathname)) {
      throw new Error(
        `SEO metadata has an unknown or duplicate route: ${page.pathname}`,
      );
    }
    paths.add(page.pathname);
    const title = page.title.trim();
    const description = page.description.trim();
    if (
      !title ||
      !description ||
      titles.has(title) ||
      descriptions.has(description)
    ) {
      throw new Error(
        `SEO metadata is missing or duplicated for ${page.pathname}`,
      );
    }
    titles.add(title);
    descriptions.add(description);
  }
  for (const route of routes) {
    if (!paths.has(route))
      throw new Error(`SEO metadata is missing for ${route}`);
  }
}

export function routeFromPageFile(file: string): string | null {
  const relative = file.replace(/\\/gu, '/').replace(/^.*?src\/pages\//u, '');
  if (relative.startsWith('api/') || !relative.endsWith('.astro')) return null;
  const segments = relative.slice(0, -'.astro'.length).split('/');
  if (segments.at(-1) === 'index') segments.pop();
  return `/${segments.join('/')}`;
}

/**
 * The sitemap index (E11.6-10): `/sitemap.xml` lists these child sitemaps.
 * `pages` holds the site's own routes, exactly as `/sitemap.xml` did before;
 * `pricesServiceMarket` the generated service × market price pages. Each
 * kind of hub has its own (E11.6-12): `/prices`, the service hubs and the
 * market hubs, each dated from the newest verification it shows. The monthly
 * reports have their own (E11.6-13), each dated by its snapshot's build.
 */
export const childSitemaps = {
  pages: '/sitemaps/pages.xml',
  pricesServiceMarket: '/sitemaps/prices-service-market.xml',
  pricesIndex: '/sitemaps/prices-index.xml',
  pricesServiceHubs: '/sitemaps/prices-service-hubs.xml',
  pricesMarketHubs: '/sitemaps/prices-market-hubs.xml',
  priceIndexMonthly: '/sitemaps/price-index-monthly.xml',
} as const;

function xmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** A `<urlset>` of permanent URLs, each with its `lastmod` when it has one. */
export function urlsetXml(
  entries: readonly { path: string; lastmod?: string }[],
): string {
  const urls = entries
    .map(
      ({ path, lastmod }) =>
        `  <url><loc>${xmlText(canonicalUrl(path))}</loc>${
          lastmod === undefined ? '' : `<lastmod>${xmlText(lastmod)}</lastmod>`
        }</url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}${urls === '' ? '' : '\n'}</urlset>\n`;
}

/** The `<sitemapindex>` over every child sitemap. */
export function sitemapIndexXml(): string {
  const children = Object.values(childSitemaps)
    .map(
      (path) =>
        `  <sitemap><loc>${xmlText(canonicalUrl(path))}</loc></sitemap>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${children}\n</sitemapindex>\n`;
}

export function sitemapPaths(
  files: readonly string[],
  versions: readonly string[],
): string[] {
  const routes = files
    .map(routeFromPageFile)
    .filter((route): route is string => route !== null);
  const publicRoutes = routes.filter(
    (route) =>
      route !== '/me' &&
      route !== '/verify' &&
      route !== '/partners/dashboard' &&
      // The branded error pages are noindex (E11.5-10).
      route !== '/404' &&
      route !== '/500' &&
      // The price routes come from the price data and have their own child
      // sitemaps (E11.6-10, E11.6-12).
      route !== '/prices' &&
      !route.startsWith('/prices/') &&
      !route.startsWith('/api/') &&
      !route.includes('['),
  );
  const currentVersion = versions
    .map((rulesVersion) => {
      const match = /-(\d{4})(\d{2})(\d{2})-r([1-9]\d*)$/u.exec(rulesVersion);
      if (!match)
        throw new Error(`Invalid giveaway rules version: ${rulesVersion}`);
      return {
        rulesVersion,
        publishedOn: `${match[1]}-${match[2]}-${match[3]}`,
        revision: Number(match[4]),
      };
    })
    .sort(compareRulesRevisions)
    .at(-1)?.rulesVersion;
  if (currentVersion) publicRoutes.push(`/giveaway/rules/${currentVersion}`);
  return [...new Set(publicRoutes)].sort();
}
