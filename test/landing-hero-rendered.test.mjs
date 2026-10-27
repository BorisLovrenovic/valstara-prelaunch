import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import axe from 'axe-core';

import { landingCopy } from '../src/copy/landing.ts';
import { signupFormCopy } from '../src/copy/signup.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { renderLanding } from './helpers/landing-render.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

// E11.5-11c: the #join hero from Main.dc.html, Tablet.dc.html, Phone.dc.html
// and Fold.dc.html. Every number below is the frame's, with a 1px tolerance.

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-landing-hero-playwright-${process.pid}`;
const appServerStartupTimeoutMilliseconds = 30_000;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const themes = ['light', 'dark'];
const tolerance = 1;

const showcase = JSON.parse(
  await readFile(
    new URL('../src/content/provider-showcase.json', import.meta.url),
    'utf8',
  ),
);
const heroList = JSON.parse(
  await readFile(
    new URL('../src/content/landing-hero.json', import.meta.url),
    'utf8',
  ),
);

let app;
let browser;
let browserOrigin;
let hostOrigin;
let browserServer;
let browserServerError;
let giveawayOpenPage;
let signupsPausedPage;

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
  browserServer.once('error', (error) => {
    browserServerError = error;
  });

  for (let attempt = 0; attempt < 720; attempt += 1) {
    if (output.includes('Listening on')) {
      return `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`;
    }
    if (browserServerError !== undefined) {
      throw new Error(
        `Could not start the containerized Playwright server: ${browserServerError.message}`,
        { cause: browserServerError },
      );
    }
    if (browserServer.exitCode !== null) {
      throw new Error(
        `Containerized Playwright server exited before startup.\n${output}`,
      );
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }

  throw new Error(
    `Containerized Playwright server did not start within three minutes.\n${output}`,
  );
}

async function waitForBrowserAppServer() {
  const deadline =
    globalThis.performance.now() + appServerStartupTimeoutMilliseconds;
  const context = await browser.newContext();
  const page = await context.newPage();
  let lastError;
  try {
    while (globalThis.performance.now() < deadline) {
      try {
        const response = await page.goto(browserOrigin, { timeout: 2_000 });
        if (response?.ok()) return;
      } catch (error) {
        lastError = error;
      }
      if (app.server.exitCode !== null) break;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
    throw new Error(
      `Landing hero browser could not reach the app server. ${String(lastError)}\n${app.output() || '(no server output)'}`,
    );
  } finally {
    await context.close();
  }
}

before(async () => {
  await ensureAppBuild();
  // The flag variants are rendered by a server reading real campaign_flag
  // rows; the browser then loads that HTML at this app's origin, so its
  // stylesheets and island come from the same build.
  [giveawayOpenPage, signupsPausedPage] = [
    (await renderLanding({ flags: [{ key: 'giveaway.open', enabled: true }] }))
      .body,
    (
      await renderLanding({
        flags: [{ key: 'signup.enabled', enabled: false }],
      })
    ).body,
  ];
  // No reachable database: every flag falls back to its registered default
  // (signup on, giveaway off).
  app = await startAppServer({
    label: 'Landing hero test',
    env: () => ({
      ADMIN_CREDENTIAL: 'landing-hero-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-hero',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'landing-hero-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'landing-hero-referral-secret',
      RESEND_API_KEY: 'landing-hero-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'landing-hero-turnstile-secret',
    }),
  });
  hostOrigin = `http://127.0.0.1:${app.port}`;
  browserOrigin = `http://host.docker.internal:${app.port}`;
  browser = await chromium.connect(await startBrowserServer());
  await waitForBrowserAppServer();
});

after(async () => {
  await browser?.close();
  if (browserServerError === undefined) {
    await execFileAsync('docker', ['rm', '--force', browserContainer]).catch(
      (error) => {
        if (!String(error.stderr).includes('No such container')) {
          throw error;
        }
      },
    );
  }
  if (browserServer !== undefined && browserServer.exitCode === null) {
    const browserServerExited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await browserServerExited;
  }
  await app?.stop();
});

