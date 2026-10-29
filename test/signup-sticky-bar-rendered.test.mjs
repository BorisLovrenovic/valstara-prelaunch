import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import axe from 'axe-core';

import { landingCopy } from '../src/copy/landing.ts';
import { signupCopy, signupFormCopy } from '../src/copy/signup.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { renderLanding } from './helpers/landing-render.mjs';
import { checkPageLayout } from '../scripts/design/layout-checks.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

// E11.5-11h: the mobile sticky signup bar of Sticky.dc.html (seven frames)
// and its placement in Phone.dc.html, at 390 × 844 in both themes. The boxes
// below are the frame's: the bar markup and CSS of each frame were rendered on
// the self-hosted Instrument Sans at 390px with the annotation layer off, and
// read relative to the bar's top-left. The frame's own `.v p` reset drops the
// field error's stated 8px top margin (its `.emsg` rule; the component sheet
// draws the message 8px under the field), so that margin was restored before
// reading, as E11.5-11g did for the hero. The frames draw a phone with a home
// indicator, so the frame tests emulate its 34px bottom safe area; the
// safe-area test checks the 12px minimum without one. A null is left to the
// page; every other number is asserted with a 1px tolerance. The frames draw
// the giveaway open.

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-sticky-bar-playwright-${process.pid}`;
const appServerStartupTimeoutMilliseconds = 30_000;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const themes = ['light', 'dark'];
const phone = { width: 390, height: 844 };
const homeIndicator = 34;
const clearance = 16;
const tolerance = 1;

const selectors = {
  bar: '[data-dock]',
  label: '[data-dock] .signup-dock__label',
  input: '#signup-dock-email',
  button: '[data-dock-submit]',
  spinner: '[data-dock-spinner]',
  error: '[data-dock-error]',
  errorIcon: '[data-dock-error] .icon',
  micro: '[data-dock] .signup-age',
  row: '[data-dock-confirmation]',
  done: '[data-dock-confirmation] p',
  doneIcon: '[data-dock-confirmation] p .icon',
  close: '[data-dock-close]',
};

// [x, y, width, height] relative to the bar's top-left, per frame. The
// microline holds its link's lower 12px hit area in its own padding, with a
// matching negative margin, so its box is 12px taller than its two 18px
// lines; nothing below it moves.
const frames = {
  2: {
    bar: [0, null, 390, 158],
    label: [16, 12, null, 18],
    input: [16, 34, 199, 48],
    button: [223, 34, 151, 48],
    micro: [16, 88, 358, 36 + 12],
  },
  4: {
    bar: [0, null, 390, 186],
    label: [16, 12, null, 18],
    input: [16, 34, 199, 48],
    button: [223, 34, 151, 48],
    error: [16, 90, 358, 20],
    errorIcon: [16, 90, 20, 20],
    micro: [16, 116, 358, 36 + 12],
  },
  5: {
    bar: [0, null, 390, 158],
    label: [16, 12, null, 18],
    input: [16, 34, 86, 48],
    button: [110, 34, 264, 48],
    spinner: [126, 50, 16, 16],
    micro: [16, 88, 358, 36 + 12],
  },
  6: {
    bar: [0, null, 390, 90],
    row: [16, 12, 358, 44],
    done: [16, 22, 163, 24],
    doneIcon: [16, 24, 20, 20],
    close: [305, 12, 69, 44],
  },
};

let app;
let browser;
let browserOrigin;
let hostOrigin;
let browserServer;
let browserServerError;
let giveawayOpenPage;
let giveawayOffPage;
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
      `Sticky bar browser could not reach the app server. ${String(lastError)}\n${app.output() || '(no server output)'}`,
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
  [giveawayOpenPage, giveawayOffPage, signupsPausedPage] = [
    (await renderLanding({ flags: [{ key: 'giveaway.open', enabled: true }] }))
      .body,
    (
      await renderLanding({
        flags: [{ key: 'giveaway.open', enabled: false }],
      })
    ).body,
    (
      await renderLanding({
        flags: [{ key: 'signup.enabled', enabled: false }],
      })
    ).body,
  ];
  app = await startAppServer({
    label: 'Sticky bar test',
    env: () => ({
      ADMIN_CREDENTIAL: 'sticky-bar-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-sticky',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'sticky-bar-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'sticky-bar-referral-secret',
      RESEND_API_KEY: 'sticky-bar-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'sticky-bar-turnstile-secret',
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

// A Turnstile stand-in: `success` resolves at once and `pending` never does,
// holding the button on "Completing the security check…".
function installTurnstile(mode) {
  globalThis.turnstile = {
    render(_element, options) {
      if (mode === 'success')
        globalThis.setTimeout(() => options.callback('sticky-token'), 0);
      return 'sticky-widget';
    },
    reset() {},
  };
}

// Opens a landing variant's HTML at the app origin, with its same-origin
// requests answered from the running app server. `safeArea` emulates a
// bottom safe-area inset through the DevTools protocol, as a phone with a
// home indicator reports it.
async function openPage({
  html = giveawayOpenPage,
  viewport = phone,
  colorScheme = 'light',
  reducedMotion = 'no-preference',
  javaScriptEnabled = true,
  safeArea = homeIndicator,
  turnstile = 'success',
}) {
  const context = await browser.newContext({
    viewport,
    colorScheme,
    reducedMotion,
    javaScriptEnabled,
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  );
  if (javaScriptEnabled)
    await context.addInitScript(installTurnstile, turnstile);
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
  const page = await context.newPage();
  if (safeArea > 0) {
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { bottom: safeArea },
    });
  }
  await page.goto(browserOrigin);
  await page.evaluate(() => globalThis.document.fonts.ready);
  if (javaScriptEnabled && html !== signupsPausedPage) {
    await page.evaluate(() =>
      globalThis.customElements.whenDefined('valstara-signup-form'),
    );
  }
  return { context, page };
}

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

const barShown = () => {
  const bar = globalThis.document.querySelector('[data-dock]');
  return bar !== null && !bar.hidden;
};

// Scrolls the hero form just out of view, onto the catalogue, as frame 2.
async function scrollPastHero(page) {
  await page.evaluate(() => {
    const form = globalThis.document.querySelector('valstara-signup-form form');
    globalThis.scrollTo(
      0,
      form.getBoundingClientRect().bottom + globalThis.scrollY + 20,
    );
  });
}

async function revealBar(page) {
  await scrollPastHero(page);
  await page.waitForFunction(barShown);
  await settle(page);
}

// Lets the reveal and every state-change transition finish, so boxes and
// colours read at rest, and holds the spinner at its first frame, so its box
// is the drawn 16px square rather than the bounds of a turned one.
function settle(page) {
  return page.evaluate(async () => {
    const animations = globalThis.document.getAnimations();
    await Promise.all(
      animations
        .filter(
          (animation) =>
            animation instanceof globalThis.CSSTransition ||
            animation.effect?.getComputedTiming().iterations === 1,
        )
        .map((animation) => animation.finished),
    );
    for (const animation of globalThis.document.getAnimations()) {
      if (animation instanceof globalThis.CSSAnimation) {
        animation.pause();
        animation.currentTime = 0;
      }
    }
  });
}

function near(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance}px of ${expected}`,
  );
}

