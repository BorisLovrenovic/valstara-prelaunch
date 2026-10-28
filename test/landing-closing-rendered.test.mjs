import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import axe from 'axe-core';

import { landingCopy } from '../src/copy/landing.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

// E11.5-11f: the guarantee band, "Get to know Valstara", the FAQ and the
// final call to action from Main.dc.html, Tablet.dc.html and Phone.dc.html.
// Every number below is the frame's: each frame was rendered on the
// self-hosted fonts with its annotation layer off, and these boxes were read
// from it. Text widths are left to the font (null); every position, every
// line count (through the heights) and every other size is asserted, with a
// 1px tolerance.

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-landing-closing-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const themes = ['light', 'dark'];
const tolerance = 1;

// Each entry: [origin selector, element selector, boxes as [x, y, w, h]
// relative to the origin's top-left]. An empty list means not rendered.
const band = '#guarantee';
const trust = '.landing-trust-links';
const faq = '#faq';
const cta = '.landing-final__card';
const frames = {
  1440: {
    band: [band, band, [[0, 0, 1440, 516]]],
    promises: [band, '.landing-guarantee', [[120, 176, 1200, 196]]],
    promise: [
      band,
      '.landing-promise',
      [
        [120, 176, 384, 196],
        [528, 176, 384, 196],
        [936, 176, 384, 196],
      ],
    ],
    numeral: [
      band,
      '.landing-promise__numeral',
      [
        [120, 176, 64, 64],
        [528, 176, 64, 64],
        [936, 176, 64, 64],
      ],
    ],
    title: [
      band,
      '.landing-promise__title',
      [
        [120, 260, null, 28],
        [528, 260, null, 28],
        [936, 260, null, 28],
      ],
    ],
    // At most 340px wide at large widths.
    line: [
      band,
      '.landing-promise__line',
      [
        [120, 300, 340, 48],
        [528, 300, 340, 72],
        [936, 300, 340, 48],
      ],
    ],
    link: [band, '.landing-guarantee__link', [[120, 412, null, 24]]],
    star: [band, '.landing-band__star', [[1264, 80, 16, 24]]],
    trustSection: [band, `${band} + section`, [[0, 596, 1440, 228]]],
    trustGrid: [trust, trust, [[0, 0, 1200, 164]]],
    trustCard: [
      trust,
      '.landing-trust-card',
      [
        [0, 0, 384, 164],
        [408, 0, 384, 164],
        [816, 0, 384, 164],
      ],
    ],
    trustTile: [
      trust,
      '.landing-trust-card .icon-tile',
      [
        [24, 24, 40, 40],
        [432, 24, 40, 40],
        [840, 24, 40, 40],
      ],
    ],
    trustTitle: [
      trust,
      '.landing-trust-card__title',
      [
        [24, 76, null, 28],
        [432, 76, null, 28],
        [840, 76, null, 28],
      ],
    ],
    trustArrow: [
      trust,
      '.landing-trust-card__arrow',
      [
        [null, 82, 16, 16],
        [null, 82, 16, 16],
        [null, 82, 16, 16],
      ],
    ],
    trustLine: [
      trust,
      '.landing-trust-card__line',
      [
        [24, 116, null, 24],
        [432, 116, null, 24],
        [840, 116, null, 24],
      ],
    ],
    faq: [`${band} + section`, faq, [[0, 308, 1440, 307]]],
    // Columns 1-4 and 5-12 of the 12-column grid.
    faqHeading: [faq, `${faq} h2`, [[120, 0, 384, 32]]],
    faqCard: [faq, '.landing-faq__card', [[528, 0, 792, 307]]],
    faqItem: [
      faq,
      `${faq} details`,
      [
        [552, 0, 744, 112],
        [552, 112, 744, 65],
        [552, 177, 744, 65],
        [552, 242, 744, 65],
      ],
    ],
    faqSummary: [
      faq,
      `${faq} summary`,
      [
        [552, 0, 744, 64],
        [552, 113, 744, 64],
        [552, 178, 744, 64],
        [552, 243, 744, 64],
      ],
    ],
    faqAnswer: [
      faq,
      `${faq} details[open] .accordion__content`,
      [[552, 64, 744, 48]],
    ],
    cta: [faq, cta, [[120, 387, 1200, 128]]],
    ctaHeading: [cta, '.landing-final__title', [[40, 48, null, 32]]],
    ctaButton: [cta, '.landing-final__action', [[null, 40, null, 48]]],
  },
  768: {
    band: [band, band, [[0, 0, 768, 552]]],
    promises: [band, '.landing-guarantee', [[32, 160, 704, 248]]],
    promise: [
      band,
      '.landing-promise',
      [
        [32, 160, 218.7, 248],
        [274.7, 160, 218.7, 248],
        [517.3, 160, 218.7, 248],
      ],
    ],
    numeral: [
      band,
      '.landing-promise__numeral',
      [
        [32, 160, 64, 64],
        [274.7, 160, 64, 64],
        [517.3, 160, 64, 64],
      ],
    ],
    title: [
      band,
      '.landing-promise__title',
      [
        [32, 244, 218.7, 56],
        [274.7, 244, 218.7, 56],
        [517.3, 244, 218.7, 56],
      ],
    ],
    line: [
      band,
      '.landing-promise__line',
      [
        [32, 312, 218.7, 72],
        [274.7, 312, 218.7, 96],
        [517.3, 312, 218.7, 72],
      ],
    ],
    // 32px below the list, with 12px above and below its 24px line.
    link: [band, '.landing-guarantee__link', [[32, 440, null, 48]]],
    star: [band, '.landing-band__star', []],
    trustSection: [band, `${band} + section`, [[0, 616, 768, 252]]],
    trustGrid: [trust, trust, [[0, 0, 704, 188]]],
    trustCard: [
      trust,
      '.landing-trust-card',
      [
        [0, 0, 218.7, 188],
        [242.7, 0, 218.7, 188],
        [485.3, 0, 218.7, 188],
      ],
    ],
    trustTile: [
      trust,
      '.landing-trust-card .icon-tile',
      [
        [24, 24, 40, 40],
        [266.7, 24, 40, 40],
        [509.3, 24, 40, 40],
      ],
    ],
    trustTitle: [
      trust,
      '.landing-trust-card__title',
      [
        [24, 76, null, 28],
        [266.7, 76, null, 28],
        [509.3, 76, null, 28],
      ],
    ],
    // Medium draws no arrow.
    trustArrow: [trust, '.landing-trust-card__arrow', []],
    trustLine: [
      trust,
      '.landing-trust-card__line',
      [
        [24, 116, 170.7, 48],
        [266.7, 116, 170.7, 48],
        [509.3, 116, 170.7, 48],
      ],
    ],
    faq: [`${band} + section`, faq, [[0, 316, 768, 395]]],
    faqHeading: [faq, `${faq} h2`, [[32, 0, 704, 32]]],
    faqCard: [faq, '.landing-faq__card', [[32, 64, 704, 331]]],
    faqItem: [
      faq,
      `${faq} details`,
      [
        [56, 64, 656, 136],
        [56, 200, 656, 65],
        [56, 265, 656, 65],
        [56, 330, 656, 65],
      ],
    ],
    faqSummary: [
      faq,
      `${faq} summary`,
      [
        [56, 64, 656, 64],
        [56, 201, 656, 64],
        [56, 266, 656, 64],
        [56, 331, 656, 64],
      ],
    ],
    faqAnswer: [
      faq,
      `${faq} details[open] .accordion__content`,
      [[56, 128, 656, 72]],
    ],
    cta: [faq, cta, [[32, 459, 704, 112]]],
    ctaHeading: [cta, '.landing-final__title', [[32, 40, null, 32]]],
    ctaButton: [cta, '.landing-final__action', [[null, 32, null, 48]]],
  },
  390: {
    band: [band, band, [[0, 0, 390, 916]]],
    promises: [band, '.landing-guarantee', [[16, 176, 358, 596]]],
    promise: [
      band,
      '.landing-promise',
      [
        [16, 176, 358, 172],
        [16, 388, 358, 172],
        [16, 600, 358, 172],
      ],
    ],
    numeral: [
      band,
      '.landing-promise__numeral',
      [
        [16, 176, 64, 64],
        [16, 388, 64, 64],
        [16, 600, 64, 64],
      ],
    ],
    title: [
      band,
      '.landing-promise__title',
      [
        [16, 260, null, 28],
        [16, 472, null, 28],
        [16, 684, null, 28],
      ],
    ],
    line: [
      band,
      '.landing-promise__line',
      [
        [16, 300, 358, 48],
        [16, 512, 358, 48],
        [16, 724, 358, 48],
      ],
    ],
    link: [band, '.landing-guarantee__link', [[16, 804, null, 48]]],
    star: [band, '.landing-band__star', []],
    trustSection: [band, `${band} + section`, [[0, 980, 390, 580]]],
    trustGrid: [trust, trust, [[0, 0, 358, 524]]],
    trustCard: [
      trust,
      '.landing-trust-card',
      [
        [0, 0, 358, 164],
        [0, 180, 358, 164],
        [0, 360, 358, 164],
      ],
    ],
    trustTile: [
      trust,
      '.landing-trust-card .icon-tile',
      [
        [24, 24, 40, 40],
        [24, 204, 40, 40],
        [24, 384, 40, 40],
      ],
    ],
    trustTitle: [
      trust,
      '.landing-trust-card__title',
      [
        [24, 76, null, 28],
        [24, 256, null, 28],
        [24, 436, null, 28],
      ],
    ],
    trustArrow: [
      trust,
      '.landing-trust-card__arrow',
      [
        [null, 82, 16, 16],
        [null, 262, 16, 16],
        [null, 442, 16, 16],
      ],
    ],
    trustLine: [
      trust,
      '.landing-trust-card__line',
      [
        [24, 116, null, 24],
        [24, 296, null, 24],
        [24, 476, null, 24],
      ],
    ],
    faq: [`${band} + section`, faq, [[0, 644, 390, 411]]],
    faqHeading: [faq, `${faq} h2`, [[16, 0, 358, 32]]],
    faqCard: [faq, '.landing-faq__card', [[16, 56, 358, 355]]],
    faqItem: [
      faq,
      `${faq} details`,
      [
        [36, 56, 318, 160],
        [36, 216, 318, 65],
        [36, 281, 318, 65],
        [36, 346, 318, 65],
      ],
    ],
    faqSummary: [
      faq,
      `${faq} summary`,
      [
        [36, 56, 318, 64],
        [36, 217, 318, 64],
        [36, 282, 318, 64],
        [36, 347, 318, 64],
      ],
    ],
    faqAnswer: [
      faq,
      `${faq} details[open] .accordion__content`,
      [[36, 120, 318, 96]],
    ],
    cta: [faq, cta, [[16, 475, 358, 152]]],
    ctaHeading: [cta, '.landing-final__title', [[24, 24, 310, 32]]],
    // Full width in a stretched column.
    ctaButton: [cta, '.landing-final__action', [[24, 80, 310, 48]]],
  },
};
// The section gap above the footer is the only space below the call to
// action.
const footerGap = { 1440: 80, 768: 64, 390: 64 };

