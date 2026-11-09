import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import axe from 'axe-core';
import sharp from 'sharp';

import { landingCopy } from '../src/copy/landing.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { entranceEnded, scrollSettled } from './helpers/motion.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import {
  checkRegionLayout,
  designWidths,
} from '../scripts/design/layout-checks.mjs';

// E11.5-11f built the guarantee band, "Get to know Valstara", the FAQ and the
// final call to action from the wireframes; E11.5-11p restyles them to the
// final-design canvas (Main.dc.html, as every landing board places it) and
// adds their motion. Every box is compared with the canvas's own, measured
// from the pinned snapshot by
// test/fixtures/final-ui/measure-closing-geometry.mjs on the self-hosted
// fonts, at rest (a reduced-motion context, design rule 12), with a 1px
// tolerance, in both themes.

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-landing-closing-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const themes = ['light', 'dark'];
const tolerance = 1;
const canvas = JSON.parse(
  await readFile(
    new URL('./fixtures/final-ui/closing-geometry.json', import.meta.url),
    'utf8',
  ),
);
const canvasWidths = [1440, 1024, 768, 390, 320];
const finalList = JSON.parse(
  await readFile(
    new URL('../src/content/landing-final.json', import.meta.url),
    'utf8',
  ),
);
const showcase = JSON.parse(
  await readFile(
    new URL('../src/content/provider-showcase.json', import.meta.url),
    'utf8',
  ),
);

// Every customer-visible string in the four sections, as the canvas draws it.
const frameCopy = {
  bandHeading: 'The Triple Guarantee',
  bandIntro: 'Every order at launch is covered by three promises.',
  promises: [
    [
      'I',
      'Delivered within 24 hours.',
      'Every order is fulfilled by hand, Monday to Friday, within 24 hours of purchase.',
    ],
    [
      'II',
      'Protected, start to finish.',
      '256-bit encryption throughout. PCI-compliant payment handling. Your data is never sold.',
    ],
    [
      'III',
      'Resolved, replaced, or refunded.',
      'If it cannot be resolved, we replace it. If it cannot be replaced, we refund you.',
    ],
  ],
  bandLink: 'Read the guarantee',
  trustHeading: 'Get to know Valstara',
  trustCards: [
    ['/legit', 'Is Valstara legit?', 'See the evidence before you join.'],
    ['/about', 'Who we are', 'Meet the company behind the store.'],
    [
      'mailto:support@valstara.com',
      'Contact us',
      'Email support@valstara.com.',
    ],
  ],
  faqHeading: 'Common questions',
  faq: [
    [
      'What happens when I sign up?',
      'We send one verification link. Click it to confirm your place. Nothing counts until you verify.',
    ],
    [
      'What do you do with my email?',
      'We store it to run your waitlist place and send your verification link and launch updates. Our email providers process it to deliver those messages. Our privacy notice explains how we use and keep it.',
    ],
    [
      'When does Valstara launch?',
      "We're in pre-launch. Join the waitlist and we'll email you when it's ready — we won't promise a date we can't hold.",
    ],
    [
      'Can I leave the waitlist?',
      'Yes. Every email we send carries a one-click unsubscribe.',
    ],
  ],
  ctaHeading: 'Ready when you are',
  ctaAction: 'Join the waitlist',
};

let app;
let browser;
let browserOrigin;
let browserServer;

function near(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not ${expected}`,
  );
}

async function startBrowserServer() {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  browserServer = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      browserContainer,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--publish',
      '127.0.0.1::3000',
      '--volume',
      `${projectRoot}:/work:ro`,
      '--workdir',
      '/work',
      playwrightImage,
      '/work/node_modules/.bin/playwright',
      'run-server',
      '--host',
      '0.0.0.0',
      '--port',
      '3000',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  browserServer.stdout.setEncoding('utf8');
  browserServer.stderr.setEncoding('utf8');
  browserServer.stdout.on('data', (chunk) => {
    output += chunk;
  });
  browserServer.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (let attempt = 0; attempt < 720; attempt += 1) {
    if (output.includes('Listening on'))
      return `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`;
    if (browserServer.exitCode !== null)
      throw new Error(`Playwright server exited.\n${output}`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error(`Playwright server did not start.\n${output}`);
}

before(async () => {
  await ensureAppBuild();
  // No reachable database: every flag falls back to its registered default.
  app = await startAppServer({
    label: 'Landing closing sections test',
    env: () => ({
      ADMIN_CREDENTIAL: 'landing-closing-admin-credential-32-ch',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-closing',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'landing-closing-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'landing-closing-referral-secret',
      RESEND_API_KEY: 'landing-closing-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'landing-closing-turnstile-secret',
    }),
  });
  browserOrigin = `http://host.docker.internal:${app.port}`;
  browser = await chromium.connect(await startBrowserServer());
});

after(async () => {
  await browser?.close();
  await execFileAsync('docker', ['rm', '--force', browserContainer]).catch(
    () => {},
  );
  if (browserServer !== undefined && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
  await app?.stop();
});

// With `supported: false` the page and every stylesheet are served with
// their `(animation-timeline: view())` feature query renamed to a property
// no browser has, so the page renders as a browser without scroll-driven
// animations would: each `@supports` branch for them is false, and each
// `@supports not` branch true.
const scrollTimelineQuery = /\(\s*animation-timeline\s*:\s*view\(\)\s*\)/gu;
const unsupportedQuery = '(-x-unsupported-timeline: view())';
const withoutScrollTimelines = (text) =>
  text.replace(scrollTimelineQuery, unsupportedQuery);

// Opens the landing page. With `motion: true` the page allows motion and the
// hero entrance is let end; otherwise it is at rest (reduced motion, design
// rule 12).
async function openLanding({
  width,
  height = 900,
  colorScheme = 'light',
  javaScriptEnabled = true,
  motion = false,
  supported = true,
}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme,
    javaScriptEnabled,
    reducedMotion: motion ? 'no-preference' : 'reduce',
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.abort(),
  );
  if (!supported)
    await context.route(`${browserOrigin}/**`, async (route) => {
      const response = await route.fetch();
      const type = response.headers()['content-type'] ?? '';
      if (!/text\/(?:html|css)/u.test(type)) return route.fulfill({ response });
      return route.fulfill({
        response,
        body: withoutScrollTimelines(await response.text()),
      });
    });
  const page = await context.newPage();
  await page.goto(browserOrigin);
  await page.evaluate(() => globalThis.document.fonts.ready);
  if (motion) await entranceEnded(page);
  return { context, page };
}