// The boxes of every displayed element each selector names, relative to the
// bar's top-left, with the bar's own box in viewport coordinates.
function measure(page) {
  return page.evaluate((entries) => {
    const { document } = globalThis;
    const base = document.querySelector('[data-dock]').getBoundingClientRect();
    const boxes = {};
    for (const [key, selector] of Object.entries(entries)) {
      boxes[key] = [...document.querySelectorAll(selector)]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return key === 'bar'
            ? [rect.left, rect.top, rect.width, rect.height]
            : [
                rect.left - base.left,
                rect.top - base.top,
                rect.width,
                rect.height,
              ];
        });
    }
    return boxes;
  }, selectors);
}

function assertBoxes(boxes, frame, where) {
  for (const key of Object.keys(selectors)) {
    const expected = frame[key] === undefined ? [] : [frame[key]];
    assert.equal(boxes[key].length, expected.length, `${where}: ${key} count`);
    expected.forEach((box, index) => {
      box.forEach((value, axis) => {
        if (value !== null)
          near(
            boxes[key][index][axis],
            value,
            `${where}: ${key}[${index}] ${'xywh'[axis]}`,
          );
      });
    });
  }
  // Docked: the bar's bottom edge is the viewport's.
  const [, top, , height] = boxes.bar[0];
  near(top + height, phone.height, `${where}: bar bottom`);
}

// The tokens as the browser resolves them in the page's theme.
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
      ink: colour('ink'),
      ink600: colour('ink-600'),
      surface: colour('surface'),
      coral: colour('coral'),
      coralTint: colour('coral-tint'),
      onCoral: colour('on-coral'),
      error: colour('error'),
      errorText: colour('error-text'),
      bar: shadow('var(--shadow-sticky), var(--edge)'),
    };
    probe.remove();
    return tokens;
  });
}

