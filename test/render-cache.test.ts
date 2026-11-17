import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { landingFlagGeneration } from '../src/server/cache/landing.ts';
import {
  createRenderCache,
  landingReferralField,
  renderCacheMaxEntries,
  serveCachedRender,
  type RenderCacheLocals,
} from '../src/server/cache/render.ts';
import {
  campaignFlagKeys,
  campaignFlagRegistry,
} from '../src/server/flags/registry.ts';
import type { Flag } from '../src/server/flags/types.ts';
import { createReferralCaptureService } from '../src/server/referral/capture.ts';
import { renderLanding } from './helpers/landing-render.mjs';

// QA gate 7 (G7-1-I4), founder decision 2026-11-14 on E11-01: the origin
// render cache for referral-link landings and the /leaderboard page.

const secret = 'landing-rendered-page-referral-secret';
const at = new Date('2026-11-14T09:00:00.000Z');
const defaults: readonly Flag[] = campaignFlagKeys.map((key) => ({
  enabled: campaignFlagRegistry[key],
  key,
}));
interface RenderedPage {
  readonly body: string;
  readonly cacheControl: string | null;
  readonly flagGeneration: string | null;
  readonly setCookie: string | null;
  readonly vary: string | null;
}

/** The helper returns one page for one path and an array for several. */
async function renderPages(
  options: Parameters<typeof renderLanding>[0],
): Promise<readonly RenderedPage[]> {
  return (await renderLanding(options)) as RenderedPage[];
}

const fieldPattern =
  /name="referral_capture"\s+type="hidden"\s+value="([^"]+)"/u;

function withFlag(
  flags: readonly Flag[],
  key: Flag['key'],
  enabled: boolean,
): readonly Flag[] {
  return flags.map((flag) => (flag.key === key ? { ...flag, enabled } : flag));
}

/**
 * A stand-in for the Astro page: it reads the same flags, signs the same
 * field, reports both through locals and counts its renders.
 */
function fakeSite(initialFlags: readonly Flag[]) {
  let flags = initialFlags;
  let tick = 0;
  // Each signature gets a later issue time, as each real request would.
  const referral = createReferralCaptureService(secret, {
    clock: () => new Date(at.getTime() + (tick += 1_000)),
  });
  const cache = createRenderCache();
  let renders = 0;
  async function request(path: string) {
    const url = new URL(path, 'https://valstara.com');
    const locals: RenderCacheLocals = {};
    return serveCachedRender(
      { method: 'GET', url, locals },
      async () => {
        renders += 1;
        const field = landingReferralField(referral, url, flags);
        locals.renderCache = {
          generation: landingFlagGeneration(flags),
          field,
        };
        const leaderboard = flags.find(
          (flag) => flag.key === 'leaderboard.public',
        )?.enabled;
        return new Response(
          `<main data-render="${renders}" data-leaderboard="${String(leaderboard)}">${
            field === null
              ? ''
              : `<input name="referral_capture" type="hidden" value="${field}" />`
          }</main>`,
          {
            headers: {
              'Cache-Control': 'private, no-store',
              'Content-Type': 'text/html',
            },
          },
        );
      },
      { cache, flags: async () => flags, referral },
    );
  }
  return {
    cache,
    request,
    referral,
    get renders() {
      return renders;
    },
    setFlags(next: readonly Flag[]) {
      flags = next;
    },
  };
}

before(async () => {
  await ensureAppBuild();
});

test('a cached and an uncached render are identical apart from the signed field', async () => {
  // A fresh server: each path's first request renders, the repeat is served
  // from the cache. Headers and body must match byte for byte once the
  // signed field is set aside.
  const paths = [
    '/?ref=ABCDEFGHJKMN&utm_source=newsletter',
    '/?ref=ABCDEFGHJKMN&utm_source=newsletter',
    '/',
    '/',
    '/leaderboard',
    '/leaderboard',
  ];
  const responses = await renderPages({ paths });
  for (let index = 0; index < paths.length; index += 2) {
    const uncached = responses[index];
    const cached = responses[index + 1];
    assert.ok(uncached && cached);
    const strip = (body: string) =>
      body.replace(fieldPattern, 'name="referral_capture" type="hidden"');
    assert.equal(
      strip(cached.body),
      strip(uncached.body),
      `${paths[index]} differs beyond the signed field`,
    );
    assert.equal(cached.cacheControl, uncached.cacheControl);
    assert.equal(cached.vary, uncached.vary);
    assert.equal(cached.flagGeneration, uncached.flagGeneration);
    assert.equal(cached.setCookie, null);
  }
  const [referred, referredAgain, plain, , page] = responses;
  assert.ok(referred && referredAgain && plain && page);
  const first = fieldPattern.exec(referred.body)?.[1];
  const second = fieldPattern.exec(referredAgain.body)?.[1];
  assert.ok(first && second, 'both referral landings carry the field');
  const verifier = createReferralCaptureService(secret);
  for (const field of [first, second])
    assert.deepEqual(verifier.verifyRef(field), {
      ref: 'ABCDEFGHJKMN',
      utm: { source: 'newsletter' },
    });
  // The headers stay exactly as E12-05 set them.
  assert.equal(referred.cacheControl, 'private, no-store');
  assert.equal(plain.cacheControl, 'public, max-age=0, s-maxage=300');
  assert.equal(page.cacheControl, 'private, no-store');
  assert.doesNotMatch(plain.body, /name="referral_capture"/u);
});

