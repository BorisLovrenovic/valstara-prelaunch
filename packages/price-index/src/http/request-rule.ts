import type { RobotsRules } from './robots.ts';

// The one rule every request the browser makes goes through (E11.6-04,
// founder decision 1 of 2026-11-18, D-025 Q1). It refuses by default, before
// the request leaves the browser. A captured page load made 35 requests, 13
// of them Next.js link prefetches of other source pages, in parallel; this
// rule is what keeps "one page at a time" true for every request, not only
// for the pages the tool opens.

/**
 * Paths the source's robots.txt disallows for every agent today. They are
 * refused even if a later robots.txt stops listing them (E11.6-04
 * acceptance criteria: nothing under /api/ or /go/ is ever opened).
 */
export const alwaysRefusedPrefixes = ['/api/', '/go/'] as const;

export type RefusalReason =
  | 'other_host'
  | 'disallowed_path'
  | 'prefetch'
  | 'not_the_requested_page'
  | 'resource_type';

/** Whether the tool may request this path and query at all. */
export function isPathOpenable(
  robots: RobotsRules | null,
  pathAndQuery: string,
): boolean {
  if (alwaysRefusedPrefixes.some((prefix) => pathAndQuery.startsWith(prefix))) {
    return false;
  }
  return robots === null || robots.isAllowed(pathAndQuery);
}

export interface RequestFacts {
  url: string;
  /** Playwright's resource type: document, script, stylesheet, fetch, … */
  resourceType: string;
  /** Request headers, names in lower case. */
  headers: Readonly<Record<string, string>>;
  isNavigation: boolean;
  isMainFrame: boolean;
  /** True for a later hop of a redirect chain. */
  isRedirect: boolean;
}

export interface PageInProgress {
  /** The source's origin, e.g. `https://www.youfundceo.com`. */
  origin: string;
  /** The URL the tool asked the browser to open. */
  target: string;
  isPathOpenable(pathAndQuery: string): boolean;
}

export type RequestDecision =
  { allow: true } | { allow: false; reason: RefusalReason };

const sameHostSubresources = new Set(['script', 'stylesheet']);
const sameHostDataRequests = new Set(['fetch', 'xhr']);

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

/**
 * Allowed: the main-frame navigation to the requested URL, and its reload or
 * same-host redirect while the checkpoint completes; same-host scripts and
 * stylesheets; same-host fetch and XHR requests with no `_rsc` query
 * parameter and no `rsc` or `next-router-prefetch` header. Everything else is
 * refused, and so is every request to a path robots.txt disallows.
 */
export function classifyRequest(
  request: RequestFacts,
  page: PageInProgress | null,
): RequestDecision {
  if (page === null) {
    // No page is loading, so nothing may be requested.
    return { allow: false, reason: 'not_the_requested_page' };
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { allow: false, reason: 'other_host' };
  }
  if (url.origin !== page.origin) {
    return { allow: false, reason: 'other_host' };
  }
  if (!page.isPathOpenable(`${url.pathname}${url.search}`)) {
    return { allow: false, reason: 'disallowed_path' };
  }
  if (
    url.searchParams.has('_rsc') ||
    'rsc' in request.headers ||
    'next-router-prefetch' in request.headers
  ) {
    return { allow: false, reason: 'prefetch' };
  }
  if (request.resourceType === 'document') {
    const isRequestedPage =
      request.isNavigation &&
      request.isMainFrame &&
      (request.isRedirect ||
        withoutHash(url) === withoutHash(new URL(page.target)));
    return isRequestedPage
      ? { allow: true }
      : { allow: false, reason: 'not_the_requested_page' };
  }
  if (
    sameHostSubresources.has(request.resourceType) ||
    sameHostDataRequests.has(request.resourceType)
  ) {
    return { allow: true };
  }
  return { allow: false, reason: 'resource_type' };
}