function styles(page) {
  return page.evaluate((entries) => {
    const { document, getComputedStyle } = globalThis;
    const read = (selector) => {
      const element = [...document.querySelectorAll(selector)].find(
        (candidate) => candidate.getClientRects().length > 0,
      );
      if (element === undefined) return null;
      const css = getComputedStyle(element);
      return {
        font: `${css.fontSize}/${css.lineHeight} ${css.fontWeight}`,
        color: css.color,
        background: css.backgroundColor,
        shadow: css.boxShadow,
        border: `${css.borderTopWidth} ${css.borderTopColor}`,
        padding: `${css.paddingTop} ${css.paddingRight} ${css.paddingBottom} ${css.paddingLeft}`,
        position: css.position,
        disabled: element.disabled ?? null,
      };
    };
    return Object.fromEntries(
      Object.entries(entries).map(([key, selector]) => [key, read(selector)]),
    );
  }, selectors);
}

// The bar's colours, type and frame, common to every frame that shows it.
async function assertBarStyle(page, where) {
  const tokens = await resolveTokens(page);
  const css = await styles(page);
  assert.equal(css.bar.position, 'fixed', `${where}: docked`);
  assert.equal(css.bar.background, tokens.surface, `${where}: bar surface`);
  assert.equal(css.bar.shadow, tokens.bar, `${where}: sticky shadow + edge`);
  assert.equal(
    css.bar.padding,
    `12px 16px ${homeIndicator}px 16px`,
    `${where}: bar padding`,
  );
  return { tokens, css };
}

async function assertMicroline(page, where, giveawayOpen = true) {
  const micro = await page.locator(selectors.micro).evaluate((element) => ({
    text: element.textContent,
    link: element.querySelector('a')?.getAttribute('href') ?? null,
    color: globalThis.getComputedStyle(element).color,
    font: `${globalThis.getComputedStyle(element).fontSize}/${globalThis.getComputedStyle(element).lineHeight}`,
  }));
  assert.equal(
    micro.text,
    giveawayOpen
      ? `${signupFormCopy.ageStatement} ${signupFormCopy.freeEntryDisclosure} ${signupFormCopy.giveawayRulesLink}${signupFormCopy.giveawayRulesLinkEnd}`
      : signupFormCopy.ageStatement,
    `${where}: microline copy`,
  );
  assert.equal(
    micro.link,
    giveawayOpen ? '/giveaway/rules' : null,
    `${where}: rules link`,
  );
  assert.equal(micro.font, '13px/18px', `${where}: microline 13/18`);
  return micro;
}

async function assertEntryCopy(page, where) {
  assert.equal(
    await page.locator(selectors.bar).getAttribute('aria-label'),
    signupFormCopy.barLabel,
    `${where}: labelled region`,
  );
  assert.equal(
    await page.locator(selectors.bar).getAttribute('role'),
    'region',
    `${where}: region role`,
  );
  assert.equal(
    await page.locator(selectors.label).textContent(),
    signupFormCopy.barEmailLabel,
    `${where}: label`,
  );
  assert.equal(
    await page.locator(selectors.input).getAttribute('placeholder'),
    landingCopy.form.placeholder,
    `${where}: placeholder`,
  );
}

test('frame 1, hero in view: the bar stays hidden while the hero form is on screen', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await openPage({ colorScheme });
    try {
      await page.locator('#signup-email').fill('alex@example.com');
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
      assert.equal(await page.evaluate(barShown), false, colorScheme);
      assert.equal(await page.locator(selectors.bar).isVisible(), false);
      // Scrolled until only the form's last pixel is on screen: still hidden.
      await page.evaluate(() => {
        const form = globalThis.document.querySelector(
          'valstara-signup-form form',
        );
        globalThis.scrollTo(
          0,
          form.getBoundingClientRect().bottom + globalThis.scrollY - 1,
        );
      });
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
      assert.equal(await page.evaluate(barShown), false, colorScheme);
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.dataset.signupDock,
        ),
        undefined,
        `${colorScheme}: no space reserved`,
      );
    } finally {
      await context.close();
    }
  }
});