// Opens the landing page, or a flag variant's HTML served at the app origin.
async function openHero({ width, height = 900, colorScheme = 'light', html }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme,
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.abort(),
  );
  if (html !== undefined) {
    // A document fulfilled by the test cannot load unrouted subresources in
    // the connected browser, so its same-origin requests are answered from
    // the running app server (as openRoute does for the built 500 page).
    await context.route(`${browserOrigin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/')
        return route.fulfill({
          body: html,
          contentType: 'text/html; charset=utf-8',
        });
      if (route.request().method() !== 'GET')
        return route.fulfill({ status: 204 });
      const response = await globalThis.fetch(
        `${hostOrigin}${url.pathname}${url.search}`,
      );
      return route.fulfill({
        status: response.status,
        contentType: response.headers.get('content-type') ?? undefined,
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
  }
  const page = await context.newPage();
  await page.goto(browserOrigin);
  await page.evaluate(() => globalThis.document.fonts.ready);
  return { context, page };
}

// Every box and style the assertions read, measured once per page.
function measureHero(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const box = (element) => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top + globalThis.scrollY,
        right: rect.right,
        bottom: rect.bottom + globalThis.scrollY,
        width: rect.width,
        height: rect.height,
      };
    };
    const pick = (selector) => box(document.querySelector(selector));
    const style = (selector) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      const computed = getComputedStyle(element);
      return {
        fontSize: computed.fontSize,
        lineHeight: computed.lineHeight,
        fontWeight: computed.fontWeight,
        paddingLeft: Number.parseFloat(computed.paddingLeft),
        display: computed.display,
      };
    };
    const eyebrow = document.querySelector('.landing-eyebrow');
    const eyebrowText = document.createRange();
    eyebrowText.selectNodeContents(eyebrow);
    eyebrowText.setStartAfter(eyebrow.querySelector('svg'));
    const banners = (selector) =>
      [...document.querySelectorAll(`${selector} .hero-banner`)].map(
        (banner) => ({
          name: banner.dataset.heroBanner,
          box: box(banner),
          padding: Number.parseFloat(getComputedStyle(banner).paddingLeft),
          chip: box(banner.querySelector('.hero-banner__chip')),
          chipPadding: Number.parseFloat(
            getComputedStyle(banner.querySelector('.hero-banner__chip'))
              .paddingLeft,
          ),
          chipFont: getComputedStyle(banner.querySelector('.hero-banner__chip'))
            .fontSize,
          chipText: banner
            .querySelector('.hero-banner__chip')
            .textContent.trim(),
          logo: banner.querySelector('img')?.getAttribute('src') ?? null,
          category:
            banner.querySelector('.hero-banner__category')?.textContent ?? null,
        }),
      );
    const facts = [...document.querySelectorAll('.landing-facts li')].map(
      (item) => ({
        box: box(item),
        icon: box(item.querySelector('svg')),
        text: box(item.querySelector('span')),
      }),
    );
    return {
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      header: pick('body > header'),
      container: pick('#join [data-design-container]'),
      copy: pick('.landing-hero__copy'),
      eyebrow: box(eyebrow),
      eyebrowStyle: style('.landing-eyebrow'),
      star: pick('.landing-eyebrow svg'),
      eyebrowText: box(eyebrowText),
      h1: pick('#landing-title'),
      h1Style: style('#landing-title'),
      body: pick('.landing-hero__body'),
      bodyStyle: style('.landing-hero__body'),
      form: pick('valstara-signup-form'),
      label: pick('.field__label'),
      hint: pick('.field__description'),
      input: pick('#signup-email'),
      submit: pick('[data-submit]'),
      submitStyle: style('[data-submit]'),
      micro: pick('form > .signup-age'),
      microStyle: style('form > .signup-age'),
      factsList: pick('.landing-facts'),
      facts,
      consent: pick('.signup-marketing'),
      strip: pick('.landing-hero__strip'),
      stripStyle: style('.landing-hero__strip'),
      stack: pick('.landing-hero__stack'),
      stackStyle: style('.landing-hero__stack'),
      stackBanners: banners('.landing-hero__stack'),
      stripBanners: banners('.landing-hero__strip'),
      catalogueHeading: pick('#catalogue h2'),
    };
  });
}

function near(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance}px of ${expected}`,
  );
}

