import { campaignFlagRegistry } from '../flags/registry.ts';
import type { Flag } from '../flags/types.ts';
import type { ReferralCaptureService } from '../referral/capture.ts';

import { landingFlagGeneration } from './landing.ts';

/**
 * The origin render cache (QA gate 7, G7-1-I4; founder decision 2026-11-14 on
 * E11-01). Referral-link landings and the /leaderboard page are private,
 * no-store renders that reach the origin on every view. This cache renders
 * each page once per flag generation and serves the stored body, with each
 * request's own freshly signed referral field substituted, so a referral
 * spike costs the box a lookup and an HMAC rather than a page render.
 *
 * It changes no response header and holds no visitor data: the key is the
 * route, whether the page carries a signed field, whether the URL has a `ref`
 * parameter (which decides the landing's Cache-Control), and the flag
 * generation. It never grows with distinct referral codes.
 */

/** What a cacheable page reports about its own render, through locals. */
export interface RenderCacheReport {
  readonly generation: string;
  /** The signed referral field the page rendered, or null for none. */
  readonly field: string | null;
}

export interface RenderCacheLocals {
  renderCache?: RenderCacheReport;
}

interface CachedRender {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  /** One part when the page has no field; else the body around the field. */
  readonly parts: readonly [string] | readonly [string, string];
}

/** A bound well above the five variants one flag generation can produce. */
export const renderCacheMaxEntries = 16;

export interface RenderCache {
  get(key: string): CachedRender | undefined;
  set(key: string, value: CachedRender): void;
  readonly size: number;
}

/** A least-recently-used map with a fixed entry bound. */
export function createRenderCache(
  maxEntries: number = renderCacheMaxEntries,
): RenderCache {
  const entries = new Map<string, CachedRender>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry !== undefined) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    get size() {
      return entries.size;
    },
  };
}

function flagEnabled(
  flags: readonly Flag[],
  key: keyof typeof campaignFlagRegistry,
): boolean {
  return (
    flags.find((flag) => flag.key === key)?.enabled ?? campaignFlagRegistry[key]
  );
}

/**
 * The landing's signed referral form field for this request, or null. The
 * landing page and the cache both call this, so the field a cached body
 * receives is exactly the one a fresh render would have signed.
 */
export function landingReferralField(
  service: Pick<ReferralCaptureService, 'capture' | 'signRef'>,
  url: URL,
  flags: readonly Flag[],
): string | null {
  const capture = service.capture(url);
  return flagEnabled(flags, 'referral.enabled') &&
    (capture.ref !== null || capture.utm !== null)
    ? service.signRef(capture)
    : null;
}

// A signed field is base64url, a dot and base64url: it needs no escaping in
// the attribute it fills, and the cache refuses anything else.
const signedFieldPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export interface RenderCacheRequest {
  readonly method: string;
  readonly url: URL;
  readonly locals: RenderCacheLocals;
}

export interface RenderCacheDependencies {
  readonly cache: RenderCache;
  readonly flags: () => Promise<readonly Flag[]>;
  readonly referral: Pick<ReferralCaptureService, 'capture' | 'signRef'>;
}

function toHeaders(entries: readonly (readonly [string, string])[]): Headers {
  const headers = new Headers();
  for (const [name, value] of entries) headers.append(name, value);
  return headers;
}

function cacheRoute(url: URL): 'landing' | 'leaderboard' | null {
  if (url.pathname === '/') return 'landing';
  if (url.pathname === '/leaderboard') return 'leaderboard';
  return null;
}

/**
 * Serves a GET for `/` or `/leaderboard` from the cache, or renders it with
 * `next` and stores the result. Anything else passes straight to `next`.
 */
export async function serveCachedRender(
  request: RenderCacheRequest,
  next: () => Promise<Response>,
  dependencies: RenderCacheDependencies,
): Promise<Response> {
  const route = cacheRoute(request.url);
  if (request.method !== 'GET' || route === null) return next();

  const flags = await dependencies.flags();
  const generation = landingFlagGeneration(flags);
  const field =
    route === 'landing'
      ? landingReferralField(dependencies.referral, request.url, flags)
      : null;
  if (field !== null && !signedFieldPattern.test(field)) return next();
  const key = [
    route,
    field === null ? 'plain' : 'field',
    request.url.searchParams.has('ref') ? 'ref' : 'no-ref',
    generation,
  ].join('|');

  const cached = dependencies.cache.get(key);
  if (cached !== undefined) {
    const body =
      cached.parts.length === 1
        ? cached.parts[0]
        : `${cached.parts[0]}${field ?? ''}${cached.parts[1]}`;
    return new Response(body, {
      status: cached.status,
      headers: toHeaders(cached.headers),
    });
  }

  const response = await next();
  const contentType = response.headers.get('content-type') ?? '';
  if (
    response.status !== 200 ||
    !contentType.startsWith('text/html') ||
    response.headers.has('set-cookie')
  )
    return response;
  const body = await response.text();
  const headers = [...response.headers.entries()];
  const rendered = new Response(body, {
    status: response.status,
    headers: toHeaders(headers),
  });

  // Store only a render that matches this request's key: the page saw the
  // same flag generation and signed a field exactly when this request needs
  // one. A flag flip between the two reads simply skips the store.
  const report = request.locals.renderCache;
  if (report === undefined || report.generation !== generation) return rendered;
  if ((report.field === null) !== (field === null)) return rendered;
  let parts: CachedRender['parts'];
  if (report.field === null) {
    parts = [body];
  } else {
    if (!signedFieldPattern.test(report.field)) return rendered;
    const split = body.split(report.field);
    if (split.length !== 2) return rendered;
    parts = [split[0] ?? '', split[1] ?? ''];
  }
  dependencies.cache.set(key, { status: response.status, headers, parts });
  return rendered;
}