test('frame 2, scrolled past the hero: the bar slides in as drawn and the page reserves its height', async () => {
  for (const colorScheme of themes) {
    const where = `frame 2, ${colorScheme}`;
    const { context, page } = await openPage({ colorScheme });
    try {
      await scrollPastHero(page);
      await page.waitForFunction(barShown);
      const reveal = await page.evaluate(() => {
        const [animation] = globalThis.document
          .querySelector('[data-dock]')
          .getAnimations();
        return animation === undefined
          ? null
          : {
              name: animation.animationName,
              duration: animation.effect.getComputedTiming().duration,
              from: animation.effect.getKeyframes()[0].transform,
            };
      });
      assert.ok(reveal !== null, `${where}: the bar slides in`);
      assert.equal(reveal.name, 'signup-dock-in');
      assert.ok(
        reveal.duration >= 150 && reveal.duration <= 200,
        `${where}: slide is 150–200ms, got ${reveal.duration}`,
      );
      assert.equal(reveal.from, 'translateY(100%)', `${where}: from below`);
      await settle(page);
      const boxes = await measure(page);
      assertBoxes(boxes, frames[2], where);
      const { tokens, css } = await assertBarStyle(page, where);
      await assertEntryCopy(page, where);
      assert.equal(
        css.label.font,
        '13px/18px 600',
        `${where}: label 13/18 600`,
      );
      assert.equal(css.label.color, tokens.ink, `${where}: label ink`);
      assert.equal(css.button.background, tokens.coral, `${where}: primary`);
      assert.equal(css.button.color, tokens.onCoral, `${where}: on-coral`);
      assert.equal(css.button.font, '16px/24px 600', `${where}: Join 16/24`);
      assert.equal(css.button.padding, '0px 16px 0px 16px', `${where}: 0 16`);
      assert.equal(
        await page.locator(selectors.button).textContent(),
        landingCopy.form.submit,
      );
      assert.equal(css.input.font, '16px/24px 400', `${where}: field 16/24`);
      const micro = await assertMicroline(page, where);
      assert.equal(micro.color, tokens.ink600, `${where}: microline ink-600`);
      // The page gains bottom padding equal to the bar's height.
      const reserved = await page.evaluate(() =>
        Number.parseFloat(
          globalThis.getComputedStyle(globalThis.document.body).paddingBottom,
        ),
      );
      near(reserved, boxes.bar[0][3], `${where}: body padding = bar height`);
    } finally {
      await context.close();
    }
  }
});

test('frame 3, focus while tabbing: the scroll padding is the bar height plus 16px and focus lands clear of the bar', async () => {
  for (const colorScheme of themes) {
    const where = `frame 3, ${colorScheme}`;
    const { context, page } = await openPage({ colorScheme });
    try {
      await revealBar(page);
      const { bar } = await measure(page);
      const padding = await page.evaluate(() =>
        Number.parseFloat(
          globalThis.getComputedStyle(globalThis.document.documentElement)
            .scrollPaddingBottom,
        ),
      );
      near(padding, bar[0][3] + clearance, `${where}: scroll padding`);
      // As drawn: tabbing through the FAQ items above the bar. The first is
      // placed mid-screen, so the footer is still below the viewport.
      await page
        .locator('#faq summary')
        .first()
        .evaluate((summary) => {
          summary.scrollIntoView({ block: 'center' });
          summary.focus({ preventScroll: true });
        });
      await page.waitForFunction(barShown);
      let checked = 0;
      const count = await page.locator('#faq summary').count();
      for (let index = 1; index < count; index += 1) {
        do {
          await page.keyboard.press('Tab');
        } while (
          !(await page.evaluate(() =>
            globalThis.document.activeElement?.matches('#faq summary'),
          ))
        );
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              globalThis.requestAnimationFrame(() =>
                globalThis.requestAnimationFrame(resolve),
              ),
            ),
        );
        const gap = await page.evaluate(() => {
          const bar = globalThis.document.querySelector('[data-dock]');
          if (bar.hidden) return null;
          return (
            bar.getBoundingClientRect().top -
            globalThis.document.activeElement.getBoundingClientRect().bottom
          );
        });
        if (gap === null) continue;
        checked += 1;
        assert.ok(
          gap >= clearance,
          `${where}: FAQ item ${index + 1} sits ${gap}px above the bar`,
        );
      }
      assert.ok(checked > 0, `${where}: an FAQ item was focused over the bar`);
    } finally {
      await context.close();
    }
  }
});

