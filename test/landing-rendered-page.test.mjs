import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { before } from 'node:test';

import { landingCopy } from '../src/copy/landing.ts';
import { signupFormCopy } from '../src/copy/signup.ts';
import { createReferralCaptureService } from '../src/server/referral/capture.ts';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { giveawayCard, renderLanding } from './helpers/landing-render.mjs';

const executeFile = promisify(execFile);
const projectRoot = new URL('../', import.meta.url).pathname;

// Astro escapes text content the way the HTML spec requires, so copy strings
// carrying an apostrophe or quote reach the page as entities. Assert against
// the escaped form rather than the raw source string.
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function rendersCopy(body, value) {
  return body.includes(escapeHtml(value));
}
const signupOn = { enabled: true, key: 'signup.enabled' };
const signupOff = { enabled: false, key: 'signup.enabled' };

before(async () => {
  await ensureAppBuild();
});

test('with signup.enabled on, the landing page renders the signup form and every section', async () => {
  const { body, setCookie } = await renderLanding({ flags: [signupOn] });

  // The form posts to the signup route with no extra attributes, so the E1-11
  // slice's contract holds and E3-05 can later hydrate exactly this element.
  assert.match(body, /<form action="\/api\/signup" method="post">/u);
  assert.match(body, /name="email"/u);

  // Every visible string comes from the copy layer, not from inline prose.
  assert.ok(rendersCopy(body, landingCopy.hero.heading));
  assert.ok(rendersCopy(body, landingCopy.hero.eyebrow));
  assert.ok(rendersCopy(body, landingCopy.hero.body));
  assert.ok(rendersCopy(body, landingCopy.form.submit));
  assert.ok(rendersCopy(body, landingCopy.catalogue.heading));
  assert.ok(rendersCopy(body, landingCopy.how.heading));
  assert.ok(rendersCopy(body, landingCopy.rewards.heading));
  assert.ok(rendersCopy(body, landingCopy.trust.heading));
  assert.ok(rendersCopy(body, landingCopy.trust.intro));
  for (const promise of landingCopy.trust.promises) {
    assert.ok(rendersCopy(body, promise.title));
    assert.ok(rendersCopy(body, promise.line));
  }
  for (const item of landingCopy.faq.items) {
    assert.ok(rendersCopy(body, item.question));
    assert.ok(rendersCopy(body, item.answer));
  }

  // The paused message is absent while signups are open.
  assert.ok(!rendersCopy(body, landingCopy.paused.heading));

  // A rendered page sets no cookie.
  assert.equal(setCookie, null);
});