// The 12-column grid of the hero's container: 24px gaps at medium and large.
function columns(container) {
  const gap = 24;
  const column = (container.width - 11 * gap) / 12;
  return {
    sevenEnd: container.left + 7 * column + 6 * gap,
    eightStart: container.left + 7 * column + 7 * gap,
    end: container.right,
    span5: 5 * column + 4 * gap,
    span7: 7 * column + 6 * gap,
  };
}

// Fold.dc.html draws the giveaway-open microline, which wraps at small
// widths; the default page carries only the 18+ line. Both must fit.
test('above the fold matches Fold.dc.html at 1440 × 900, 390 × 844 and 320, in both themes and both microline states', async () => {
  for (const [colorScheme, html] of themes.flatMap((theme) => [
    [theme, undefined],
    [theme, giveawayOpenPage],
  ])) {
    const variant = html === undefined ? 'giveaway off' : 'giveaway open';
    const desktop = await openHero({
      width: 1440,
      height: 900,
      colorScheme,
      html,
    });
    const large = await measureHero(desktop.page);
    for (const key of [
      'eyebrow',
      'h1',
      'input',
      'submit',
      'micro',
      'factsList',
      'consent',
    ]) {
      assert.ok(large[key].top >= 0, `${key} starts on screen`);
      assert.ok(
        large[key].bottom <= 900,
        `${key} ends above 900 in ${colorScheme}, ${variant}: ${large[key].bottom}`,
      );
    }
    assert.ok(
      large.catalogueHeading.top < 900,
      `"What you'll find" starts above 900, ${variant}: ${large.catalogueHeading.top}`,
    );
    await desktop.context.close();

    const phone = await openHero({
      width: 390,
      height: 844,
      colorScheme,
      html,
    });
    const small = await measureHero(phone.page);
    for (const key of ['input', 'submit']) {
      assert.ok(
        small[key].bottom <= 500,
        `${key} ends above 500 in ${colorScheme}, ${variant}: ${small[key].bottom}`,
      );
    }
    for (const key of ['micro', 'factsList', 'consent', 'strip']) {
      assert.ok(
        small[key].bottom <= 844,
        `${key} fits above 844 in ${colorScheme}, ${variant}: ${small[key].bottom}`,
      );
    }
    await phone.context.close();

    const smallest = await openHero({
      width: 320,
      height: 568,
      colorScheme,
      html,
    });
    const narrow = await measureHero(smallest.page);
    assert.ok(
      narrow.scrollWidth <= 320,
      `no horizontal overflow at 320 in ${colorScheme}, ${variant}: ${narrow.scrollWidth}`,
    );
    for (const banner of narrow.stripBanners) {
      assert.ok(banner.box.right <= 320 - 16 + tolerance, banner.name);
      assert.ok(
        banner.chip.right <= banner.box.right - banner.padding + tolerance,
        `${banner.name} chip fits its banner at 320`,
      );
    }
    near(narrow.stripBanners[0].padding, 4, 'strip padding at 320');
    near(narrow.stripBanners[0].chipPadding, 6, 'strip chip padding at 320');
    await smallest.context.close();
  }
});