test('frame 4, inline error: the bar grows upward with the field error linked to the field', async () => {
  for (const colorScheme of themes) {
    const where = `frame 4, ${colorScheme}`;
    const { context, page } = await openPage({ colorScheme });
    try {
      await revealBar(page);
      const before = (await measure(page)).bar[0];
      await page.route('**/api/signup', (route) =>
        json(route, 400, {
          error: { code: 'invalid_email', message: signupCopy.invalidEmail },
        }),
      );
      await page.locator(selectors.input).fill('alex.morgan@example');
      await page.locator(selectors.button).click();
      await page.waitForSelector('[data-dock-error]:visible');
      await settle(page);
      const boxes = await measure(page);
      assertBoxes(boxes, frames[4], where);
      assert.ok(
        boxes.bar[0][1] < before[1],
        `${where}: the bar grows upward (${before[1]} → ${boxes.bar[0][1]})`,
      );
      const { tokens, css } = await assertBarStyle(page, where);
      assert.equal(
        await page.locator('[data-dock-error] [data-message]').textContent(),
        'Enter a valid email address.',
      );
      assert.equal(
        await page.locator(selectors.input).getAttribute('aria-invalid'),
        'true',
      );
      assert.ok(
        (await page.locator(selectors.input).getAttribute('aria-describedby'))
          .split(' ')
          .includes(await page.locator(selectors.error).getAttribute('id')),
        `${where}: aria-describedby names the message`,
      );
      assert.equal(
        css.input.border,
        `2px ${tokens.error}`,
        `${where}: input error style`,
      );
      assert.equal(css.error.font, '14px/20px 600', `${where}: message 14/20`);
      assert.equal(css.error.color, tokens.errorText, `${where}: error text`);
      assert.equal(css.errorIcon.color, tokens.error, `${where}: error icon`);
      await assertMicroline(page, where);
      // The reserved space follows the taller bar.
      const reserved = await page.evaluate(() =>
        Number.parseFloat(
          globalThis.getComputedStyle(globalThis.document.body).paddingBottom,
        ),
      );
      near(reserved, boxes.bar[0][3], `${where}: body padding follows`);
    } finally {
      await context.close();
    }
  }
});

test('frame 5, submitting: the button is disabled with the spinner and the in-flight label, and the field stays readable', async () => {
  for (const colorScheme of themes) {
    const where = `frame 5, ${colorScheme}`;
    const { context, page } = await openPage({ colorScheme });
    try {
      await revealBar(page);
      await page.route('**/api/signup', () => undefined);
      await page.locator(selectors.input).fill('alex@example.com');
      await page.locator(selectors.button).click();
      await page.waitForFunction(
        (label) =>
          globalThis.document.querySelector('[data-dock-submit-label]')
            ?.textContent === label,
        signupFormCopy.submitting,
      );
      await settle(page);
      assertBoxes(await measure(page), frames[5], where);
      const { tokens, css } = await assertBarStyle(page, where);
      assert.equal(css.button.disabled, true, `${where}: disabled`);
      assert.equal(css.button.background, tokens.coralTint, `${where}: tint`);
      assert.equal(css.button.color, tokens.ink600, `${where}: ink-600 label`);
      assert.equal(
        await page.locator(selectors.button).textContent(),
        signupFormCopy.submitting,
      );
      assert.equal(css.input.disabled, false, `${where}: field not disabled`);
      assert.equal(css.input.color, tokens.ink, `${where}: field ink`);
      assert.equal(
        await page.locator(selectors.input).inputValue(),
        'alex@example.com',
      );
      await assertMicroline(page, where);
    } finally {
      await context.close();
    }
  }
});

