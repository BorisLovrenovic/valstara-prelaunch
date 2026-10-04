import { seoCopy } from '../copy/seo.ts';
import type { RulesRevision } from './giveaway/rules.ts';

export const siteOrigin = 'https://valstara.com';
export const organisationId = `${siteOrigin}/#organization`;

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
      !route.startsWith('/api/') &&
      !route.includes('['),
  );
  for (const version of versions)
    publicRoutes.push(`/giveaway/rules/${version}`);
  return [...new Set(publicRoutes)].sort();
}