// Every box, in the canvas fixture's shape: each section relative to the
// band, and each element relative to its own section.
function measure(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const relative = (element, from) => {
      if (!element || element.getClientRects().length === 0) return null;
      const rect = element.getBoundingClientRect();
      return [
        rect.left - from.left,
        rect.top - from.top,
        rect.width,
        rect.height,
      ];
    };
    const all = (selector, scope, from) =>
      [...scope.querySelectorAll(selector)]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => relative(element, from));
    // A section's box includes the section gap above it: the build sets it
    // as the section's top margin, the canvas as its top padding. The band
    // pads its own ground and keeps its margin outside, on both.
    const outer = (section) => {
      const rect = section.getBoundingClientRect();
      const gap = Number.parseFloat(getComputedStyle(section).marginTop);
      return new globalThis.DOMRect(
        rect.left,
        rect.top - gap,
        rect.width,
        rect.height + gap,
      );
    };
    const outerBox = (section, from) => {
      const rect = outer(section);
      return [
        rect.left - from.left,
        rect.top - from.top,
        rect.width,
        rect.height,
      ];
    };
    const band = document.querySelector('#guarantee');
    const trust = document.querySelector('#guarantee + section');
    const faq = document.querySelector('#faq');
    const cta = document.querySelector('.landing-final');
    const origin = band.getBoundingClientRect();
    const bandBox = band.getBoundingClientRect();
    const trustBox = outer(trust);
    const faqBox = outer(faq);
    const ctaBox = outer(cta);
    const card = cta.querySelector('.landing-final__card');
    return {
      sections: {
        band: relative(band, origin),
        trust: outerBox(trust, origin),
        faq: outerBox(faq, origin),
        cta: outerBox(cta, origin),
        footerGap:
          document.querySelector('body > footer').getBoundingClientRect().top -
          card.getBoundingClientRect().bottom,
      },
      band: {
        head: relative(band.querySelector('.section__heading'), bandBox),
        heading: relative(band.querySelector('h2'), bandBox),
        intro: relative(band.querySelector('.section__heading p'), bandBox),
        list: relative(band.querySelector('.landing-guarantee'), bandBox),
        promises: all('.landing-promise', band, bandBox),
        numerals: all('.landing-promise__numeral', band, bandBox),
        titles: all('.landing-promise__title', band, bandBox),
        lines: all('.landing-promise__line', band, bandBox),
        link: relative(band.querySelector('.landing-guarantee__link'), bandBox),
        linkIcon: relative(
          band.querySelector('.landing-guarantee__link .text-link__arrow'),
          bandBox,
        ),
        star: relative(band.querySelector('.landing-band__star'), bandBox),
      },
      trust: {
        heading: relative(trust.querySelector('h2'), trustBox),
        grid: relative(trust.querySelector('.landing-trust-links'), trustBox),
        cards: all('.landing-trust-card', trust, trustBox),
        tiles: all('.landing-trust-card .icon-tile', trust, trustBox),
        titles: all('.landing-trust-card__title', trust, trustBox),
        arrows: all('.landing-trust-card__arrow', trust, trustBox),
        lines: all('.landing-trust-card__line', trust, trustBox),
      },
      faq: {
        heading: relative(faq.querySelector('h2'), faqBox),
        card: relative(faq.querySelector('.landing-faq__card'), faqBox),
        items: all('details', faq, faqBox),
        summaries: all('summary', faq, faqBox),
        discs: all('.accordion__disc', faq, faqBox),
        answers: all('details[open] .accordion__content', faq, faqBox),
      },
      cta: {
        card: relative(card, ctaBox),
        text: relative(cta.querySelector('.landing-final__text'), ctaBox),
        heading: relative(cta.querySelector('.landing-final__title'), ctaBox),
        button: relative(cta.querySelector('.landing-final__action'), ctaBox),
        visual: relative(cta.querySelector('.landing-final__visual'), ctaBox),
        banners: all('[data-final-banner]', cta, ctaBox),
        chips: all('[data-final-banner] .provider-banner__logo', cta, ctaBox),
        logos: all('[data-final-banner] img', cta, ctaBox),
      },
    };
  });
}

// Compares a measured structure with the canvas's, box by box: a box within
// 1px on every side, a list item by item, and an element the canvas does not
// draw absent from the build too. Every difference is collected, so one run
// reports them all.
function canvasIssues(actual, expected, label, issues = []) {
  if (expected === null || actual === null || actual === undefined) {
    if ((actual ?? null) !== expected)
      issues.push(`${label} presence: ${JSON.stringify(actual)}`);
    return issues;
  }
  if (typeof expected === 'number') {
    if (Math.abs(actual - expected) > tolerance)
      issues.push(`${label}: ${actual} is not ${expected}`);
    return issues;
  }
  if (Array.isArray(expected) && typeof expected[0] === 'number') {
    if (actual.length !== expected.length)
      issues.push(`${label} box: ${JSON.stringify(actual)}`);
    else
      ['x', 'y', 'w', 'h'].forEach((axis, index) => {
        if (Math.abs(actual[index] - expected[index]) > tolerance)
          issues.push(
            `${label} ${axis}: ${Math.round(actual[index] * 100) / 100} is not ${expected[index]}`,
          );
      });
    return issues;
  }
  if (Array.isArray(expected)) {
    if (actual.length !== expected.length)
      issues.push(`${label} count: ${actual.length} is not ${expected.length}`);
    else
      expected.forEach((item, index) =>
        canvasIssues(actual[index], item, `${label} ${index + 1}`, issues),
      );
    return issues;
  }
  for (const [key, value] of Object.entries(expected))
    canvasIssues(actual[key], value, `${label} ${key}`, issues);
  return issues;
}

// The one place the build differs from the canvas on purpose: below 48rem the
// final call to action's button is full width (E11.5-11f). The canvas's own
// rule says so (`.cta .btn { width: 100% }`), but on the board the button
// sits in the annotation layer's anchor span, which the build does not have
// (final-design rule 3), so the board draws it at its content width. Every
// other side of its box is the canvas's.
function canvasFor(width) {
  const expected = globalThis.structuredClone(canvas.widths[width]);
  if (width < 768) expected.cta.button[2] = expected.cta.text[2];
  return expected;
}

// A token resolved the way the browser resolves it, through a probe element.
function resolveTokens(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const probe = document.createElement('div');
    document.body.append(probe);
    const colour = (token) => {
      probe.style.color = `var(--${token})`;
      return getComputedStyle(probe).color;
    };
    const shadow = (value) => {
      probe.style.boxShadow = value;
      return getComputedStyle(probe).boxShadow;
    };
    const tokens = {
      midnight: colour('midnight'),
      midnightDeep: colour('midnight-deep'),
      onMidnight: colour('on-midnight'),
      onMidnight600: colour('on-midnight-600'),
      onMidnightLine: colour('on-midnight-line'),
      coral: colour('coral'),
      coralLift: colour('coral-lift'),
      ink: colour('ink'),
      ink600: colour('ink-600'),
      surface: colour('surface'),
      shadowBand: shadow('var(--shadow-band)'),
      card: shadow('var(--shadow-1), var(--edge)'),
      cardRaised: shadow('var(--shadow-2), var(--edge)'),
      banner: shadow('var(--shadow-1), var(--banner-edge)'),
      bannerRaised: shadow('var(--shadow-2), var(--banner-edge)'),
      ringNumeral: shadow('var(--ring-numeral)'),
      panelEdge: shadow('var(--inset-on-midnight-line)'),
    };
    probe.remove();
    return tokens;
  });
}

function styles(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const read = (selector) => {
      const element = document.querySelector(selector);
      const css = getComputedStyle(element);
      return {
        font: `${css.fontSize}/${css.lineHeight} ${css.fontWeight}`,
        letterSpacing: css.letterSpacing,
        color: css.color,
        background: css.backgroundColor,
        shadow: css.boxShadow,
        radius: css.borderTopLeftRadius,
        padding: [
          css.paddingTop,
          css.paddingRight,
          css.paddingBottom,
          css.paddingLeft,
        ].map(Number.parseFloat),
        decorationColor: css.textDecorationColor,
        decorationLine: css.textDecorationLine,
      };
    };
    return {
      band: read('#guarantee'),
      intro: read('#guarantee .section__heading p'),
      promise: read('.landing-promise'),
      numeral: read('.landing-promise__numeral'),
      title: read('.landing-promise__title'),
      line: read('.landing-promise__line'),
      link: read('.landing-guarantee__link'),
      star: read('.landing-band__star'),
      trustCard: read('.landing-trust-card'),
      trustTitle: read('.landing-trust-card__title'),
      trustArrow: read('.landing-trust-card__arrow'),
      trustLine: read('.landing-trust-card__line'),
      faqCard: read('.landing-faq__card'),
      summary: read('#faq summary'),
      answer: read('#faq .accordion__content'),
      cta: read('.landing-final__card'),
      ctaHeading: read('.landing-final__title'),
      ctaButton: read('.landing-final__action'),
      banner: read('[data-final-banner]'),
    };
  });
}