// Every customer-visible string in the four sections, as the frames draw it.
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

async function openLanding({
  width,
  height = 900,
  colorScheme = 'light',
  javaScriptEnabled = true,
}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme,
    javaScriptEnabled,
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.abort(),
  );
  const page = await context.newPage();
  await page.goto(browserOrigin);
  await page.evaluate(() => globalThis.document.fonts.ready);
  return { context, page };
}

// The boxes of every rendered element a frame entry names. An element that
// is not displayed has no box.
function measure(page, frame) {
  return page.evaluate((entries) => {
    const { document } = globalThis;
    const boxes = {};
    for (const [key, [origin, selector]] of Object.entries(entries)) {
      const base = document.querySelector(origin).getBoundingClientRect();
      boxes[key] = [...document.querySelectorAll(selector)]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return [
            rect.left - base.left,
            rect.top - base.top,
            rect.width,
            rect.height,
          ];
        });
    }
    return boxes;
  }, frame);
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
      onMidnight: colour('on-midnight'),
      coral: colour('coral'),
      coralLift: colour('coral-lift'),
      ink: colour('ink'),
      ink600: colour('ink-600'),
      surface: colour('surface'),
      shadowBand: shadow('var(--shadow-band)'),
      card: shadow('var(--shadow-1), var(--edge)'),
      cardRaised: shadow('var(--shadow-2), var(--edge)'),
      ringNumeral: shadow('var(--ring-numeral)'),
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
        position: css.position,
        border: `${css.borderTopWidth} ${css.borderTopStyle} ${css.borderTopColor}`,
        boxSizing: css.boxSizing,
      };
    };
    return {
      band: read('#guarantee'),
      intro: read('#guarantee .section__heading p'),
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
    };
  });
}