test('frame 6, success: the bar collapses to one status row with no position, count or rank', async () => {
  for (const colorScheme of themes) {
    const where = `frame 6, ${colorScheme}`;
    const { context, page } = await openPage({ colorScheme });
    try {
      await revealBar(page);
      await page.route('**/api/signup', (route) =>
        json(route, 200, { status: 'pending', message: signupCopy.pending }),
      );
      await page.locator(selectors.input).fill('alex@example.com');
      await page.locator(selectors.button).click();
      await page.waitForSelector('[data-dock-confirmation]:visible');
      await settle(page);
      assertBoxes(await measure(page), frames[6], where);
      const { tokens, css } = await assertBarStyle(page, where);
      assert.equal(
        await page.locator(selectors.row).getAttribute('role'),
        'status',
      );
      assert.equal(
        await page.locator(selectors.done).textContent(),
        signupFormCopy.barConfirmation,
      );
      assert.equal(css.done.font, '16px/24px 600', `${where}: 16/24 600`);
      assert.equal(css.done.color, tokens.ink, `${where}: ink`);
      // The frame draws the mail icon (founder decision 2026-10-29).
      assert.match(
        await page.locator(selectors.doneIcon).getAttribute('class'),
        /\bicon--mail\b/u,
        `${where}: mail icon, as drawn`,
      );
      assert.equal(
        await page.locator(selectors.close).textContent(),
        signupFormCopy.barClose,
      );
      assert.equal(css.close.font, '14px/20px 600', `${where}: Close 14/20`);
      assert.equal(css.close.background, tokens.surface, `${where}: secondary`);
      assert.doesNotMatch(
        await page.locator(selectors.bar).innerText(),
        /\d/u,
        `${where}: no position, count or rank`,
      );
      assert.ok(
        await page
          .locator(selectors.close)
          .evaluate((element) => element === globalThis.document.activeElement),
        `${where}: focus moves to Close`,
      );
      // Close dismisses the bar and releases the reserved space.
      await page.locator(selectors.close).click();
      assert.equal(await page.evaluate(barShown), false);
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.dataset.signupDock,
        ),
        undefined,
      );
      await page.evaluate(() => globalThis.scrollBy(0, 40));
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
      assert.equal(
        await page.evaluate(barShown),
        false,
        `${where}: stays shut`,
      );
    } finally {
      await context.close();
    }
  }
});

test('frame 7, footer in view: the bar hides so the footer links and legal lines are never covered', async () => {
  for (const colorScheme of themes) {
    const where = `frame 7, ${colorScheme}`;
    const { context, page } = await openPage({ colorScheme });
    try {
      await revealBar(page);
      await page.evaluate(() =>
        globalThis.document
          .querySelector('body > footer')
          .scrollIntoView({ block: 'start' }),
      );
      await page.waitForFunction(
        () => globalThis.document.querySelector('[data-dock]').hidden,
      );
      assert.equal(await page.locator(selectors.bar).isVisible(), false);
      const covered = await page.evaluate(() => {
        globalThis.scrollTo(
          0,
          globalThis.document.documentElement.scrollHeight,
        );
        return [
          ...globalThis.document.querySelectorAll(
            'body > footer a, body > footer p',
          ),
        ]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            if (rect.bottom <= 0 || rect.top >= globalThis.innerHeight)
              return false;
            const top = globalThis.document.elementFromPoint(
              rect.left + rect.width / 2,
              Math.min(rect.top + rect.height / 2, globalThis.innerHeight - 1),
            );
            return top !== element && !element.contains(top);
          })
          .map((element) => element.textContent);
      });
      assert.deepEqual(covered, [], `${where}: nothing covers the footer`);
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
      assert.equal(await page.evaluate(barShown), false, where);
    } finally {
      await context.close();
    }
  }
});