test('the four closing sections match the canvas at 1440, 1024, 768, 390 and 320, in both themes, at rest', async () => {
  for (const colorScheme of themes) {
    for (const width of canvasWidths) {
      const { context, page } = await openLanding({ width, colorScheme });
      const where = `${width} ${colorScheme}`;
      assert.deepEqual(
        canvasIssues(await measure(page), canvasFor(width), where),
        [],
      );

      const tokens = await resolveTokens(page);
      const css = await styles(page);
      // The band: midnight ground, on-midnight text, the band shadow (none in
      // light, the 24px 64px band shadow plus edge in dark: its depth).
      assert.equal(css.band.background, tokens.midnight, where);
      assert.equal(css.band.color, tokens.onMidnight, where);
      assert.equal(css.band.shadow, tokens.shadowBand, where);
      if (colorScheme === 'dark') {
        assert.match(css.band.shadow, /0px 24px 64px/u, where);
        assert.match(css.band.shadow, /0px 0px 0px 1px/u, where);
      } else assert.equal(css.band.shadow, 'none', where);
      // Rule-7 rewrite (change log, token delta --on-midnight-600): the
      // supporting line and the promise text are secondary on midnight.
      assert.equal(css.intro.color, tokens.onMidnight600, where);
      assert.equal(css.intro.font, '16px/24px 400', where);
      // The promise panel: midnight-deep, radius 12, the 1px alpha edge,
      // padded 24 (32 from 64rem; 24 32 between 48rem and 64rem).
      assert.equal(css.promise.background, tokens.midnightDeep, where);
      assert.equal(css.promise.radius, '12px', where);
      assert.equal(css.promise.shadow, tokens.panelEdge, where);
      assert.equal(
        css.promise.shadow,
        `${tokens.onMidnightLine} 0px 0px 0px 1px inset`,
        where,
      );
      const panelPad =
        width >= 1024 ? [32, 32] : width >= 768 ? [24, 32] : [24, 24];
      assert.deepEqual(
        css.promise.padding,
        [panelPad[0], panelPad[1], panelPad[0], panelPad[1]],
        where,
      );
      // The numeral ring: --ring-numeral, an inset 1.5px coral ring, coral
      // 32/40 700, round.
      assert.equal(css.numeral.shadow, tokens.ringNumeral, where);
      assert.equal(
        css.numeral.shadow,
        `${tokens.coral} 0px 0px 0px 1.5px inset`,
        where,
      );
      assert.equal(css.numeral.color, tokens.coral, where);
      assert.equal(css.numeral.font, '32px/40px 700', where);
      assert.equal(css.numeral.radius, '999px', where);
      assert.equal(css.title.font, '20px/28px 600', where);
      assert.equal(css.title.letterSpacing, '-0.2px', where);
      assert.equal(css.line.font, '16px/24px 400', where);
      assert.equal(css.line.color, tokens.onMidnight600, where);
      // The on-midnight link: on-midnight text, coral-lift underline.
      assert.equal(css.link.color, tokens.onMidnight, where);
      assert.equal(css.link.decorationColor, tokens.coralLift, where);
      assert.equal(css.link.font, '16px/24px 500', where);
      assert.equal(css.star.color, tokens.coralLift, where);
      // The trust cards: E1 at rest, radius 12, padded 24.
      assert.equal(css.trustCard.shadow, tokens.card, where);
      assert.equal(css.trustCard.background, tokens.surface, where);
      assert.equal(css.trustCard.radius, '12px', where);
      assert.deepEqual(css.trustCard.padding, [24, 24, 24, 24], where);
      assert.equal(css.trustCard.decorationLine, 'none', where);
      assert.equal(css.trustTitle.font, '20px/28px 600', where);
      assert.equal(css.trustTitle.color, tokens.ink, where);
      assert.equal(css.trustArrow.color, tokens.ink600, where);
      assert.equal(css.trustLine.color, tokens.ink600, where);
      assert.equal(css.trustLine.font, '16px/24px 400', where);
      // The FAQ card (rule-7 rewrite: 0 24px → 0 32px from 48rem).
      const faqPad = width < 768 ? 20 : 32;
      assert.deepEqual(css.faqCard.padding, [0, faqPad, 0, faqPad], where);
      assert.equal(css.faqCard.shadow, tokens.card, where);
      assert.equal(css.summary.font, '16px/24px 600', where);
      assert.equal(css.answer.color, tokens.ink600, where);
      // The final call to action: a surface card on the light page (rule-7
      // rewrite: padding 24/32/40 → 24/40/48).
      const ctaPad = width >= 1024 ? 48 : width >= 768 ? 40 : 24;
      assert.deepEqual(css.cta.padding, Array(4).fill(ctaPad), where);
      assert.equal(css.cta.background, tokens.surface, where);
      assert.equal(css.cta.shadow, tokens.card, where);
      assert.equal(css.ctaHeading.font, '24px/32px 600', where);
      assert.equal(css.ctaButton.background, tokens.coral, where);
      // The banners: the catalogue's E1 and banner edge, radius 12.
      assert.equal(css.banner.shadow, tokens.banner, where);
      assert.equal(css.banner.radius, '12px', where);
      await context.close();
    }
  }
});

test('the final call to action banners are the three listed showcase providers, logo only and decorative, hidden on phone', async () => {
  const providers = finalList.banners.map((name) =>
    showcase.find((entry) => entry.name === name),
  );
  assert.equal(providers.length, 3);
  for (const width of [1440, 768, 390]) {
    const { context, page } = await openLanding({ width });
    const banners = await page.$$eval('[data-final-banner]', (elements) =>
      elements.map((element) => ({
        name: element.dataset.finalBanner,
        background: globalThis.getComputedStyle(element).backgroundColor,
        logos: [...element.querySelectorAll('img')].map((img) => ({
          src: img.getAttribute('src'),
          alt: img.getAttribute('alt'),
        })),
        text: element.textContent.trim(),
        shown: element.checkVisibility(),
        focusable: element.tabIndex >= 0,
        hidden: element.closest('[aria-hidden="true"]') !== null,
      })),
    );
    const where = `${width}`;
    assert.deepEqual(
      banners.map((banner) => banner.name),
      finalList.banners,
      where,
    );
    for (const [index, banner] of banners.entries()) {
      const provider = providers[index];
      const hex = provider.brandColor.slice(1);
      const rgb = [0, 2, 4].map((at) =>
        Number.parseInt(hex.slice(at, at + 2), 16),
      );
      assert.equal(banner.background, `rgb(${rgb.join(', ')})`, where);
      // The logo alone: no name, no category, no figure.
      assert.deepEqual(
        banner.logos,
        [{ src: provider.logo, alt: '' }],
        `${banner.name} at ${where}`,
      );
      assert.equal(banner.text, '', `${banner.name} at ${where}`);
      assert.equal(banner.focusable, false, where);
      assert.equal(banner.hidden, true, where);
      assert.equal(banner.shown, width >= 768, `${banner.name} at ${where}`);
    }
    // Netflix is a wordmark, shown at its optical height from the data file.
    const netflix = await page
      .locator('[data-final-banner="Netflix"] img')
      .evaluate((img) => img.getBoundingClientRect().height);
    if (width >= 768) near(netflix, 18, `Netflix wordmark at ${where}`);
    await context.close();
  }
});