test('the large hero matches Main.dc.html at 1440, in both themes', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await openHero({ width: 1440, colorScheme });
    const hero = await measureHero(page);
    const grid = columns(hero.container);

    near(hero.container.width, 1200, 'container');
    near(hero.copy.left, hero.container.left, 'text column starts at col 1');
    near(hero.copy.width, grid.span7, 'text column spans 1–7');
    near(hero.eyebrow.top - hero.header.bottom, 48, 'top padding');
    assert.deepEqual(
      [
        hero.eyebrowStyle.fontSize,
        hero.eyebrowStyle.lineHeight,
        hero.eyebrowStyle.fontWeight,
      ],
      ['16px', '24px', '500'],
    );
    near(hero.star.width, 12, 'star width');
    near(hero.star.height, 18, 'star height');
    near(hero.eyebrowText.left - hero.star.right, 8, 'star gap');
    near(hero.h1.top - hero.eyebrow.bottom, 12, 'H1 below the positioning');
    assert.deepEqual(
      [hero.h1Style.fontSize, hero.h1Style.lineHeight, hero.h1Style.fontWeight],
      ['32px', '40px', '700'],
    );
    near(hero.body.top - hero.h1.bottom, 16, 'supporting line below the H1');
    near(hero.body.width, 600, 'supporting line at most 600px');
    assert.deepEqual(
      [hero.bodyStyle.fontSize, hero.bodyStyle.lineHeight],
      ['16px', '24px'],
    );
    near(hero.form.top - hero.body.bottom, 32, 'form below the supporting');
    near(hero.form.width, 560, 'form at most 560px');
    near(hero.label.top, hero.form.top, 'label opens the form');
    near(hero.hint.top - hero.label.bottom, 4, 'hint below the label');
    near(hero.input.top - hero.hint.bottom, 8, 'row below the hint');
    near(hero.input.height, 48, 'field height');
    near(hero.submit.height, 48, 'button height');
    near(hero.submit.top, hero.input.top, 'field and button share a row');
    near(hero.submit.left - hero.input.right, 8, 'row gap');
    near(hero.submit.right, hero.form.right, 'button ends the row');
    near(hero.input.left, hero.form.left, 'field starts the row');
    near(hero.submitStyle.paddingLeft, 24, 'button padding');
    near(hero.micro.top - hero.input.bottom, 12, 'microline below the row');
    assert.deepEqual(
      [hero.microStyle.fontSize, hero.microStyle.lineHeight],
      ['14px', '20px'],
    );
    near(hero.factsList.top - hero.micro.bottom, 20, 'facts below microline');
    near(hero.facts[1].box.left - hero.facts[0].box.right, 24, 'fact gap');
    for (const fact of hero.facts) {
      near(fact.icon.width, 20, 'fact icon');
      near(fact.text.left - fact.icon.right, 8, 'fact icon gap');
    }
    near(hero.consent.top - hero.factsList.bottom, 24, 'checkbox below facts');
    assert.equal(hero.stripStyle.display, 'none', 'no strip at large');

    near(hero.stack.left, grid.eightStart, 'stack starts at col 8');
    near(hero.stack.right, grid.end, 'stack ends at col 12');
    near(hero.stack.height, 400, 'stack height');
    const expected = [
      { top: 0, right: 0 },
      { top: 104, right: 73 },
      { top: 208, right: 146 },
    ];
    for (const [index, banner] of hero.stackBanners.entries()) {
      near(banner.box.width, 340, `${banner.name} width`);
      near(banner.box.height, 184, `${banner.name} height`);
      near(banner.box.top - hero.stack.top, expected[index].top, banner.name);
      near(
        hero.stack.right - banner.box.right,
        expected[index].right,
        `${banner.name} right offset`,
      );
      near(banner.padding, 24, `${banner.name} padding`);
      near(banner.chip.height, 48, `${banner.name} chip`);
      near(banner.chipPadding, 16, `${banner.name} chip padding`);
      assert.equal(banner.chipFont, '16px');
    }
    // Netflix, the last banner, is drawn on top where it overlaps the others.
    const [, middle, front] = hero.stackBanners;
    const topmost = await page.evaluate(
      ({ x, y }) =>
        globalThis.document
          .elementFromPoint(x, y - globalThis.scrollY)
          ?.closest('.hero-banner')?.dataset.heroBanner,
      { x: front.box.left + 4, y: middle.box.bottom - 4 },
    );
    assert.equal(topmost, 'Netflix');
    await context.close();
  }
});

