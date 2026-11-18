import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRequest,
  isPathOpenable,
  type PageInProgress,
  type RequestFacts,
} from '../../packages/price-index/src/http/request-rule.ts';
import { parseRobots } from '../../packages/price-index/src/http/robots.ts';

// E11.6-04 founder decision 1 of 2026-11-18 (D-025 Q1): every request the
// browser makes goes through one rule that refuses by default.

const origin = 'https://www.youfundceo.com';
const robots = parseRobots('User-agent: *\nAllow: /\nDisallow: /private/\n');
const page: PageInProgress = {
  origin,
  target: `${origin}/countries/sweden`,
  isPathOpenable: (path) => isPathOpenable(robots, path),
};

function facts(overrides: Partial<RequestFacts>): RequestFacts {
  return {
    url: `${origin}/countries/sweden`,
    resourceType: 'document',
    headers: {},
    isNavigation: true,
    isMainFrame: true,
    isRedirect: false,
    ...overrides,
  };
}

const allowed: [string, Partial<RequestFacts>][] = [
  ['the main-frame navigation to the requested page', {}],
  [
    'its reload (same URL, a hash aside)',
    { url: `${origin}/countries/sweden#top` },
  ],
  [
    'a same-host redirect hop',
    { url: `${origin}/countries/sweden/`, isRedirect: true },
  ],
  [
    'a same-host script',
    {
      url: `${origin}/_next/static/chunks/app.js`,
      resourceType: 'script',
      isNavigation: false,
    },
  ],
  [
    'a same-host stylesheet',
    {
      url: `${origin}/_next/static/css/a.css`,
      resourceType: 'stylesheet',
      isNavigation: false,
    },
  ],
  [
    'a same-host fetch',
    {
      url: `${origin}/.well-known/vercel/security/request-challenge`,
      resourceType: 'fetch',
      isNavigation: false,
    },
  ],
  [
    'a same-host XHR',
    { url: `${origin}/x`, resourceType: 'xhr', isNavigation: false },
  ],
];

for (const [name, overrides] of allowed) {
  test(`allowed: ${name}`, () => {
    assert.deepEqual(classifyRequest(facts(overrides), page), { allow: true });
  });
}

const refused: [string, Partial<RequestFacts>, string][] = [
  [
    'a Next.js prefetch (_rsc query)',
    {
      url: `${origin}/services?_rsc=1x2y`,
      resourceType: 'fetch',
      isNavigation: false,
    },
    'prefetch',
  ],
  [
    'a fetch with the rsc header',
    {
      url: `${origin}/services`,
      resourceType: 'fetch',
      headers: { rsc: '1' },
      isNavigation: false,
    },
    'prefetch',
  ],
  [
    'a fetch with next-router-prefetch',
    {
      url: `${origin}/services`,
      resourceType: 'fetch',
      headers: { 'next-router-prefetch': '1' },
      isNavigation: false,
    },
    'prefetch',
  ],
  ['a document with the rsc header', { headers: { rsc: '1' } }, 'prefetch'],
  [
    'an image',
    { url: `${origin}/logo.png`, resourceType: 'image', isNavigation: false },
    'resource_type',
  ],
  [
    'a font',
    { url: `${origin}/f.woff2`, resourceType: 'font', isNavigation: false },
    'resource_type',
  ],
  [
    'media',
    { url: `${origin}/v.mp4`, resourceType: 'media', isNavigation: false },
    'resource_type',
  ],
  [
    'a manifest',
    {
      url: `${origin}/manifest.json`,
      resourceType: 'manifest',
      isNavigation: false,
    },
    'resource_type',
  ],
  [
    'an other-type request (link prefetch, ping)',
    { url: `${origin}/countries`, resourceType: 'other', isNavigation: false },
    'resource_type',
  ],
  [
    'an event stream',
    {
      url: `${origin}/events`,
      resourceType: 'eventsource',
      isNavigation: false,
    },
    'resource_type',
  ],
  [
    'a script on another host',
    {
      url: 'https://cdn.example.com/a.js',
      resourceType: 'script',
      isNavigation: false,
    },
    'other_host',
  ],
  [
    'the apex host',
    { url: 'https://youfundceo.com/countries/sweden' },
    'other_host',
  ],
  [
    'plain http',
    { url: 'http://www.youfundceo.com/countries/sweden' },
    'other_host',
  ],
  [
    'another port',
    { url: 'https://www.youfundceo.com:8443/countries/sweden' },
    'other_host',
  ],
  [
    'a script under /api/',
    { url: `${origin}/api/x.js`, resourceType: 'script', isNavigation: false },
    'disallowed_path',
  ],
  [
    'a fetch under /go/',
    { url: `${origin}/go/netflix`, resourceType: 'fetch', isNavigation: false },
    'disallowed_path',
  ],
  [
    'a stylesheet robots.txt disallows',
    {
      url: `${origin}/private/a.css`,
      resourceType: 'stylesheet',
      isNavigation: false,
    },
    'disallowed_path',
  ],
  [
    'a navigation to another page',
    { url: `${origin}/countries/norway` },
    'not_the_requested_page',
  ],
  [
    'a subframe document',
    { url: `${origin}/countries/sweden`, isMainFrame: false },
    'not_the_requested_page',
  ],
  [
    'a document that is not a navigation',
    { isNavigation: false },
    'not_the_requested_page',
  ],
  ['an unparseable URL', { url: 'not a url' }, 'other_host'],
];

for (const [name, overrides, reason] of refused) {
  test(`refused: ${name}`, () => {
    assert.deepEqual(classifyRequest(facts(overrides), page), {
      allow: false,
      reason,
    });
  });
}

test('with no page loading, nothing is allowed, not even the source', () => {
  assert.deepEqual(classifyRequest(facts({}), null), {
    allow: false,
    reason: 'not_the_requested_page',
  });
});