test('sections and header targets follow the landing brief in DOM order', async () => {
  const { body } = await renderLanding();
  const anchors = ['join', 'catalogue', 'how', 'rewards', 'guarantee', 'faq'];
  const positions = anchors.map((id) => body.indexOf(`id="${id}"`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  for (const anchor of ['#join', '#how', '#rewards', '#guarantee', '#faq']) {
    assert.ok(body.includes(`href="${anchor}"`), anchor);
  }
  assert.ok(body.indexOf(landingCopy.trustLinks.heading) > positions[4]);
  assert.ok(body.indexOf(landingCopy.final.heading) > positions[5]);
});

test('the four read-only flags remove only their own landing surfaces', async () => {
  const allOn = await renderLanding({
    flags: [{ key: 'giveaway.open', enabled: true }],
  });
  assert.match(allOn.body, /data-referral-card/u);
  assert.match(allOn.body, /data-giveaway-card/u);
  assert.match(allOn.body, /href="\/leaderboard"/u);
  assert.ok(allOn.body.includes(landingCopy.rewards.freeEntry));
  assert.match(giveawayCard(allOn.body), /5 prizes, approximately €300 each/u);

  const referralOff = await renderLanding({
    flags: [{ key: 'referral.enabled', enabled: false }],
  });
  assert.doesNotMatch(referralOff.body, /data-referral-card/u);
  const giveawayOff = await renderLanding();
  assert.doesNotMatch(giveawayOff.body, /data-giveaway-card/u);
  assert.ok(!giveawayOff.body.includes(landingCopy.rewards.freeEntry));
  const leaderboardOff = await renderLanding({
    flags: [{ key: 'leaderboard.public', enabled: false }],
  });
  assert.doesNotMatch(leaderboardOff.body, /href="\/leaderboard"/u);
});

test(
  'the rendered reward cards follow changed ladder and current-rules fixtures',
  { timeout: 150_000 },
  async () => {
    const flags = [{ key: 'giveaway.open', enabled: true }];
    const [baseline, rulesPage] = await renderLanding({
      flags,
      paths: ['/', '/giveaway/rules'],
    });
    assert.match(
      giveawayCard(baseline.body),
      /5 prizes, approximately €300 each/u,
    );
    assert.match(
      baseline.body,
      /3 confirmed referrals → move up an access wave and 15% off at launch/u,
    );

    const article =
      /<article\b[^>]*data-rules-version="[^"]+"[^>]*data-rules-sha256="[a-f0-9]{64}"[^>]*>([\s\S]*?)<\/article>/u.exec(
        rulesPage.body,
      )?.[1];
    assert.ok(article, 'the current rules article is rendered');
    const revisedArticle = article
      .replace('5 prizes', '4 prizes')
      .replace('€300', '€350')
      .replace('€1,500', '€1,400');
    assert.notEqual(revisedArticle, article);
    const revisedHash = createHash('sha256')
      .update(revisedArticle, 'utf8')
      .digest('hex');
    const root = await mkdtemp(join(tmpdir(), 'valstara-landing-'));
    try {
      for (const path of ['src', 'public']) {
        await cp(join(projectRoot, path), join(root, path), {
          recursive: true,
        });
      }
      for (const path of [
        'astro.config.mjs',
        'package.json',
        'tsconfig.json',
      ]) {
        await cp(join(projectRoot, path), join(root, path));
      }
      await symlink(
        join(projectRoot, 'node_modules'),
        join(root, 'node_modules'),
      );
      const rulesPath = join(
        root,
        'src/content/giveaway-rules/VAL-GW-LAUNCH-20261009-r1.md',
      );
      const rules = await readFile(rulesPath, 'utf8');
      const revisedRules = rules
        .replace('prizeCount: 5', 'prizeCount: 4')
        .replace(
          'prizeApproxRetailValueEur: 300',
          'prizeApproxRetailValueEur: 350',
        )
        .replace('5 prizes', '4 prizes')
        .replace('€300', '€350')
        .replace('€1,500', '€1,400')
        .replace(/sha256: '[a-f0-9]{64}'/u, `sha256: '${revisedHash}'`);
      assert.notEqual(revisedRules, rules);
      await writeFile(rulesPath, revisedRules);
      const configPath = join(root, 'src/server/referral/config.ts');
      const config = await readFile(configPath, 'utf8');
      await writeFile(
        configPath,
        config
          .replace('discountPercent: 15', 'discountPercent: 17')
          .replace('threshold: 3', 'threshold: 4'),
      );
      await executeFile(
        join(projectRoot, 'node_modules/.bin/astro'),
        ['build'],
        {
          cwd: root,
          env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
          timeout: 120_000,
        },
      );
      const changed = await renderLanding({ flags, root });
      assert.match(
        giveawayCard(changed.body),
        /4 prizes, approximately €350 each/u,
      );
      assert.doesNotMatch(
        giveawayCard(changed.body),
        /5 prizes, approximately €300 each/u,
      );
      assert.match(
        changed.body,
        /4 confirmed referrals → move up an access wave and 17% off at launch/u,
      );
      assert.doesNotMatch(
        changed.body,
        /3 confirmed referrals → move up an access wave and 15% off at launch/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('with signup.enabled off, an honest paused message replaces the form', async () => {
  const { body, setCookie } = await renderLanding({ flags: [signupOff] });

  // The form is gone — not present-but-broken — so nothing can fail on submit.
  assert.ok(!/<form action="\/api\/signup"/u.test(body));
  assert.ok(!body.includes('name="email"'));
  assert.ok(
    !body.includes('data-dock'),
    'flag-off renders no sticky signup bar',
  );

  // The paused copy comes from the copy layer and names no machinery.
  assert.ok(rendersCopy(body, landingCopy.paused.heading));
  assert.ok(rendersCopy(body, landingCopy.paused.body));

  assert.equal(setCookie, null);
});

test('free-entry disclosure appears beside the signup action when the giveaway is open', async () => {
  const open = await renderLanding({
    flags: [signupOn, { enabled: true, key: 'giveaway.open' }],
  });
  const disclosure = open.body.indexOf(signupFormCopy.freeEntryDisclosure);
  const button = open.body.lastIndexOf(landingCopy.form.submit, disclosure);
  const rulesLink = open.body.indexOf('href="/giveaway/rules"', disclosure);
  assert.ok(button >= 0);
  assert.ok(disclosure > button);
  assert.ok(rulesLink > disclosure);
  assert.ok(rulesLink - button < 600);
  assert.equal(
    open.body.split(signupFormCopy.freeEntryDisclosure).length - 1,
    2,
  );
  assert.ok(rendersCopy(open.body, signupFormCopy.giveawayRulesLink));
  assert.equal(open.setCookie, null);

  const closed = await renderLanding({ flags: [signupOn] });
  assert.ok(!closed.body.includes(signupFormCopy.freeEntryDisclosure));
});

test('there is no separate AMOE POST route', async () => {
  const routes = await readdir(new URL('../src/pages/api/', import.meta.url));
  assert.ok(!routes.some((route) => /^amoe\./u.test(route)));
  await assert.rejects(
    readdir(new URL('../src/pages/api/amoe/', import.meta.url)),
    { code: 'ENOENT' },
  );
});

test('the landing page ships only the theme toggle and signup form islands', async () => {
  // Measured from the built-and-served output. The landing page carries two
  // islands — the theme toggle (its inline bootstrap plus its island script) and
  // the signup form (E3-05) — plus the first-party page-view emitter (E10-01)
  // and Cloudflare's Turnstile loader. Every script must fit an approved
  // source; a third island or a stray script fails.
  const { body } = await renderLanding({ flags: [signupOn] });

  const scripts = [
    ...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu),
  ].map(([, attributes, content]) => ({ attributes, content }));
  const theme = scripts.filter((script) =>
    script.content.includes('valstara-theme'),
  );
  const signupIsland = scripts.filter((script) =>
    /SignupForm\.astro[^"']*\.js/u.test(script.attributes),
  );
  const turnstileLoader = scripts.filter((script) =>
    script.attributes.includes('challenges.cloudflare.com/turnstile'),
  );
  const pageView = scripts.filter((script) =>
    script.attributes.includes('src="/page-view.js"'),
  );
  const structuredData = scripts.filter((script) =>
    script.attributes.includes('type="application/ld+json"'),
  );

  assert.equal(theme.length, 2, 'the two theme-toggle scripts ship');
  assert.equal(signupIsland.length, 1, 'exactly one signup form island ships');
  assert.equal(turnstileLoader.length, 1, 'the Turnstile loader ships once');
  assert.equal(
    pageView.length,
    1,
    'the first-party page-view emitter ships once',
  );
  assert.equal(
    structuredData.length,
    1,
    'one inert Organisation JSON-LD block ships',
  );
  assert.equal(JSON.parse(structuredData[0].content)['@type'], 'Organization');
  assert.equal(
    scripts.length,
    theme.length +
      signupIsland.length +
      turnstileLoader.length +
      pageView.length +
      structuredData.length,
    'no other script ships (no third island)',
  );

  // No hydrated framework island is introduced, and no client directive leaks.
  assert.ok(!/client:(?:load|idle|visible|media|only)/u.test(body));
});

test('the landing cache header follows flag state and a ref, from the rendered page', async () => {
  // Default flag state, no ref: the page is edge-cacheable by flag generation.
  const [cacheable, referred] = await renderLanding({
    paths: ['/', '/?ref=signed-ref'],
  });
  assert.equal(cacheable.cacheControl, 'public, max-age=0, s-maxage=300');
  assert.equal(cacheable.vary, 'X-Valstara-Flag-Generation');
  assert.match(cacheable.flagGeneration ?? '', /^[a-f0-9]{16}$/u);

  // A signed referral is per-request and must never be served from cache.
  assert.equal(referred.cacheControl, 'private, no-store');

  // A non-default flag state must bypass the cache too — otherwise a stale edge
  // copy outlives a flag flip. `giveaway.open` defaults off, so turning it on is
  // a non-default state: this proves the
  // bypass is driven by the flag generation itself, and it fails if the page
  // stops consulting `hasNonDefaultFlagState`.
  const flagged = await renderLanding({
    flags: [{ enabled: true, key: 'giveaway.open' }],
  });
  assert.equal(flagged.cacheControl, 'private, no-store');
  assert.match(flagged.body, /<form action="\/api\/signup" method="post">/u);
});

test('referral.enabled off omits the signed attribution field without pausing signup', async () => {
  const { body } = await renderLanding({
    flags: [signupOn, { enabled: false, key: 'referral.enabled' }],
    paths: ['/?ref=ABCDEF123456&utm_source=newsletter'],
  });
  assert.match(body, /<form action="\/api\/signup" method="post">/u);
  assert.doesNotMatch(body, /name="referral_capture"/u);
});

test('a landing ?ref= request renders a valid server-signed form field', async () => {
  const { body } = await renderLanding({
    paths: ['/?ref=ABCDEFGHJKMN&utm_source=newsletter'],
  });
  const signed =
    /name="referral_capture"\s+type="hidden"\s+value="([^"]+)"/u.exec(
      body,
    )?.[1];
  assert.ok(signed, 'the signed referral field is present');
  assert.deepEqual(
    createReferralCaptureService(
      'landing-rendered-page-referral-secret',
    ).verifyRef(signed),
    { ref: 'ABCDEFGHJKMN', utm: { source: 'newsletter' } },
  );
});