test('the visibility matrix: small widths only, never over the hero form or with the footer in view, never paused or without JavaScript', async () => {
  for (const width of [320, 360, 390, 767, 768, 1024, 1440]) {
    const { context, page } = await openPage({
      viewport: { width, height: 844 },
      safeArea: 0,
    });
    try {
      // A sweep from top to bottom in 200px steps: wherever the bar shows,
      // the hero form is wholly above the viewport and the footer below it.
      const rows = await page.evaluate(async () => {
        const { document } = globalThis;
        const frame = () =>
          new Promise((resolve) =>
            globalThis.requestAnimationFrame(() =>
              globalThis.requestAnimationFrame(resolve),
            ),
          );
        const form = document.querySelector('valstara-signup-form form');
        const footer = document.querySelector('body > footer');
        const bar = document.querySelector('[data-dock]');
        const states = [];
        const end = document.documentElement.scrollHeight;
        for (let y = 0; y <= end; y += 200) {
          globalThis.scrollTo(0, y);
          await frame();
          const rendered = bar.getClientRects().length > 0;
          states.push({
            y: globalThis.scrollY,
            rendered,
            hidden: bar.hidden,
            heroBottom: form.getBoundingClientRect().bottom,
            footerTop: footer.getBoundingClientRect().top,
            height: globalThis.innerHeight,
          });
        }
        return states;
      });
      const shown = rows.filter((row) => row.rendered);
      if (width < 768) {
        assert.ok(shown.length > 0, `${width}px: the bar shows past the hero`);
      } else {
        assert.deepEqual(shown, [], `${width}px: never at 48rem or wider`);
      }
      for (const row of shown) {
        assert.ok(row.heroBottom <= 0, `${width}px at ${row.y}: over the hero`);
        assert.ok(
          row.footerTop >= row.height,
          `${width}px at ${row.y}: footer in view`,
        );
      }
      for (const row of rows.filter(
        (entry) =>
          width < 768 &&
          entry.heroBottom <= 0 &&
          entry.footerTop >= entry.height,
      ))
        assert.equal(row.rendered, true, `${width}px at ${row.y}: shows`);
    } finally {
      await context.close();
    }
  }

  // Signups paused: no bar, and nothing docked, at any scroll position.
  const paused = await openPage({ html: signupsPausedPage, safeArea: 0 });
  try {
    assert.equal(await paused.page.locator('[data-dock]').count(), 0);
    assert.equal(await paused.page.locator('valstara-signup-form').count(), 0);
    for (const fraction of [0.25, 0.5, 0.75]) {
      const docked = await paused.page.evaluate((share) => {
        globalThis.scrollTo(
          0,
          globalThis.document.documentElement.scrollHeight * share,
        );
        return [...globalThis.document.querySelectorAll('body *')].filter(
          (element) =>
            globalThis.getComputedStyle(element).position === 'fixed' &&
            element.getClientRects().length > 0 &&
            !element.matches('.skip-link'),
        ).length;
      }, fraction);
      assert.equal(docked, 0, `paused at ${fraction}: nothing docked`);
    }
  } finally {
    await paused.context.close();
  }

  // Without JavaScript the bar is server-hidden and never appears.
  const noScript = await openPage({ javaScriptEnabled: false, safeArea: 0 });
  try {
    await scrollPastHero(noScript.page);
    assert.equal(
      await noScript.page.locator('[data-dock]').getAttribute('hidden'),
      '',
    );
    assert.equal(await noScript.page.locator('[data-dock]').isVisible(), false);
  } finally {
    await noScript.context.close();
  }

  // Resizing from small to medium hides a showing bar.
  const resized = await openPage({ safeArea: 0 });
  try {
    await revealBar(resized.page);
    await resized.page.setViewportSize({ width: 768, height: 844 });
    await resized.page.waitForFunction(
      () => globalThis.document.querySelector('[data-dock]').hidden,
    );
    assert.equal(await resized.page.locator('[data-dock]').isVisible(), false);
  } finally {
    await resized.context.close();
  }
});

test('the focus walk: tabbing through the whole page, every focused element sits at least 16px above the bar', async () => {
  for (const width of [320, 360, 390]) {
    const { context, page } = await openPage({
      viewport: { width, height: 844 },
      safeArea: 0,
    });
    try {
      const total = await page.evaluate(
        () =>
          globalThis.document.querySelectorAll(
            'a[href], button, input:not([type="hidden"]), summary, [tabindex="0"]',
          ).length,
      );
      let barSeen = 0;
      let last = null;
      for (let index = 0; index < total + 20; index += 1) {
        await page.keyboard.press('Tab');
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              globalThis.requestAnimationFrame(() =>
                globalThis.requestAnimationFrame(resolve),
              ),
            ),
        );
        const state = await page.evaluate(() => {
          const { document } = globalThis;
          const active = document.activeElement;
          const bar = document.querySelector('[data-dock]');
          if (active === null || active === document.body)
            return { done: true };
          const target = active.getBoundingClientRect();
          return {
            done: false,
            name: `${active.tagName.toLowerCase()} ${active.textContent?.trim().slice(0, 30) ?? ''}`,
            inFooter: active.closest('body > footer') !== null,
            inBar: bar.contains(active),
            barShown: !bar.hidden,
            gap: bar.hidden
              ? null
              : bar.getBoundingClientRect().top - target.bottom,
            size: target.width * target.height,
          };
        });
        if (state.done) break;
        last = state;
        if (state.barShown && !state.inBar && state.size > 0) {
          barSeen += 1;
          assert.ok(
            state.gap >= clearance,
            `${width}px: "${state.name}" sits ${state.gap}px above the bar`,
          );
        }
      }
      assert.ok(barSeen > 0, `${width}px: the walk ran with the bar shown`);
      assert.equal(
        last?.inFooter,
        true,
        `${width}px: the walk reached the end`,
      );
    } finally {
      await context.close();
    }
  }
});