test('the four closing sections match the frames at 1440, 768 and 390, in both themes', async () => {
  for (const colorScheme of themes) {
    for (const [width, frame] of Object.entries(frames)) {
      const { context, page } = await openLanding({
        width: Number(width),
        colorScheme,
      });
      const boxes = await measure(page, frame);
      for (const [key, [, , expected]] of Object.entries(frame)) {
        const where = `${key} at ${width} ${colorScheme}`;
        assert.equal(boxes[key].length, expected.length, `${where}: count`);
        expected.forEach((box, index) => {
          box.forEach((value, axis) => {
            if (value !== null)
              near(boxes[key][index][axis], value, `${where} [${index}]`);
          });
        });
      }
      const gap = await page.evaluate(
        () =>
          globalThis.document
            .querySelector('body > footer')
            .getBoundingClientRect().top -
          globalThis.document
            .querySelector('.landing-final__card')
            .getBoundingClientRect().bottom,
      );
      near(gap, footerGap[width], `footer gap at ${width} ${colorScheme}`);

      const tokens = await resolveTokens(page);
      const css = await styles(page);
      const where = `${width} ${colorScheme}`;
      // The band: midnight ground, on-midnight text, the band shadow (none in
      // light, the 24px 64px band shadow plus edge in dark).
      assert.equal(css.band.background, tokens.midnight, where);
      assert.equal(css.band.color, tokens.onMidnight, where);
      assert.equal(css.band.shadow, tokens.shadowBand, where);
      if (colorScheme === 'dark') {
        assert.match(css.band.shadow, /0px 24px 64px/u, where);
        assert.match(css.band.shadow, /0px 0px 0px 1px/u, where);
      } else
        assert.doesNotMatch(css.band.shadow, /rgba\(0, 0, 0, 0\.6\)/u, where);
      assert.equal(css.intro.color, tokens.onMidnight, where);
      assert.equal(css.intro.font, '16px/24px 400', where);
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
      // The FAQ card and items.
      const faqPad = Number(width) < 768 ? 20 : 24;
      assert.deepEqual(css.faqCard.padding, [0, faqPad, 0, faqPad], where);
      assert.equal(css.faqCard.shadow, tokens.card, where);
      assert.equal(css.summary.font, '16px/24px 600', where);
      assert.equal(css.answer.color, tokens.ink600, where);
      // The final call to action: a surface card on the light page.
      const ctaPad = { 1440: 40, 768: 32, 390: 24 }[width];
      assert.deepEqual(css.cta.padding, Array(4).fill(ctaPad), where);
      assert.equal(css.cta.background, tokens.surface, where);
      assert.equal(css.cta.shadow, tokens.card, where);
      assert.equal(css.ctaHeading.font, '24px/32px 600', where);
      assert.equal(css.ctaButton.background, tokens.coral, where);
      await context.close();
    }
  }
});