test('the numerals, and the rings drawing elements, are hidden from assistive technology, and each promise heading carries its numeral prefix', async () => {
  for (const colorScheme of themes) {
    for (const motion of [false, true]) {
      const { context, page } = await openLanding({
        width: 1440,
        colorScheme,
        motion,
      });
      const where = `${colorScheme}${motion ? ' with motion' : ''}`;
      const list = page.locator('#guarantee ol.landing-guarantee');
      assert.equal(await list.locator(':scope > li').count(), 3, where);
      for (const [numeral, title] of frameCopy.promises) {
        const name = `${numeral}. ${title}`;
        assert.equal(
          await page
            .getByRole('heading', { level: 3, name, exact: true })
            .count(),
          1,
          `${name} (${where})`,
        );
      }
      const tree = await list.ariaSnapshot();
      for (const [numeral, title] of frameCopy.promises)
        assert.ok(
          tree.includes(`heading "${numeral}. ${title}" [level=3]`),
          where,
        );
      // No numeral is read on its own, and nothing of a ring's drawing is in
      // the tree: each ring, its drawing and its digits are aria-hidden.
      const numerals = await page.$$eval('.landing-promise__numeral', (rings) =>
        rings.map((ring) => {
          const draw = ring.querySelector('.landing-promise__draw');
          return [
            ring.getAttribute('aria-hidden'),
            ring.textContent.trim(),
            draw.getAttribute('aria-hidden'),
            draw.getAttribute('focusable'),
            draw.parentElement.closest('[aria-hidden="true"]') === ring,
          ];
        }),
      );
      assert.deepEqual(
        numerals,
        [
          ['true', 'I', 'true', 'false', true],
          ['true', 'II', 'true', 'false', true],
          ['true', 'III', 'true', 'false', true],
        ],
        where,
      );
      assert.doesNotMatch(tree, /text: (I|II|III)$/mu, where);
      assert.doesNotMatch(tree, /img|graphics/u, where);
      // The prefix is clipped to nothing on screen, inside its heading's box.
      const prefixes = await page.$$eval('.landing-promise__prefix', (spans) =>
        spans.map((span) => {
          const css = globalThis.getComputedStyle(span);
          const rect = span.getBoundingClientRect();
          const heading = span.parentElement.getBoundingClientRect();
          return (
            css.clipPath === 'inset(50%)' &&
            rect.left >= heading.left &&
            rect.right <= heading.right &&
            rect.bottom <= heading.bottom
          );
        }),
      );
      assert.deepEqual(prefixes, [true, true, true], where);
      // The star and the banners are decorative.
      assert.equal(
        await page.getAttribute('.landing-band__star', 'aria-hidden'),
        'true',
      );
      assert.equal(
        await page.getAttribute('.landing-final__visual', 'aria-hidden'),
        'true',
      );
      assert.doesNotMatch(
        await page.locator('.landing-final').ariaSnapshot(),
        /img/u,
        where,
      );
      await context.close();
    }
  }
});

// What the numeral's ring paints: the share of each half (left and right)
// of the 64px ring box that shows the ring's coral, read from the screen.
async function ringPainted(page, index) {
  const target = await page.evaluate((at) => {
    const { document, getComputedStyle } = globalThis;
    const ring = document.querySelectorAll('.landing-promise__numeral')[at];
    const box = ring.getBoundingClientRect();
    return {
      clip: { x: box.left, y: box.top, width: box.width, height: box.height },
      coral: getComputedStyle(ring).color,
      panel: getComputedStyle(ring.closest('.landing-promise')).backgroundColor,
    };
  }, index);
  const shot = await page.screenshot({
    clip: target.clip,
    scale: 'css',
    style: '.signup-dock { visibility: hidden !important; }',
  });
  const { data, info } = await sharp(shot)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = (value) => value.match(/\d+/gu).slice(0, 3).map(Number);
  const coral = rgb(target.coral);
  const panel = rgb(target.panel);
  const full = coral.reduce(
    (sum, channel, at) => sum + Math.abs(channel - panel[at]),
    0,
  );
  const halves = [0, 0];
  // The ring's coverage in 24 equal sectors, clockwise from the top.
  const sectors = Array(24).fill(0);
  // Only the ring's own band of pixels, 4px in from the edge, is read.
  const centre = info.width / 2;
  for (let y = 0; y < info.height; y += 1)
    for (let x = 0; x < info.width; x += 1) {
      const dx = x + 0.5 - centre;
      const dy = y + 0.5 - centre;
      const radius = Math.hypot(dx, dy);
      if (radius < centre - 4 || radius > centre) continue;
      const at = (y * info.width + x) * info.channels;
      const distance = coral.reduce(
        (sum, channel, k) => sum + Math.abs(data[at + k] - channel),
        0,
      );
      if (distance > full / 3) continue;
      halves[x < centre ? 0 : 1] += 1;
      const turn = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1;
      sectors[Math.floor(turn * 24)] += 1;
    }
  return { halves, sectors };
}

test('the rings at rest are the E11.5-11f ring exactly, at every width in both themes, and the drawn stroke ends in it', async () => {
  for (const colorScheme of themes) {
    for (const width of canvasWidths) {
      const where = `${width} ${colorScheme}`;
      // Reduced motion, then motion allowed once the ring has drawn (the
      // panel's top at 70% of the viewport height).
      const still = await openLanding({ width, colorScheme });
      const moving = await openLanding({ width, colorScheme, motion: true });
      for (const { page } of [still, moving]) {
        const tokens = await resolveTokens(page);
        for (let index = 0; index < 3; index += 1) {
          await scrollToTop(page, `.landing-promise >> nth=${index}`, 0.7);
          const rest = await page.evaluate((at) => {
            const { document, getComputedStyle } = globalThis;
            const ring = document.querySelectorAll('.landing-promise__numeral')[
              at
            ];
            const circle = ring.querySelector('circle');
            return {
              shadow: getComputedStyle(ring).boxShadow,
              offset: Number.parseFloat(
                getComputedStyle(circle).strokeDashoffset,
              ),
              array: getComputedStyle(circle).strokeDasharray,
              animating: circle
                .getAnimations()
                .some(
                  (animation) =>
                    animation.effect.getComputedTiming().progress !== null,
                ),
            };
          }, index);
          assert.equal(
            rest.shadow,
            `${tokens.coral} 0px 0px 0px 1.5px inset`,
            `${where} ring ${index + 1}`,
          );
          // The drawing element covers nothing at rest.
          assert.equal(rest.offset, -1, `${where} ring ${index + 1}`);
          assert.match(rest.array, /^1(px)?$/u, where);
          assert.equal(rest.animating, false, `${where} ring ${index + 1}`);
        }
      }
      // What is on screen is the same whole ring with and without motion:
      // coral in every 15° sector of the ring's band, and the same amount of
      // it within 5%. (The moving page composites animated elements on their
      // own layers, which can shift antialiasing by a fraction of a pixel.)
      for (let index = 0; index < 3; index += 1) {
        await scrollToTop(still.page, `.landing-promise >> nth=${index}`, 0.5);
        await scrollToTop(moving.page, `.landing-promise >> nth=${index}`, 0.5);
        const a = await ringPainted(still.page, index);
        const b = await ringPainted(moving.page, index);
        const label = `${where} ring ${index + 1}`;
        for (const [name, ring] of [
          ['still', a],
          ['moving', b],
        ])
          assert.ok(
            ring.sectors.every((count) => count > 0),
            `${label} ${name}: whole ${ring.sectors}`,
          );
        const total = (ring) => ring.halves[0] + ring.halves[1];
        assert.ok(
          Math.abs(total(a) - total(b)) <= total(a) * 0.05,
          `${label}: ${total(a)} and ${total(b)} coral pixels`,
        );
      }
      await still.context.close();
      await moving.context.close();
    }
  }
});