test('the medium hero matches Tablet.dc.html at 768, in both themes', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await openHero({ width: 768, colorScheme });
    const hero = await measureHero(page);
    const grid = columns(hero.container);

    near(hero.copy.width, grid.span7, 'text column spans 1–7');
    near(hero.eyebrow.top - hero.header.bottom, 40, 'top padding');
    assert.deepEqual(
      [hero.eyebrowStyle.fontSize, hero.eyebrowStyle.lineHeight],
      ['14px', '20px'],
    );
    near(hero.h1.top - hero.eyebrow.bottom, 12, 'H1 below the positioning');
    near(hero.body.top - hero.h1.bottom, 16, 'supporting below the H1');
    near(hero.form.top - hero.body.bottom, 32, 'form below the supporting');
    near(hero.submit.top, hero.input.top, 'field and button share a row');
    near(hero.submit.left - hero.input.right, 8, 'row gap');
    near(hero.submitStyle.paddingLeft, 20, 'button padding');
    near(hero.micro.top - hero.input.bottom, 12, 'microline below the row');
    near(hero.factsList.top - hero.micro.bottom, 20, 'facts below microline');
    near(hero.facts[1].box.left - hero.facts[0].box.right, 20, 'fact gap');
    near(hero.consent.top - hero.factsList.bottom, 24, 'checkbox below facts');

    near(hero.stack.left, grid.eightStart, 'stack starts at col 8');
    near(hero.stack.right, grid.end, 'stack ends at col 12');
    near(hero.stack.height, 290, 'stack height');
    const expected = [
      { top: 0, right: 0 },
      { top: 76, right: 22 },
      { top: 152, right: 44 },
    ];
    for (const [index, banner] of hero.stackBanners.entries()) {
      near(banner.box.width, 236, `${banner.name} width`);
      near(banner.box.height, 136, `${banner.name} height`);
      near(banner.box.top - hero.stack.top, expected[index].top, banner.name);
      near(
        hero.stack.right - banner.box.right,
        expected[index].right,
        `${banner.name} right offset`,
      );
      near(banner.padding, 16, `${banner.name} padding`);
      near(banner.chip.height, 40, `${banner.name} chip`);
      near(banner.chipPadding, 14, `${banner.name} chip padding`);
    }
    await context.close();
  }
});

test('the small hero matches Phone.dc.html at 390, in both themes', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await openHero({
      width: 390,
      height: 844,
      colorScheme,
    });
    const hero = await measureHero(page);

    near(hero.copy.left, 16, 'gutter');
    near(hero.copy.width, 358, 'single column');
    near(hero.eyebrow.top - hero.header.bottom, 24, 'top padding');
    assert.deepEqual(
      [hero.eyebrowStyle.fontSize, hero.eyebrowStyle.lineHeight],
      ['14px', '20px'],
    );
    near(hero.h1.top - hero.eyebrow.bottom, 12, 'H1 below the positioning');
    near(hero.body.top - hero.h1.bottom, 12, 'supporting below the H1');
    near(hero.form.top - hero.body.bottom, 24, 'form below the supporting');
    near(hero.input.width, 358, 'field full width');
    near(hero.submit.top - hero.input.bottom, 12, 'button below the field');
    near(hero.submit.width, 358, 'button full width');
    near(hero.submit.height, 48, 'button height');
    near(hero.micro.top - hero.submit.bottom, 12, 'microline below button');
    near(hero.factsList.top - hero.micro.bottom, 16, 'facts below microline');
    near(hero.facts[1].box.left - hero.facts[0].box.right, 20, 'fact gap');
    near(hero.facts[2].box.top - hero.facts[0].box.bottom, 8, 'fact row gap');
    near(hero.consent.top - hero.factsList.bottom, 20, 'checkbox below facts');
    assert.equal(hero.stackStyle.display, 'none', 'no stack at small');

    near(hero.strip.top - hero.form.bottom, 24, 'strip below the form');
    assert.deepEqual(
      hero.stripBanners.map((banner) => banner.name),
      heroList.strip,
    );
    const [first, second, third] = hero.stripBanners;
    near(second.box.left - first.box.right, 8, 'strip gap');
    near(third.box.left - second.box.right, 8, 'strip gap');
    // flex: 1 1 0 with 8px padding, as drawn: the free space after the two
    // gaps and the three paddings divides 1 : 1 : 1.35 (103.75, 103.75, 134.5).
    const unit = (358 - 2 * 8 - 3 * 16) / 3.35;
    near(first.box.width, unit + 16, 'strip ratio 1');
    near(second.box.width, unit + 16, 'strip ratio 1');
    near(third.box.width, unit * 1.35 + 16, 'strip ratio 1.35');
    for (const banner of hero.stripBanners) {
      near(banner.box.height, 56, `${banner.name} strip height`);
      near(banner.padding, 8, `${banner.name} strip padding`);
      near(banner.chip.height, 32, `${banner.name} chip`);
      near(banner.chipPadding, 8, `${banner.name} chip padding`);
      assert.equal(banner.chipFont, '13px');
    }
    await context.close();
  }
});