test('the numerals are hidden from assistive technology and each promise heading carries its numeral prefix', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await openLanding({ width: 1440, colorScheme });
    const list = page.locator('#guarantee ol.landing-guarantee');
    assert.equal(await list.locator(':scope > li').count(), 3);
    for (const [numeral, title] of frameCopy.promises) {
      const name = `${numeral}. ${title}`;
      assert.equal(
        await page
          .getByRole('heading', { level: 3, name, exact: true })
          .count(),
        1,
        `${name} (${colorScheme})`,
      );
    }
    const tree = await list.ariaSnapshot();
    for (const [numeral, title] of frameCopy.promises) {
      assert.ok(tree.includes(`heading "${numeral}. ${title}" [level=3]`));
    }
    // No numeral is read on its own: each ring is aria-hidden.
    const numerals = await page.$$eval('.landing-promise__numeral', (rings) =>
      rings.map((ring) => [ring.getAttribute('aria-hidden'), ring.textContent]),
    );
    assert.deepEqual(numerals, [
      ['true', 'I'],
      ['true', 'II'],
      ['true', 'III'],
    ]);
    assert.doesNotMatch(tree, /text: (I|II|III)$/mu);
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
    assert.deepEqual(prefixes, [true, true, true]);
    // The star is decorative.
    assert.equal(
      await page.getAttribute('.landing-band__star', 'aria-hidden'),
      'true',
    );
    await context.close();
  }
});