test('the safe area: a 34px inset pads the bar 34px at the bottom, and without one it is 12px', async () => {
  for (const [safeArea, expected] of [
    [homeIndicator, homeIndicator],
    [0, 12],
    [8, 12],
  ]) {
    const { context, page } = await openPage({ safeArea });
    try {
      await revealBar(page);
      const geometry = await page.evaluate(() => {
        const bar = globalThis.document.querySelector('[data-dock]');
        const micro = bar.querySelector('.signup-age');
        const style = globalThis.getComputedStyle(bar);
        return {
          padding: Number.parseFloat(style.paddingBottom),
          top: Number.parseFloat(style.paddingTop),
          // The microline's text ends where the bottom padding starts.
          below:
            bar.getBoundingClientRect().bottom -
            (micro.getBoundingClientRect().bottom -
              Number.parseFloat(
                globalThis.getComputedStyle(micro).paddingBottom,
              )),
        };
      });
      assert.equal(geometry.padding, expected, `inset ${safeArea}`);
      assert.equal(geometry.top, 12, `inset ${safeArea}: top padding`);
      near(geometry.below, expected, `inset ${safeArea}: space under the text`);
    } finally {
      await context.close();
    }
  }
});

test('the giveaway off: the bar microline is only the 18+ statement', async () => {
  const { context, page } = await openPage({ html: giveawayOffPage });
  try {
    await revealBar(page);
    await assertMicroline(page, 'giveaway off', false);
    // One 18px line: the bar is 18px shorter than frame 2.
    near(
      (await measure(page)).bar[0][3],
      frames[2].bar[3] - 18,
      'giveaway off: bar height',
    );
  } finally {
    await context.close();
  }
});

test('reduced motion: the bar appears without sliding', async () => {
  for (const reducedMotion of ['reduce', 'no-preference']) {
    const { context, page } = await openPage({ reducedMotion });
    try {
      await scrollPastHero(page);
      await page.waitForFunction(barShown);
      const motion = await page.evaluate(() => {
        const bar = globalThis.document.querySelector('[data-dock]');
        return {
          name: globalThis.getComputedStyle(bar).animationName,
          running: bar.getAnimations().length,
          top: bar.getBoundingClientRect().bottom,
        };
      });
      if (reducedMotion === 'reduce') {
        assert.deepEqual(
          { name: motion.name, running: motion.running },
          { name: 'none', running: 0 },
        );
        // Already at rest on its first frame.
        near(motion.top, phone.height, 'reduced motion: at rest at once');
      } else {
        assert.equal(motion.name, 'signup-dock-in');
        assert.equal(motion.running, 1);
      }
    } finally {
      await context.close();
    }
  }
});

test('with the bar visible, the page passes WCAG axe and the layout checks in both themes', async () => {
  for (const colorScheme of themes) {
    for (const width of [320, 360, 390]) {
      for (const state of [
        'entry',
        'error',
        'checking',
        'submitting',
        'success',
      ]) {
        const where = `${state} at ${width}, ${colorScheme}`;
        const { context, page } = await openPage({
          viewport: { width, height: 844 },
          colorScheme,
          turnstile: state === 'checking' ? 'pending' : 'success',
        });
        try {
          await revealBar(page);
          if (state !== 'entry') {
            await page.route('**/api/signup', (route) => {
              if (state === 'submitting') return undefined;
              return state === 'error'
                ? json(route, 400, {
                    error: {
                      code: 'invalid_email',
                      message: signupCopy.invalidEmail,
                    },
                  })
                : json(route, 200, {
                    status: 'pending',
                    message: signupCopy.pending,
                  });
            });
            await page
              .locator(selectors.input)
              .fill(
                state === 'error' ? 'alex.morgan@example' : 'alex@example.com',
              );
            await page.locator(selectors.button).click();
            if (state === 'checking' || state === 'submitting')
              await page.waitForFunction(
                (label) =>
                  globalThis.document.querySelector('[data-dock-submit-label]')
                    ?.textContent === label,
                state === 'checking'
                  ? signupFormCopy.challengePending
                  : signupFormCopy.submitting,
              );
            else
              await page.waitForSelector(
                state === 'error'
                  ? '[data-dock-error]:visible'
                  : '[data-dock-confirmation]:visible',
              );
          }
          await settle(page);
          assert.equal(await page.evaluate(barShown), true, where);
          await page.addScriptTag({ content: axe.source });
          const violations = await page.evaluate(async () => {
            const result = await globalThis.axe.run(globalThis.document, {
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
            });
            return result.violations.map((violation) => ({
              id: violation.id,
              targets: violation.nodes.map((node) => node.target),
            }));
          });
          assert.deepEqual(violations, [], `${where}: axe`);
          assert.deepEqual(
            await checkPageLayout(page),
            [],
            `${where}: layout checks`,
          );
        } finally {
          await context.close();
        }
      }
    }
  }
});