test('requests with different codes each get their own valid field', async () => {
  const site = fakeSite(defaults);
  const codes = ['ABCDEFGHJKMN', 'PQRSTUVWXYZ2', 'ABCDEFGHJKM3'];
  const fields: string[] = [];
  for (const code of codes) {
    const response = await site.request(`/?ref=${code}&utm_campaign=${code}`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const field = fieldPattern.exec(await response.text())?.[1];
    assert.ok(field, code);
    fields.push(field);
  }
  assert.equal(site.renders, 1, 'one render serves every referral code');
  assert.equal(new Set(fields).size, codes.length);
  codes.forEach((code, index) =>
    assert.deepEqual(site.referral.verifyRef(fields[index] ?? null), {
      ref: code,
      utm: { campaign: code },
    }),
  );

  // Rendered end to end too: two codes from one server, each verifying.
  const responses = await renderPages({
    paths: ['/?ref=ABCDEFGHJKMN', '/?ref=PQRSTUVWXYZ2'],
  });
  const verifier = createReferralCaptureService(secret);
  assert.deepEqual(
    verifier.verifyRef(
      fieldPattern.exec(responses[0]?.body ?? '')?.[1] ?? null,
    ),
    { ref: 'ABCDEFGHJKMN', utm: null },
  );
  assert.deepEqual(
    verifier.verifyRef(
      fieldPattern.exec(responses[1]?.body ?? '')?.[1] ?? null,
    ),
    { ref: 'PQRSTUVWXYZ2', utm: null },
  );
});

// QA gate 7 run 2: the cache replays every stored response header, and the
// test above uses codes of equal length. A cache hit whose field is shorter or
// longer than the stored render's must still arrive complete, so a framing
// header carried over from the first render (Content-Length) cannot truncate
// or stall it.
test('a cache hit whose signed field differs in length arrives complete', async () => {
  const longCode = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const paths = [
    '/?ref=A',
    `/?ref=${longCode}&utm_source=a-much-longer-utm-source`,
    '/?ref=AB',
  ];
  const responses = await renderPages({ paths });
  const verifier = createReferralCaptureService(secret);
  const expected = [
    { ref: 'A', utm: null },
    { ref: longCode, utm: { source: 'a-much-longer-utm-source' } },
    { ref: 'AB', utm: null },
  ];
  const fields = responses.map((response, index) => {
    assert.match(
      response.body.trimEnd(),
      /<\/html>$/u,
      `${paths[index]} arrived complete`,
    );
    const field = fieldPattern.exec(response.body)?.[1] ?? null;
    assert.deepEqual(verifier.verifyRef(field), expected[index]);
    return field ?? '';
  });
  // The second and third requests are cache hits on the first one's render.
  assert.ok(
    new Set(fields.map((field) => field.length)).size === fields.length,
    'the three signed fields differ in length',
  );
});

test('a flag change re-renders', async () => {
  const site = fakeSite(defaults);
  const enabledBody = await (await site.request('/leaderboard')).text();
  await site.request('/leaderboard');
  assert.equal(site.renders, 1);
  assert.match(enabledBody, /data-leaderboard="true"/u);

  // The kill switch: a new generation renders afresh, never the old body.
  site.setFlags(withFlag(defaults, 'leaderboard.public', false));
  const disabled = await (await site.request('/leaderboard')).text();
  assert.equal(site.renders, 2);
  assert.match(disabled, /data-leaderboard="false"/u);
  await site.request('/leaderboard');
  assert.equal(site.renders, 2);

  // referral.enabled off: the landing drops the field, under its own key.
  await site.request('/?ref=ABCDEFGHJKMN');
  assert.equal(site.renders, 3);
  site.setFlags(
    withFlag(
      withFlag(defaults, 'leaderboard.public', false),
      'referral.enabled',
      false,
    ),
  );
  const unreferred = await (await site.request('/?ref=ABCDEFGHJKMN')).text();
  assert.equal(site.renders, 4);
  assert.doesNotMatch(unreferred, /referral_capture/u);

  // Back to the first state: its stored body serves again.
  site.setFlags(defaults);
  assert.equal(await (await site.request('/leaderboard')).text(), enabledBody);
  assert.equal(site.renders, 4);
});

test('the cache does not grow with referral codes', async () => {
  const site = fakeSite(defaults);
  for (let index = 0; index < 500; index += 1) {
    const code = `CODE${String(index).padStart(8, '0')}`;
    await site.request(`/?ref=${code}&utm_content=${code}`);
  }
  await site.request('/');
  await site.request('/?ref=');
  await site.request('/?utm_source=newsletter');
  await site.request('/leaderboard');
  assert.equal(site.renders, 5);
  assert.equal(site.cache.size, 5);

  // Many flag generations still stay inside the fixed bound.
  for (const key of campaignFlagKeys) {
    for (const enabled of [true, false]) {
      site.setFlags(withFlag(defaults, key, enabled));
      await site.request('/?ref=ABCDEFGHJKMN');
      await site.request('/leaderboard');
    }
  }
  assert.ok(site.cache.size <= renderCacheMaxEntries);
});