test('each trust card is one link with a visible focus state, lifts 2px with its arrow moving 3px, and the contact card opens the support mailbox', async () => {
  for (const colorScheme of themes) {
    for (const width of [1440, 768, 390]) {
      const { context, page } = await openLanding({
        width,
        colorScheme,
        motion: true,
      });
      const tokens = await resolveTokens(page);
      const cards = page.locator('.landing-trust-card');
      assert.equal(await cards.count(), frameCopy.trustCards.length);
      await scrollToTop(page, '.landing-trust-links', 0.3);
      for (const [
        index,
        [href, heading, line],
      ] of frameCopy.trustCards.entries()) {
        const card = cards.nth(index);
        const where = `${heading} at ${width} ${colorScheme}`;
        // The whole card is the anchor, with no link inside it.
        assert.equal(
          await card.evaluate((element) => element.tagName),
          'A',
          where,
        );
        assert.equal(await card.getAttribute('href'), href, where);
        assert.equal(await card.locator('a').count(), 0, where);
        assert.equal(
          await page
            .getByRole('link', { name: `${heading} ${line}`, exact: true })
            .count(),
          1,
          where,
        );
        // The arrow shows at every width (the canvas draws it at 768 too).
        assert.equal(
          await card
            .locator('.landing-trust-card__arrow')
            .evaluate((icon) => icon.checkVisibility()),
          true,
          where,
        );
        // The coral focus outline from the keyboard.
        await card.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        const focused = await card.evaluate((element) => {
          const css = globalThis.getComputedStyle(element);
          return {
            active: globalThis.document.activeElement === element,
            outline: `${css.outlineStyle} ${css.outlineWidth} ${css.outlineColor}`,
            offset: css.outlineOffset,
          };
        });
        assert.equal(focused.active, true, where);
        assert.equal(focused.outline, `solid 2px ${tokens.coral}`, where);
        assert.equal(focused.offset, '2px', where);
        await page.evaluate(() => globalThis.document.activeElement.blur());
        await page.mouse.move(0, 0);
        await page.waitForTimeout(250);
        const lift = () =>
          card.evaluate((element) => {
            const { getComputedStyle, DOMMatrixReadOnly } = globalThis;
            const arrow = element.querySelector('.landing-trust-card__arrow');
            return {
              shadow: getComputedStyle(element).boxShadow,
              y: new DOMMatrixReadOnly(getComputedStyle(element).transform).m42,
              arrowX: new DOMMatrixReadOnly(getComputedStyle(arrow).transform)
                .m41,
            };
          });
        assert.deepEqual(
          await lift(),
          { shadow: tokens.card, y: 0, arrowX: 0 },
          where,
        );
        await card.hover();
        await page.waitForTimeout(250);
        assert.deepEqual(
          await lift(),
          { shadow: tokens.cardRaised, y: -2, arrowX: 3 },
          where,
        );
        await page.mouse.move(0, 0);
      }
      await context.close();
    }
  }
});

test('the first FAQ item is open on load, the others closed, and every answer is at most 68ch wide', async () => {
  for (const colorScheme of themes) {
    for (const width of [1440, 768, 390]) {
      const { context, page } = await openLanding({ width, colorScheme });
      const where = `${width} ${colorScheme}`;
      const items = page.locator('#faq details');
      assert.equal(await items.count(), frameCopy.faq.length, where);
      assert.deepEqual(
        await items.evaluateAll((details) =>
          details.map((element) => element.open),
        ),
        [true, false, false, false],
        where,
      );
      // Open every item, then measure each answer against 68ch of its own
      // font.
      await items.evaluateAll((details) => {
        for (const element of details) element.open = true;
      });
      const measures = await page.$$eval(
        '#faq .accordion__content',
        (answers) =>
          answers.map((answer) => {
            const css = globalThis.getComputedStyle(answer);
            const zero = globalThis.document.createElement('span');
            zero.textContent = '0';
            zero.style.cssText = 'position:absolute;white-space:pre';
            answer.append(zero);
            const ch = zero.getBoundingClientRect().width;
            zero.remove();
            return {
              maxWidth: Number.parseFloat(css.maxWidth),
              width: answer.getBoundingClientRect().width,
              ch,
            };
          }),
      );
      for (const { maxWidth, width: answerWidth, ch } of measures) {
        near(maxWidth, ch * 68, `68ch at ${where}`);
        assert.ok(answerWidth <= ch * 68 + tolerance, where);
      }
      await context.close();
    }
  }
});

test('primary coral appears four times at small widths and three times at medium and large widths', async () => {
  const expected = { 320: 4, 360: 4, 390: 4, 768: 3, 1024: 3, 1440: 3 };
  for (const colorScheme of themes) {
    for (const [width, count] of Object.entries(expected)) {
      const { context, page } = await openLanding({
        width: Number(width),
        height: 844,
        colorScheme,
      });
      // Past the hero and short of the footer, where the small layout's
      // sticky bar shows.
      await page.locator('#faq').scrollIntoViewIfNeeded();
      await page.evaluate(() =>
        globalThis.window.dispatchEvent(new globalThis.Event('scroll')),
      );
      await page.waitForTimeout(250);
      const tokens = await resolveTokens(page);
      const primaries = await page.$$eval('.button--primary', (buttons) =>
        buttons
          .filter((button) => button.checkVisibility())
          .map((button) => ({
            where: button.closest('[data-dock]')
              ? 'sticky bar'
              : button.closest('body > header')
                ? 'header'
                : button.closest('#join')
                  ? 'hero'
                  : button.closest('.landing-final')
                    ? 'final'
                    : 'other',
            background: globalThis.getComputedStyle(button).backgroundColor,
          })),
      );
      const where = `${width} ${colorScheme}`;
      assert.deepEqual(
        primaries.map((primary) => primary.where).sort(),
        (count === 4
          ? ['final', 'header', 'hero', 'sticky bar']
          : ['final', 'header', 'hero']
        ).sort(),
        where,
      );
      for (const primary of primaries)
        assert.equal(primary.background, tokens.coral, where);
      await context.close();
    }
  }
});

test('the final call to action scrolls to #join and focuses the email field, and works as an anchor without JavaScript', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openLanding({ width, motion: true });
    const action = page.locator('.landing-final__action');
    assert.equal(await action.getAttribute('href'), '#join');
    assert.equal((await action.textContent()).trim(), frameCopy.ctaAction);
    // The card reveals on scroll. A scroll-driven animation takes effect on
    // the frame after the scroll, so in the frame Playwright scrolls the
    // button into view the card still has its first keyframe: transparent,
    // 24px down. A click in that frame focuses the button, and the reveal
    // ends at once for the focused card (motion.css), moving it out from
    // under the pointer before the button is released. No one can click a
    // card they cannot yet see, so the click waits for the next frames.
    await action.scrollIntoViewIfNeeded();
    await frames(page);
    await action.click();
    await page.waitForFunction(
      () => globalThis.document.activeElement?.id === 'signup-email',
    );
    const inView = await page.evaluate(() => {
      const rect = globalThis.document
        .querySelector('#signup-email')
        .getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= globalThis.innerHeight;
    });
    assert.equal(inView, true, `field in view at ${width}`);
    await context.close();
  }
  const { context, page } = await openLanding({
    width: 390,
    javaScriptEnabled: false,
  });
  await page.locator('.landing-final__action').click();
  // E11.5-11i named rewrite: anchors scroll smoothly, so the read waits for
  // the scroll to end (polled from outside: JavaScript is disabled here).
  await scrollSettled(page);
  assert.equal(new URL(page.url()).hash, '#join');
  const top = await page.evaluate(() =>
    Math.round(
      globalThis.document.querySelector('#join').getBoundingClientRect().top,
    ),
  );
  assert.ok(Math.abs(top) <= tolerance, `#join at the top: ${top}`);
  await context.close();
});