test('each trust card is one link with a visible focus state, and the contact card opens the support mailbox', async () => {
  for (const colorScheme of themes) {
    for (const width of [1440, 768, 390]) {
      const { context, page } = await openLanding({ width, colorScheme });
      const tokens = await resolveTokens(page);
      const cards = page.locator('.landing-trust-card');
      assert.equal(await cards.count(), frameCopy.trustCards.length);
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
        // The rest shadow, then the coral focus outline from the keyboard
        // and the raised shadow on hover.
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
        assert.equal(
          await card.evaluate(
            (element) => globalThis.getComputedStyle(element).boxShadow,
          ),
          tokens.card,
          where,
        );
        await card.hover();
        await page.waitForTimeout(250);
        assert.equal(
          await card.evaluate(
            (element) => globalThis.getComputedStyle(element).boxShadow,
          ),
          tokens.cardRaised,
          where,
        );
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
    const { context, page } = await openLanding({ width });
    const action = page.locator('.landing-final__action');
    assert.equal(await action.getAttribute('href'), '#join');
    assert.equal((await action.textContent()).trim(), frameCopy.ctaAction);
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
  assert.equal(new URL(page.url()).hash, '#join');
  const top = await page.evaluate(() =>
    Math.round(
      globalThis.document.querySelector('#join').getBoundingClientRect().top,
    ),
  );
  assert.ok(Math.abs(top) <= tolerance, `#join at the top: ${top}`);
  await context.close();
});

test('every string in the four sections matches the frames verbatim and comes from the copy layer', async () => {
  // The copy layer holds the frames' strings.
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

  // And the page renders exactly those strings, in order.
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
  });
  await context.close();
});

test('the four closing sections pass WCAG axe in both themes', async () => {
  for (const colorScheme of themes) {
    for (const width of [1440, 768, 390]) {
      const { context, page } = await openLanding({ width, colorScheme });
      await page.addScriptTag({ content: axe.source });
      for (const selector of [
        '#guarantee',
        '#guarantee + section',
        '#faq',
        '.landing-final',
      ]) {
        const violations = await page.evaluate(
          async (scope) =>
            (
              await globalThis.axe.run(
                globalThis.document.querySelector(scope),
                {
                  runOnly: {
                    type: 'tag',
                    values: [
                      'wcag2a',
                      'wcag2aa',
                      'wcag21a',
                      'wcag21aa',
                      'wcag22aa',
                    ],
                  },
                },
              )
            ).violations.map((violation) => ({
              id: violation.id,
              nodes: violation.nodes.map((node) => node.target.join(' ')),
            })),
          selector,
        );
        assert.deepEqual(violations, [], `${selector} ${width} ${colorScheme}`);
      }
      await context.close();
    }
  }
});