test('the banner stack stays inside columns 8–12 at every medium and large width', async () => {
  for (const width of [768, 1024, 1280, 1440, 1920]) {
    const { context, page } = await openHero({ width });
    const hero = await measureHero(page);
    const grid = columns(hero.container);
    for (const banner of hero.stackBanners) {
      assert.ok(
        banner.box.left >= grid.eightStart - 0.5,
        `${banner.name} crosses into column 7 at ${width}: ${banner.box.left} < ${grid.eightStart}`,
      );
      assert.ok(banner.box.left > grid.sevenEnd, `${banner.name} at ${width}`);
      assert.ok(
        banner.box.right <= grid.end + 0.5,
        `${banner.name} passes column 12 at ${width}`,
      );
    }
    await context.close();
  }
});

test('the stack and the strip are aria-hidden and draw the real providers: logos in the stack, names in the strip', async () => {
  const byName = new Map(showcase.map((provider) => [provider.name, provider]));
  for (const width of [1440, 390]) {
    const { context, page } = await openHero({ width });
    const hero = await measureHero(page);
    const hidden = await page.evaluate(() =>
      ['.landing-hero__stack', '.landing-hero__strip'].map((selector) =>
        globalThis.document.querySelector(selector).getAttribute('aria-hidden'),
      ),
    );
    assert.deepEqual(hidden, ['true', 'true']);
    const accessible = await page
      .locator('#join')
      .ariaSnapshot({ timeout: 5_000 });
    for (const name of heroList.stack) {
      assert.ok(
        !accessible.includes(name),
        `${name} stays out of the accessibility tree`,
      );
    }
    if (width === 1440) {
      assert.deepEqual(
        hero.stackBanners.map((banner) => banner.name),
        heroList.stack,
      );
      for (const banner of hero.stackBanners) {
        const provider = byName.get(banner.name);
        assert.equal(banner.logo, provider.logo);
        assert.equal(banner.chipText, provider.name);
        assert.ok(banner.category, `${banner.name} shows its category`);
      }
      const logos = await page.evaluate(() =>
        [...globalThis.document.querySelectorAll('.hero-banner img')].map(
          (image) => ({
            alt: image.getAttribute('alt'),
            loaded: image.complete && image.naturalWidth > 0,
            ratio: image.width / image.height,
            natural: image.naturalWidth / image.naturalHeight,
          }),
        ),
      );
      for (const logo of logos) {
        assert.equal(logo.alt, '');
        assert.ok(logo.loaded, 'the same-origin logo loads');
        // The declared size reserves the logo's box before it loads.
        assert.ok(Math.abs(logo.ratio - logo.natural) < 0.05);
      }
    } else {
      for (const banner of hero.stripBanners) {
        assert.equal(banner.logo, null, `${banner.name} strip has no logo`);
        assert.equal(banner.category, null, `${banner.name} has no category`);
        assert.equal(banner.chipText, byName.get(banner.name).name);
      }
    }
    await context.close();
  }
});