test('every string in the four sections matches the canvas verbatim and comes from the copy layer', async () => {
  // The copy layer holds the canvas's strings.
  assert.equal(landingCopy.trust.heading, frameCopy.bandHeading);
  assert.equal(landingCopy.trust.intro, frameCopy.bandIntro);
  assert.deepEqual(
    landingCopy.trust.promises.map((promise) => [
      promise.numeral,
      promise.title,
      promise.line,
    ]),
    frameCopy.promises,
  );
  assert.equal(landingCopy.trust.link, frameCopy.bandLink);
  assert.equal(landingCopy.trustLinks.heading, frameCopy.trustHeading);
  assert.deepEqual(
    landingCopy.trustLinks.items.map((item) => [
      item.href,
      item.heading,
      item.line,
    ]),
    frameCopy.trustCards,
  );
  assert.equal(landingCopy.faq.heading, frameCopy.faqHeading);
  assert.deepEqual(
    landingCopy.faq.items.map((item) => [item.question, item.answer]),
    frameCopy.faq,
  );
  assert.equal(landingCopy.final.heading, frameCopy.ctaHeading);
  assert.equal(landingCopy.final.action, frameCopy.ctaAction);

  // And the page renders exactly those strings, in order, with the banners
  // adding none.
  const { context, page } = await openLanding({ width: 1440 });
  const rendered = await page.evaluate(() => {
    const { document } = globalThis;
    const text = (element) => element.textContent.replace(/\s+/gu, ' ').trim();
    const all = (selector) =>
      [...document.querySelectorAll(selector)].map(text);
    return {
      bandHeading: text(document.querySelector('#guarantee h2')),
      bandIntro: text(document.querySelector('#guarantee .section__heading p')),
      numerals: all('.landing-promise__numeral'),
      titles: [...document.querySelectorAll('.landing-promise__title')].map(
        (title) =>
          [...title.childNodes]
            .filter(
              (node) => !node.classList?.contains('landing-promise__prefix'),
            )
            .map((node) => node.textContent)
            .join('')
            .trim(),
      ),
      prefixes: all('.landing-promise__prefix'),
      lines: all('.landing-promise__line'),
      bandLink: text(document.querySelector('.landing-guarantee__link')),
      trustHeading: text(document.querySelector('#trust-links-title')),
      trustTitles: all('.landing-trust-card__title'),
      trustLines: all('.landing-trust-card__line'),
      faqHeading: text(document.querySelector('#faq h2')),
      questions: all('#faq summary'),
      answers: all('#faq .accordion__content'),
      ctaHeading: text(document.querySelector('.landing-final__title')),
      ctaAction: text(document.querySelector('.landing-final__action')),
      ctaCard: document
        .querySelector('.landing-final__card')
        .textContent.replace(/\s+/gu, ''),
    };
  });
  assert.deepEqual(rendered, {
    bandHeading: frameCopy.bandHeading,
    bandIntro: frameCopy.bandIntro,
    numerals: frameCopy.promises.map(([numeral]) => numeral),
    titles: frameCopy.promises.map(([, title]) => title),
    // A space after the full stop, so the heading reads "I. Delivered…".
    prefixes: frameCopy.promises.map(([numeral]) => `${numeral}.`),
    lines: frameCopy.promises.map(([, , line]) => line),
    bandLink: frameCopy.bandLink,
    trustHeading: frameCopy.trustHeading,
    trustTitles: frameCopy.trustCards.map(([, heading]) => heading),
    trustLines: frameCopy.trustCards.map(([, , line]) => line),
    faqHeading: frameCopy.faqHeading,
    questions: frameCopy.faq.map(([question]) => question),
    answers: frameCopy.faq.map(([, answer]) => answer),
    ctaHeading: frameCopy.ctaHeading,
    ctaAction: frameCopy.ctaAction,
    // The card holds the two strings and nothing else: the banners add no
    // text.
    ctaCard: `${frameCopy.ctaHeading}${frameCopy.ctaAction}`.replace(
      /\s+/gu,
      '',
    ),
  });
  await context.close();
});

// Scrolls so the element's top sits at the given fraction of the viewport
// height, then lets the scroll-driven animations update.
async function scrollToTop(page, selector, fraction) {
  await page.locator(selector).evaluate((element, at) => {
    const top = element.getBoundingClientRect().top + globalThis.scrollY;
    globalThis.scrollTo({
      top: top - globalThis.innerHeight * at,
      behavior: 'instant',
    });
  }, fraction);
  await frames(page);
}

async function scrollToEnd(page) {
  await page.evaluate(() =>
    globalThis.scrollTo({
      top: globalThis.document.documentElement.scrollHeight,
      behavior: 'instant',
    }),
  );
  await frames(page);
}

function frames(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve),
        ),
      ),
  );
}

// The motion state of everything in the four sections that may move.
function readMotion(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const state = (element) => {
      const css = getComputedStyle(element);
      return {
        opacity: Number(css.opacity),
        translate: css.translate,
        rotate: css.rotate,
      };
    };
    const all = (selector) =>
      [...document.querySelectorAll(selector)].map(state);
    return {
      offsets: [
        ...document.querySelectorAll('.landing-promise__draw circle'),
      ].map((circle) =>
        Number.parseFloat(getComputedStyle(circle).strokeDashoffset),
      ),
      digits: all('.landing-promise__digits'),
      titles: all('.landing-promise__title'),
      lines: all('.landing-promise__line'),
      panels: all('.landing-promise'),
      band: state(document.querySelector('#guarantee')),
      star: state(document.querySelector('.landing-band__star')),
      bandHead: all('#guarantee .section__heading > *'),
      bandLink: state(document.querySelector('.landing-guarantee__link')),
      trust: all('.landing-trust-card'),
      faq: [
        state(document.querySelector('#faq h2')),
        state(document.querySelector('.landing-faq__card')),
      ],
      card: state(document.querySelector('.landing-final__card')),
      banners: all('[data-final-banner]'),
    };
  });
}

const still = (element) =>
  element.opacity === 1 &&
  ['none', '0px', '0px 0px'].includes(element.translate) &&
  ['none', '0deg'].includes(element.rotate);

function assertAtRest(m, label) {
  assert.deepEqual(m.offsets, [-1, -1, -1], `${label}: rings whole`);
  for (const key of ['digits', 'titles', 'lines', 'panels', 'bandHead'])
    m[key].forEach((element, index) =>
      assert.ok(still(element), `${label}: ${key} ${index + 1} at rest`),
    );
  for (const key of ['band', 'star', 'bandLink', 'card'])
    assert.ok(still(m[key]), `${label}: ${key} at rest`);
  for (const key of ['trust', 'faq', 'banners'])
    m[key].forEach((element, index) =>
      assert.ok(still(element), `${label}: ${key} ${index + 1} at rest`),
    );
}

test('the reveals: the band header and link, the trust cards in order, the FAQ heading and card, the final card, then its banners in order', async () => {
  const { context, page } = await openLanding({ width: 1440, motion: true });
  // Each reveals through data-reveal, in reading order where it shares a row.
  const reveals = await page.evaluate(() => {
    const { document } = globalThis;
    const read = (selector) =>
      [...document.querySelectorAll(selector)].map((element) => [
        element.hasAttribute('data-reveal'),
        element.style.getPropertyValue('--reveal-index').trim(),
        element
          .getAnimations()
          .map((animation) => animation.animationName)
          .join(),
      ]);
    return {
      bandHead: read('#guarantee .section__heading > *'),
      bandLink: read('.landing-guarantee__link'),
      panels: read('.landing-promise'),
      trust: read('.landing-trust-card'),
      faq: read('#faq h2, .landing-faq__card'),
      card: read('.landing-final__card'),
      banners: read('[data-final-banner]'),
    };
  });
  assert.deepEqual(reveals, {
    bandHead: [
      [true, '', 'motion-reveal'],
      [true, '', 'motion-reveal'],
    ],
    bandLink: [[true, '', 'motion-reveal']],
    // The band and its panels do not move.
    panels: [
      [false, '', ''],
      [false, '', ''],
      [false, '', ''],
    ],
    trust: [
      [true, '0', 'motion-reveal'],
      [true, '1', 'motion-reveal'],
      [true, '2', 'motion-reveal'],
    ],
    faq: [
      [true, '', 'motion-reveal'],
      [true, '', 'motion-reveal'],
    ],
    card: [[true, '', 'motion-reveal']],
    banners: [
      [true, '1', 'motion-reveal'],
      [true, '2', 'motion-reveal'],
      [true, '3', 'motion-reveal'],
    ],
  });

  // Partway into the trust row's entry, the cards show in reading order.
  await scrollToTop(page, '.landing-trust-links', 0.93);
  const trust = (await readMotion(page)).trust.map((card) => card.opacity);
  assert.ok(trust[0] > trust[1] && trust[1] > trust[2], `trust ${trust}`);
  // Partway into the final card's entry, the text (the card) leads and the
  // banners follow it, one after another.
  await scrollToTop(page, '.landing-final__card', 0.92);
  const m = await readMotion(page);
  const banners = m.banners.map((banner) => banner.opacity);
  assert.ok(m.card.opacity > banners[0], `card ${m.card.opacity} ${banners}`);
  assert.ok(
    banners[0] > banners[1] && banners[1] > banners[2],
    `banners ${banners}`,
  );
  // The middle banner keeps its 12px raise under the rise.
  await scrollToTop(page, '.landing-final__card', 0.5);
  const raise = await page.$$eval('[data-final-banner]', (elements) =>
    elements.map((element) => element.getBoundingClientRect().top),
  );
  near(raise[0] - raise[1], 12, 'the middle banner is raised');
  near(raise[2], raise[0], 'the outer banners share a top');
  // The banners take the catalogue hover lift: 2px, shadow 1 to shadow 2.
  const tokens = await resolveTokens(page);
  const banner = page.locator('[data-final-banner]').first();
  await banner.hover();
  await page.waitForTimeout(250);
  assert.deepEqual(
    await banner.evaluate((element) => {
      const css = globalThis.getComputedStyle(element);
      return [
        new globalThis.DOMMatrixReadOnly(css.transform).m42,
        css.boxShadow,
      ];
    }),
    [-2, tokens.bannerRaised],
  );
  await page.mouse.move(0, 0);
  // The button has the primary press state: it moves down 1px while held.
  const button = page.locator('.landing-final__action');
  await button.hover();
  await page.mouse.down();
  await page.waitForTimeout(250);
  assert.equal(
    await button.evaluate(
      (element) =>
        new globalThis.DOMMatrixReadOnly(
          globalThis.getComputedStyle(element).transform,
        ).m42,
    ),
    1,
  );
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await context.close();
});

// Sweeps the band's promises through their sequence a pixel at a time and
// returns, for each promise, the scroll steps at which its ring starts and
// finishes drawing and at which its numeral, title and line start and finish
// appearing. The step is the panel's top in pixels above the viewport's
// bottom edge.
async function sweepPromises(page, panel, from, to) {
  const height = await page.evaluate(() => globalThis.innerHeight);
  const marks = Array.from({ length: 3 }, () => ({}));
  for (let up = Math.round(height * from); up <= height * to; up += 1) {
    await scrollToTop(page, panel, 1 - up / height);
    const m = await readMotion(page);
    m.offsets.forEach((offset, index) => {
      const mark = marks[index];
      if (offset !== 0 && mark.ringStart === undefined) mark.ringStart = up;
      if (offset === -1 && mark.ringEnd === undefined) mark.ringEnd = up;
      const shown = [m.digits[index], m.titles[index], m.lines[index]];
      if (shown.some((s) => s.opacity > 0) && mark.textStart === undefined)
        mark.textStart = up;
      if (shown.every(still) && mark.textEnd === undefined) mark.textEnd = up;
      if (mark.ringEnd === undefined && shown.some((s) => s.opacity > 0))
        mark.early = up;
    });
  }
  return { height, marks };
}

test('each ring draws from the top, clockwise, then its numeral, title and line follow, in order I, II, III, at rest by 70%', async () => {
  for (const colorScheme of themes) {
    // From 64rem the panels share a row and the sequence runs across them.
    {
      const { context, page } = await openLanding({
        width: 1440,
        colorScheme,
        motion: true,
      });
      const where = `1440 ${colorScheme}`;
      await scrollToTop(page, '.landing-guarantee', 0.95);
      const before = await readMotion(page);
      assert.deepEqual(before.offsets, [0, 0, 0], `${where}: covered`);
      assert.deepEqual(
        before.digits.map((d) => d.opacity),
        [0, 0, 0],
        where,
      );
      const { height, marks } = await sweepPromises(
        page,
        '.landing-guarantee',
        0.08,
        0.3,
      );
      for (const [index, mark] of marks.entries()) {
        const label = `${where} promise ${index + 1}`;
        for (const key of ['ringStart', 'ringEnd', 'textStart', 'textEnd'])
          assert.notEqual(mark[key], undefined, `${label} ${key}`);
        assert.equal(mark.early, undefined, `${label}: text before its ring`);
        assert.ok(mark.ringEnd <= mark.textStart + 1, label);
        if (index > 0)
          assert.ok(
            marks[index - 1].textEnd <= mark.ringStart + 1,
            `${label} follows ${index}`,
          );
        // At rest by 70% of the viewport height.
        assert.ok(mark.textEnd < height * 0.3, `${label} at rest by 70%`);
      }
      // Mid-draw, the ring shows from the top along the right side only:
      // clockwise from the top. Found by scrolling a pixel at a time into
      // the first ring's step until it is between a fifth and four fifths
      // drawn.
      let found = null;
      for (
        let up = marks[0].ringStart;
        up < marks[0].ringEnd && found === null;
        up += 1
      ) {
        await scrollToTop(page, '.landing-guarantee', 1 - up / height);
        const offset = (await readMotion(page)).offsets[0];
        if (offset < -0.2 && offset > -0.8) found = offset;
      }
      assert.notEqual(found, null, `${where}: a mid-draw frame`);
      const { halves } = await ringPainted(page, 0);
      assert.ok(halves[1] > 20, `${where}: drawn on the right ${halves}`);
      assert.equal(halves[0], 0, `${where}: not yet on the left ${halves}`);
      await context.close();
    }
    // Below 64rem each panel has its own two steps on its own timeline.
    for (const width of [768, 390]) {
      const { context, page } = await openLanding({
        width,
        colorScheme,
        motion: true,
      });
      for (let index = 0; index < 3; index += 1) {
        const where = `${width} ${colorScheme} promise ${index + 1}`;
        const panel = `.landing-promise >> nth=${index}`;
        const height = await page.evaluate(() => globalThis.innerHeight);
        let ringStart;
        let ringEnd;
        let textStart;
        let textEnd;
        for (let up = Math.round(height * 0.08); up <= height * 0.3; up += 1) {
          await scrollToTop(page, panel, 1 - up / height);
          const m = await readMotion(page);
          const offset = m.offsets[index];
          const shown = [m.digits[index], m.titles[index], m.lines[index]];
          if (offset !== 0 && ringStart === undefined) ringStart = up;
          if (offset === -1 && ringEnd === undefined) ringEnd = up;
          if (shown.some((s) => s.opacity > 0) && textStart === undefined)
            textStart = up;
          if (shown.every(still) && textEnd === undefined) textEnd = up;
        }
        for (const [key, value] of Object.entries({
          ringStart,
          ringEnd,
          textStart,
          textEnd,
        }))
          assert.notEqual(value, undefined, `${where} ${key}`);
        assert.ok(ringEnd <= textStart + 1, `${where}: ring, then text`);
        assert.ok(textEnd < height * 0.3, `${where}: at rest by 70%`);
      }
      await context.close();
    }
  }
});