test('the microline is the full sentence with the giveaway open, and only the 18+ line without it', async () => {
  const full = `${signupFormCopy.ageStatement} ${signupFormCopy.freeEntryDisclosure} ${signupFormCopy.giveawayRulesLink}${signupFormCopy.giveawayRulesLinkEnd}`;
  assert.equal(
    full,
    'Open to people aged 18 and over. No purchase necessary. See the giveaway rules.',
  );
  for (const width of [1440, 390]) {
    const open = await openHero({ width, html: giveawayOpenPage });
    const microline = open.page.locator('form > .signup-age');
    assert.equal(await microline.textContent(), full);
    const link = microline.locator('a');
    assert.equal(await link.getAttribute('href'), '/giveaway/rules');
    assert.equal(await link.textContent(), signupFormCopy.giveawayRulesLink);
    // The microline sits directly under the field row, before the facts.
    const order = await open.page.evaluate(() => {
      const form = globalThis.document.querySelector(
        'valstara-signup-form form',
      );
      const at = (selector) =>
        form.querySelector(selector).getBoundingClientRect().top;
      return [
        at('[data-submit]'),
        at('.signup-age'),
        at('.landing-facts'),
        at('.signup-marketing'),
      ];
    });
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
    await open.context.close();

    const closed = await openHero({ width });
    const line = closed.page.locator('form > .signup-age');
    assert.equal(await line.textContent(), signupFormCopy.ageStatement);
    assert.equal(await line.locator('a').count(), 0);
    const box = await line.boundingBox();
    near(box.height, 20, 'the 18+ line is one line');
    await closed.context.close();
  }
});

test('with signups paused the panel replaces the form, and the header Join and final call to action scroll to it', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openHero({
      width,
      height: width === 1440 ? 900 : 844,
      html: signupsPausedPage,
    });
    assert.equal(await page.locator('valstara-signup-form').count(), 0);
    assert.equal(await page.locator('input[name="email"]').count(), 0);
    assert.equal(await page.locator('.landing-facts').count(), 0);
    assert.equal(await page.locator('[name="marketing_opt_in"]').count(), 0);
    const panel = page.locator('#join .landing-paused');
    assert.equal(
      await panel.getByRole('heading', { level: 2 }).textContent(),
      landingCopy.paused.heading,
    );
    // The banners still frame the hero: the stack at large, the strip at small.
    const visual =
      width === 1440 ? '.landing-hero__stack' : '.landing-hero__strip';
    assert.ok(await page.locator(visual).isVisible());

    for (const trigger of [
      'body > header a[href="#join"]',
      '[data-focus-signup]',
    ]) {
      await page.evaluate(() =>
        globalThis.scrollTo(0, globalThis.document.body.scrollHeight),
      );
      await page.locator(trigger).click();
      await page.waitForFunction(() => {
        const rect = globalThis.document
          .querySelector('#join .landing-paused')
          .getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= globalThis.innerHeight;
      });
      assert.equal(new URL(page.url()).hash, '#join');
    }
    await context.close();
  }
});

test('the hero and its flag variants pass WCAG axe in both themes', async () => {
  for (const [variant, html] of [
    ['default', undefined],
    ['giveaway open', giveawayOpenPage],
    ['signups paused', signupsPausedPage],
  ]) {
    for (const colorScheme of themes) {
      for (const width of [1440, 390]) {
        const { context, page } = await openHero({ width, colorScheme, html });
        await page.addScriptTag({ content: axe.source });
        const violations = await page.evaluate(async () => {
          const result = await globalThis.axe.run(
            globalThis.document.querySelector('#join'),
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
          );
          return result.violations.map((violation) => ({
            id: violation.id,
            targets: violation.nodes.map((node) => node.target),
          }));
        });
        assert.deepEqual(
          violations,
          [],
          `hero axe, ${variant}, ${colorScheme}, ${width}px`,
        );
        await context.close();
      }
    }
  }
});