test('the star turns from -45 degrees to rest once, on the band view timeline, at large widths only', async () => {
  const { context, page } = await openLanding({ width: 1440, motion: true });
  const angle = async () => {
    const rotate = (await readMotion(page)).star.rotate;
    return rotate === 'none' ? 0 : Number.parseFloat(rotate);
  };
  await scrollToTop(page, '#guarantee', 1);
  near(await angle(), -45, 'as the band enters');
  await scrollToTop(page, '#guarantee', 0.9);
  const mid = await angle();
  assert.ok(mid > -45 && mid < 0, `turning: ${mid}`);
  await scrollToTop(page, '#guarantee', 0.75);
  assert.equal(await angle(), 0, 'at rest');
  // It turns once: one animation, which runs on the band's view timeline and
  // does not repeat.
  const animation = await page.evaluate(() =>
    globalThis.document
      .querySelector('.landing-band__star')
      .getAnimations()
      .map((running) => [
        running.animationName,
        running.effect.getComputedTiming().iterations,
        running.timeline?.constructor.name,
      ]),
  );
  assert.deepEqual(animation, [['landing-star-turn', 1, 'ViewTimeline']]);
  // Nothing in the four sections loops.
  const loops = await page.evaluate(
    () =>
      globalThis.document
        .getAnimations()
        .filter(
          (running) =>
            running.effect.target.closest(
              '#guarantee, #guarantee + section, #faq, .landing-final',
            ) && running.effect.getComputedTiming().iterations !== 1,
        ).length,
  );
  assert.equal(loops, 0);
  await context.close();
  // Below 64rem there is no star to turn.
  const small = await openLanding({ width: 768, motion: true });
  assert.equal(
    await small.page
      .locator('.landing-band__star')
      .evaluate((star) => star.checkVisibility()),
    false,
  );
  await small.context.close();
});

test('every moving element is at rest by 70% of the viewport height, and at the page end, at every design width in both themes', async () => {
  const owners = [
    '#guarantee h2',
    '#guarantee .section__heading p',
    '.landing-promise >> nth=0',
    '.landing-promise >> nth=1',
    '.landing-promise >> nth=2',
    '.landing-guarantee__link',
    '.landing-band__star',
    '.landing-trust-card >> nth=0',
    '.landing-trust-card >> nth=1',
    '.landing-trust-card >> nth=2',
    '#faq h2',
    '.landing-faq__card',
    '.landing-final__card',
  ];
  for (const colorScheme of themes) {
    for (const width of designWidths) {
      const { context, page } = await openLanding({
        width,
        colorScheme,
        motion: true,
      });
      const where = `${width} ${colorScheme}`;
      for (const owner of owners) {
        const shown = await page
          .locator(owner)
          .evaluate((element) => element.checkVisibility());
        if (!shown) continue;
        await scrollToTop(page, owner, 0.7);
        const m = await readMotion(page);
        const pick = {
          '#guarantee h2': [m.bandHead[0]],
          '#guarantee .section__heading p': [m.bandHead[1]],
          '.landing-guarantee__link': [m.bandLink],
          '.landing-band__star': [m.star],
          '#faq h2': [m.faq[0]],
          '.landing-faq__card': [m.faq[1]],
          '.landing-final__card': [m.card, ...m.banners],
        };
        const index = Number(/nth=(\d)/u.exec(owner)?.[1]);
        const elements = owner.startsWith('.landing-promise')
          ? [m.digits[index], m.titles[index], m.lines[index]]
          : owner.startsWith('.landing-trust-card')
            ? [m.trust[index]]
            : pick[owner];
        for (const element of elements)
          assert.ok(still(element), `${owner} at 70%, ${where}`);
        if (owner.startsWith('.landing-promise'))
          assert.equal(m.offsets[index], -1, `${owner} ring at 70%, ${where}`);
      }
      await scrollToEnd(page);
      assertAtRest(await readMotion(page), `page end, ${where}`);
      await context.close();
    }
  }
});

test('the sticky bar still hides when the footer comes into view, and shows over the closing sections', async () => {
  const { context, page } = await openLanding({
    width: 390,
    height: 844,
    motion: true,
  });
  const dockShown = () =>
    page.evaluate(() =>
      globalThis.document.querySelector('[data-dock]').checkVisibility(),
    );
  await scrollToTop(page, '#faq', 0.3);
  await page.waitForFunction(() =>
    globalThis.document.querySelector('[data-dock]').checkVisibility(),
  );
  assert.equal(await dockShown(), true, 'shown over the FAQ');
  await scrollToEnd(page);
  await page.waitForFunction(
    () => !globalThis.document.querySelector('[data-dock]').checkVisibility(),
  );
  assert.equal(await dockShown(), false, 'hidden with the footer in view');
  await context.close();
});

test('under reduced motion nothing in the four sections moves: every ring whole, every numeral and line shown', async () => {
  for (const colorScheme of themes) {
    for (const width of [1440, 390]) {
      const { context, page } = await openLanding({ width, colorScheme });
      const where = `${width} ${colorScheme}`;
      for (const at of [0.95, 0.85, 0.7]) {
        await scrollToTop(page, '.landing-guarantee', at);
        assertAtRest(await readMotion(page), `${where} at ${at}`);
        await scrollToTop(page, '.landing-final__card', at);
        assertAtRest(await readMotion(page), `${where} at ${at}`);
      }
      const animations = await page.evaluate(
        () =>
          globalThis.document
            .getAnimations()
            .filter((animation) =>
              animation.effect.target.closest(
                '#guarantee, #guarantee + section, #faq, .landing-final',
              ),
            ).length,
      );
      assert.equal(animations, 0, where);
      await context.close();
    }
  }
});

test('with scroll-driven animations unsupported, the four sections are at rest: every ring whole, every numeral and line shown', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openLanding({
      width,
      motion: true,
      supported: false,
    });
    // No live feature query is left for scroll-driven animations.
    const live = await page.evaluate(() =>
      [...globalThis.document.styleSheets].some((sheet) =>
        [...sheet.cssRules].some((rule) =>
          /animation-timeline:\s*view\(\)/u.test(rule.conditionText ?? ''),
        ),
      ),
    );
    assert.equal(live, false, `${width}`);
    for (const at of [0.95, 0.85, 0.7]) {
      await scrollToTop(page, '.landing-guarantee', at);
      assertAtRest(await readMotion(page), `${width} at ${at}`);
      await scrollToTop(page, '.landing-final__card', at);
      assertAtRest(await readMotion(page), `${width} at ${at}`);
    }
    const animated = await page.evaluate(() =>
      globalThis.document
        .getAnimations()
        .filter((animation) =>
          animation.effect.target.closest(
            '#guarantee, #guarantee + section, #faq, .landing-final',
          ),
        )
        .map((animation) => animation.animationName),
    );
    assert.deepEqual(animated, [], `${width}`);
    await context.close();
  }
});

test('the four closing sections pass the layout checks at every design width, in both themes', async () => {
  for (const colorScheme of themes) {
    for (const width of designWidths) {
      const { context, page } = await openLanding({ width, colorScheme });
      assert.deepEqual(
        await checkRegionLayout(page, [
          '#guarantee',
          '#guarantee + section',
          '#faq',
          '.landing-final',
        ]),
        [],
        `layout, ${colorScheme}, ${width}px`,
      );
      await context.close();
    }
  }
});

async function closingAxe(page) {
  await page.addScriptTag({ content: axe.source });
  const violations = [];
  for (const selector of [
    '#guarantee',
    '#guarantee + section',
    '#faq',
    '.landing-final',
  ]) {
    const found = await page.evaluate(
      async (scope) =>
        (
          await globalThis.axe.run(globalThis.document.querySelector(scope), {
            runOnly: {
              type: 'tag',
              values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
            },
          })
        ).violations.map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => node.target.join(' ')),
        })),
      selector,
    );
    violations.push(...found.map((item) => ({ selector, ...item })));
  }
  return violations;
}

test('the four closing sections pass WCAG axe in both themes, at rest and once the motion is over', async () => {
  for (const colorScheme of themes) {
    for (const width of [1440, 768, 390]) {
      for (const motion of [false, true]) {
        const { context, page } = await openLanding({
          width,
          colorScheme,
          motion,
        });
        if (motion) await scrollToEnd(page);
        assert.deepEqual(
          await closingAxe(page),
          [],
          `${width} ${colorScheme}${motion ? ' after the motion' : ''}`,
        );
        await context.close();
      }
    }
  }
});
