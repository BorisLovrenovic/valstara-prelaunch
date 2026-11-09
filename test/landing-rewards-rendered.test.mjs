import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import axe from 'axe-core';
import sharp from 'sharp';

import { landingCopy } from '../src/copy/landing.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { renderLanding } from './helpers/landing-render.mjs';
import { entranceEnded } from './helpers/motion.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import {
  checkRegionLayout,
  designWidths,
} from '../scripts/design/layout-checks.mjs';

// E11.5-11e built the #rewards section from the wireframes; E11.5-11o
// restyles it to the final-design canvas (Rewards.dc.html as the landing
// boards and Switches.dc.html place it) and adds its motion. Every box is
// compared with the canvas's own, measured from the pinned snapshot by
// test/fixtures/final-ui/measure-rewards-geometry.mjs on the self-hosted
// fonts, at rest (a reduced-motion context, design rule 12), with a 1px
// tolerance, in both themes.

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const browserContainer = `valstara-landing-rewards-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const themes = ['light', 'dark'];
const tolerance = 1;
const rulesPath = 'src/content/giveaway-rules/VAL-GW-LAUNCH-20261009-r1.md';
const configPath = 'src/server/referral/config.ts';
const canvas = JSON.parse(
  await readFile(
    join(projectRoot, 'test/fixtures/final-ui/rewards-geometry.json'),
    'utf8',
  ),
);
const canvasWidths = [1440, 1024, 768, 390, 320];

const giveawayOn = { key: 'giveaway.open', enabled: true };
const referralOff = { key: 'referral.enabled', enabled: false };
const leaderboardOff = { key: 'leaderboard.public', enabled: false };

// Switches.dc.html. The registered defaults are signup, referral and
// leaderboard on, giveaway off, so variant B is the default page.
const variants = {
  A: {
    flags: [giveawayOn],
    cards: ['access', 'referral', 'giveaway'],
    tiers: 1,
    verified: true,
    leaderboard: true,
  },
  B: {
    flags: [],
    cards: ['access', 'referral'],
    tiers: 1,
    verified: true,
    leaderboard: true,
  },
  C: {
    flags: [giveawayOn, referralOff],
    cards: ['access', 'giveaway'],
    tiers: 0,
    verified: true,
    leaderboard: true,
  },
  D: {
    flags: [giveawayOn, leaderboardOff],
    cards: ['access', 'referral', 'giveaway'],
    tiers: 1,
    verified: true,
    leaderboard: false,
  },
  E: {
    flags: [referralOff, leaderboardOff],
    cards: ['access'],
    tiers: 0,
    verified: false,
    leaderboard: false,
  },
  // F is served from a build with a second tier configured (see before()).
  // Its figures differ from the canvas's (4 → 17% and 6 → 30%, 4 × €350,
  // against 3 → 15% and 5 → 25%, 5 × €300), but no box depends on them: the
  // figures are single digits and mono-width values, and the person and gift
  // rows are full-width containers.
  F: {
    flags: [giveawayOn],
    cards: ['access', 'referral', 'giveaway'],
    tiers: 2,
    verified: true,
    leaderboard: true,
  },
};

let app;
let browser;
let browserOrigin;
let browserServer;
let changedRoot;
const pages = {};

function frontmatterNumber(source, key) {
  const value = Number(new RegExp(`^${key}: (\\d+)$`, 'mu').exec(source)?.[1]);
  assert.ok(Number.isFinite(value), `rules frontmatter ${key}`);
  return value;
}

function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, `exactly one "${from}"`);
  return source.replace(from, to);
}

// A copy of the project built with a changed ladder (tier 1 at 4 → 17%, and
// tier 2 switched on at 6 → 30%) and changed published rules (4 prizes at
// €350), the way a configuration or rules revision changes them.
async function buildChangedFixture(rulesArticle) {
  const root = await mkdtemp(join(tmpdir(), 'valstara-rewards-'));
  for (const path of ['src', 'public']) {
    await cp(join(projectRoot, path), join(root, path), { recursive: true });
  }
  for (const path of ['astro.config.mjs', 'package.json', 'tsconfig.json']) {
    await cp(join(projectRoot, path), join(root, path));
  }
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'));

  const revisedArticle = rulesArticle
    .replace('5 prizes', '4 prizes')
    .replace('€300', '€350')
    .replace('€1,500', '€1,400');
  assert.notEqual(revisedArticle, rulesArticle);
  const revisedHash = createHash('sha256')
    .update(revisedArticle, 'utf8')
    .digest('hex');
  let rules = await readFile(join(root, rulesPath), 'utf8');
  rules = replaceOnce(rules, 'prizeCount: 5', 'prizeCount: 4');
  rules = replaceOnce(
    rules,
    'prizeApproxRetailValueEur: 300',
    'prizeApproxRetailValueEur: 350',
  );
  rules = rules
    .replace('5 prizes', '4 prizes')
    .replace('€300', '€350')
    .replace('€1,500', '€1,400')
    .replace(/sha256: '[a-f0-9]{64}'/u, `sha256: '${revisedHash}'`);
  await writeFile(join(root, rulesPath), rules);

  let config = await readFile(join(root, configPath), 'utf8');
  config = replaceOnce(config, 'discountPercent: 15', 'discountPercent: 17');
  config = replaceOnce(config, 'threshold: 3', 'threshold: 4');
  config = replaceOnce(config, 'discountPercent: 25', 'discountPercent: 30');
  config = replaceOnce(config, 'enabled: false', 'enabled: true');
  config = replaceOnce(config, 'threshold: 5', 'threshold: 6');
  await writeFile(join(root, configPath), config);

  await execFileAsync(join(projectRoot, 'node_modules/.bin/astro'), ['build'], {
    cwd: root,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    timeout: 180_000,
  });
  return root;
}

async function startBrowserServer() {
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
  // Each variant is rendered by a server reading real campaign_flag rows.
  for (const [name, variant] of Object.entries(variants)) {
    if (name === 'F') continue;
    if (name === 'A') {
      const [landing, rulesPage] = await renderLanding({
        flags: variant.flags,
        paths: ['/', '/giveaway/rules'],
      });
      pages.A = { html: landing.body };
      pages.rulesArticle =
        /<article\b[^>]*data-rules-version="[^"]+"[^>]*data-rules-sha256="[a-f0-9]{64}"[^>]*>([\s\S]*?)<\/article>/u.exec(
          rulesPage.body,
        )?.[1];
      assert.ok(pages.rulesArticle, 'the current rules article renders');
      continue;
    }
    pages[name] = {
      html: (await renderLanding({ flags: variant.flags })).body,
    };
  }
  changedRoot = await buildChangedFixture(pages.rulesArticle);
  pages.F = {
    html: (await renderLanding({ flags: variants.F.flags, root: changedRoot }))
      .body,
    assets: join(changedRoot, 'dist/client'),
  };

  // The browser loads each variant's HTML at this app's origin, so its
  // stylesheets come from the same build (F's from its own dist).
  app = await startAppServer({
    label: 'Landing rewards test',
    env: () => ({
      ADMIN_CREDENTIAL: 'landing-rewards-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-rewards',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'landing-rewards-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'landing-rewards-referral-secret',
      RESEND_API_KEY: 'landing-rewards-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'landing-rewards-turnstile-secret',
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
  if (changedRoot !== undefined)
    await rm(changedRoot, { recursive: true, force: true });
});

const contentTypes = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// Opens a variant's HTML at the app origin. A document fulfilled by the test
// cannot load unrouted subresources in the connected browser, so its
// same-origin requests are answered from the variant's own build output, or
// from the running app server. With `motion: true` the page allows motion
// and the hero entrance is let end; otherwise it is at rest (reduced
// motion, design rule 12).
async function openVariant(
  name,
  { width, height = 900, colorScheme = 'light', motion = false },
) {
  const { html, assets } = pages[name];
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme,
    reducedMotion: motion ? 'no-preference' : 'reduce',
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.abort(),
  );
  await context.route(`${browserOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/')
      return route.fulfill({
        body: html,
        contentType: 'text/html; charset=utf-8',
      });
    if (route.request().method() !== 'GET')
      return route.fulfill({ status: 204 });
    if (assets !== undefined && url.pathname.startsWith('/_astro/')) {
      return route.fulfill({
        body: await readFile(join(assets, url.pathname)),
        contentType:
          contentTypes[extname(url.pathname)] ?? 'application/octet-stream',
      });
    }
    const response = await globalThis.fetch(
      `http://127.0.0.1:${app.port}${url.pathname}${url.search}`,
    );
    return route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? undefined,
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  const page = await context.newPage();
  await page.goto(browserOrigin);
  await page.evaluate(() => globalThis.document.fonts.ready);
  if (motion) await entranceEnded(page);
  return { context, page };
}

// Every box (in the canvas fixture's shape, relative to the reward grid),
// style and figure the assertions read.
function measure(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const grid = document.querySelector('.landing-rewards');
    const origin = grid.getBoundingClientRect();
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return [
        rect.left - origin.left,
        rect.top - origin.top,
        rect.width,
        rect.height,
      ];
    };
    const all = (selector, from = document) =>
      [...from.querySelectorAll(selector)].map(box);
    const one = (selector) => box(document.querySelector(selector));
    const style = (element, pseudo) => {
      if (!element) return null;
      const css = getComputedStyle(element, pseudo);
      return {
        font: `${css.fontSize}/${css.lineHeight} ${css.fontWeight}`,
        family: css.fontFamily,
        color: css.color,
        background: css.backgroundColor,
        radius: css.borderTopLeftRadius,
        borderTop: `${css.borderTopWidth} ${css.borderTopStyle}`,
        borderTopColor: css.borderTopColor,
        borderBottom: `${css.borderBottomWidth} ${css.borderBottomStyle}`,
        borderBottomColor: css.borderBottomColor,
        borderLeft: `${css.borderLeftWidth} ${css.borderLeftStyle}`,
        borderLeftColor: css.borderLeftColor,
        padding: [
          css.paddingTop,
          css.paddingRight,
          css.paddingBottom,
          css.paddingLeft,
        ].map(Number.parseFloat),
        shadow: css.boxShadow,
        clipPath: css.clipPath,
        letterSpacing: css.letterSpacing,
        width: css.width,
        height: css.height,
      };
    };
    // A token's computed value, read through a probe element.
    const token = (name, property = 'color') => {
      const probe = document.createElement('span');
      probe.style.setProperty(property, `var(${name})`);
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return value;
    };
    const cardKind = (card) =>
      card.matches('[data-access-card]')
        ? 'access'
        : card.matches('[data-referral-card]')
          ? 'referral'
          : card.matches('[data-giveaway-card]')
            ? 'giveaway'
            : 'unknown';
    const cards = [...grid.children];
    const tiers = [...document.querySelectorAll('.landing-tier')];
    const footer = document.querySelector('.landing-rewards__footer');
    const track = document.querySelector('.landing-wave__track');
    const dot = getComputedStyle(track, '::after');
    const text = (element) => element?.textContent.replace(/\s+/gu, ' ').trim();
    return {
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      gridGap: Number.parseFloat(getComputedStyle(grid).rowGap),
      columnGap: Number.parseFloat(getComputedStyle(grid).columnGap),
      geometry: {
        grid: box(grid),
        cards: cards.map((card) => ({
          kind: cardKind(card),
          box: box(card),
          head: box(card.querySelector('.landing-reward__head')),
          tile: box(card.querySelector('.icon-tile')),
          h3: box(card.querySelector('h3')),
          body: box(card.querySelector('.landing-reward__body')),
          visual: box(card.querySelector('.landing-reward__visual')),
          wells: all('.landing-reward__well', card),
        })),
        waveLabel: all('.landing-wave__label'),
        waveTrack: all('.landing-wave__track'),
        waveFill: all('.landing-wave__fill'),
        waveDot: [Number.parseFloat(dot.width), Number.parseFloat(dot.height)],
        waveGrid: one('.landing-wave-grid'),
        waveLines: all('.landing-wave-grid > span'),
        axis: one('.landing-wave-axis'),
        tiers: tiers.map((tier) => ({
          box: box(tier),
          count: box(tier.querySelector('.landing-tier__referrals')),
          figure: box(tier.querySelector('.landing-figure')),
          people: box(tier.querySelector('.landing-tier__people')),
          label: box(tier.querySelector('.landing-tier__label')),
          arrow: box(tier.querySelector('.landing-tier__arrow')),
          plus: box(tier.querySelector('.landing-tier__plus')),
          pills: all('.pill', tier),
        })),
        held: one('.landing-held'),
        prize: one('.landing-prize__line'),
        gifts: one('.landing-prize__gifts'),
        note: one('.landing-reward__note'),
        rulesLink: one('[data-giveaway-card] a'),
        footer: box(footer),
        verified: box(footer?.querySelector('.landing-rewards__verified')),
        leaderboardLink: box(footer?.querySelector('a')),
      },
      styles: {
        cards: cards.map((card) => style(card)),
        heads: cards.map((card) =>
          style(card.querySelector('.landing-reward__head')),
        ),
        tile: style(document.querySelector('.landing-rewards .icon-tile')),
        h3: style(document.querySelector('.landing-rewards h3')),
        body: style(document.querySelector('.landing-reward__body')),
        wells: [...document.querySelectorAll('.landing-reward__well')].map(
          (well) => style(well),
        ),
        waveLabel: style(document.querySelector('.landing-wave__label')),
        waveTrack: style(track),
        waveFill: style(document.querySelector('.landing-wave__fill')),
        waveDot: style(track, '::after'),
        waveLines: [
          ...document.querySelectorAll('.landing-wave-grid > span'),
        ].map((line) => style(line)),
        axis: style(document.querySelector('.landing-wave-axis')),
        axisRule: style(
          document.querySelector('.landing-wave-axis'),
          '::before',
        ),
        tiers: tiers.map((tier) => style(tier)),
        figure: style(document.querySelector('.landing-tier .landing-figure')),
        people: style(document.querySelector('.landing-tier__people')),
        label: style(document.querySelector('.landing-tier__label')),
        arrow: style(document.querySelector('.landing-tier__arrow')),
        plus: style(document.querySelector('.landing-tier__plus')),
        pills: [...document.querySelectorAll('.landing-tier .pill')].map(
          (pill) => style(pill),
        ),
        held: style(document.querySelector('.landing-held')),
        prizeFigure: style(
          document.querySelector('.landing-prize__line .landing-figure'),
        ),
        prizeWords: style(document.querySelector('.landing-prize__words')),
        gifts: style(document.querySelector('.landing-prize__gifts')),
        note: style(document.querySelector('.landing-reward__note')),
        verified: style(document.querySelector('.landing-rewards__verified')),
        verifiedIcon: style(
          document.querySelector('.landing-rewards__verified .icon'),
        ),
      },
      tiers: tiers.map((tier) => ({
        figure: text(tier.querySelector('.landing-figure')),
        people: tier.querySelectorAll('.landing-tier__people svg').length,
        discount: text(tier.querySelector('.pill--coral .tabular-figure')),
        sentence: text(tier.querySelector('.landing-hidden')),
        hidden: style(tier.querySelector('.landing-hidden')),
        hiddenBox: box(tier.querySelector('.landing-hidden')),
        box: box(tier),
        equationHidden: tier
          .querySelector('.landing-tier__equation')
          .getAttribute('aria-hidden'),
      })),
      prizeFigures: [
        ...document.querySelectorAll('.landing-prize__line .landing-figure'),
      ].map(text),
      gifts: document.querySelectorAll('.landing-prize__gifts svg').length,
      giftsHidden: document
        .querySelector('.landing-prize__gifts')
        ?.getAttribute('aria-hidden'),
      prizeSentence: text(
        document.querySelector('.landing-prize .landing-hidden'),
      ),
      noteText: text(document.querySelector('.landing-reward__note')),
      rulesHref: document
        .querySelector('[data-giveaway-card] a')
        ?.getAttribute('href'),
      leaderboardHref: footer?.querySelector('a')?.getAttribute('href'),
      axisHidden: document
        .querySelector('.landing-wave-axis')
        .getAttribute('aria-hidden'),
      tokens: {
        ink: token('--ink'),
        ink600: token('--ink-600'),
        ink300: token('--ink-300'),
        line: token('--line'),
        washStrong: token('--wash-strong', 'background-color'),
        well: token('--well', 'background-color'),
        coral: token('--coral', 'background-color'),
        coralTint: token('--coral-tint', 'background-color'),
        onCoral: token('--on-coral'),
        surface: token('--surface'),
        shadowCard: (() => {
          const probe = document.createElement('div');
          probe.style.boxShadow = 'var(--shadow-1), var(--edge)';
          document.body.append(probe);
          const value = getComputedStyle(probe).boxShadow;
          probe.remove();
          return value;
        })(),
      },
    };
  });
}

function near(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not ${expected}`,
  );
}

// Compares a measured structure with the canvas's, box by box: a box within
// 1px on every side, a list item by item, a card's kind exactly, and an
// element the canvas does not draw absent from the build too.
function assertCanvas(actual, expected, label) {
  if (expected === null || actual === null || actual === undefined) {
    assert.equal(actual ?? null, expected, `${label} presence`);
    return;
  }
  if (typeof expected === 'string') {
    assert.equal(actual, expected, label);
    return;
  }
  if (Array.isArray(expected) && typeof expected[0] === 'number') {
    assert.equal(actual.length, expected.length, `${label} box`);
    const axes = expected.length === 4 ? ['x', 'y', 'w', 'h'] : ['w', 'h'];
    axes.forEach((axis, index) =>
      near(actual[index], expected[index], `${label} ${axis}`),
    );
    return;
  }
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${label} count`);
    expected.forEach((item, index) =>
      assertCanvas(actual[index], item, `${label} ${index + 1}`),
    );
    return;
  }
  for (const [key, value] of Object.entries(expected))
    assertCanvas(actual[key], value, `${label} ${key}`);
}

// No grid hole: the cards fill every row of the grid edge to edge, each row
// shares one top and one height, and the rows stack with the grid's gap.
function assertNoGridHoles(m, label) {
  const rows = [];
  for (const { box } of m.geometry.cards) {
    const row = rows.find((candidate) => Math.abs(candidate.top - box[1]) <= 1);
    if (row) row.boxes.push(box);
    else rows.push({ top: box[1], boxes: [box] });
  }
  let expectedTop = 0;
  for (const [index, row] of rows.entries()) {
    const widths = row.boxes.reduce((sum, box) => sum + box[2], 0);
    near(
      widths + m.columnGap * (row.boxes.length - 1),
      m.geometry.grid[2],
      `${label} row ${index + 1} spans the grid`,
    );
    near(row.boxes[0][0], 0, `${label} row ${index + 1} starts at the edge`);
    for (const box of row.boxes)
      near(box[3], row.boxes[0][3], `${label} row ${index + 1} equal heights`);
    near(row.top, expectedTop, `${label} row ${index + 1} top`);
    expectedTop = row.top + row.boxes[0][3] + m.gridGap;
  }
  near(
    expectedTop - m.gridGap,
    m.geometry.grid[3],
    `${label} the rows fill the grid height`,
  );
  return rows.length;
}

// Scrolls so the element's top sits at the given fraction of the viewport
// height, then lets the scroll-driven animations update.
async function scrollToTop(page, selector, fraction) {
  await page.evaluate(
    ([target, at]) => {
      const element = globalThis.document.querySelector(target);
      const top = element.getBoundingClientRect().top + globalThis.scrollY;
      globalThis.scrollTo({
        top: top - globalThis.innerHeight * at,
        behavior: 'instant',
      });
    },
    [selector, fraction],
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve),
        ),
      ),
  );
}

async function scrollToEnd(page) {
  await page.evaluate(() =>
    globalThis.scrollTo({
      top: globalThis.document.documentElement.scrollHeight,
      behavior: 'instant',
    }),
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve),
        ),
      ),
  );
}

// The motion state of everything in #rewards that may move, and of every
// figure, read at the current scroll position.
function readMotion(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const state = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      const animation = element
        .getAnimations()
        .find((running) => !(running instanceof globalThis.CSSTransition));
      const matrix =
        style.transform === 'none'
          ? null
          : new globalThis.DOMMatrixReadOnly(style.transform);
      const rect = element.getBoundingClientRect();
      return {
        opacity: Number(style.opacity),
        translate: style.translate,
        scaleX: matrix === null ? 1 : matrix.a,
        origin: style.transformOrigin,
        name: style.animationName,
        timeline: style.animationTimeline,
        progress: animation?.effect.getComputedTiming().progress ?? null,
        top: rect.top,
        left: rect.left,
        width: rect.width,
      };
    };
    const text = (element) => element?.textContent.replace(/\s+/gu, ' ').trim();
    return {
      cards: [...document.querySelectorAll('.landing-rewards > *')].map(
        (card) => ({
          ...state(card),
          index: card.style.getPropertyValue('--reveal-index').trim(),
          viewTimeline: getComputedStyle(card).viewTimelineName,
        }),
      ),
      fills: [...document.querySelectorAll('.landing-wave__fill')].map(
        (fill) => {
          const track = fill.parentElement;
          const rect = track.getBoundingClientRect();
          return {
            ...state(fill),
            index: track.style.getPropertyValue('--wave-index').trim(),
            start:
              rect.left +
              (rect.width *
                Number.parseFloat(
                  track.style.getPropertyValue('--wave-start'),
                )) /
                100,
          };
        },
      ),
      tiers: [...document.querySelectorAll('.landing-tier')].map((tier) => {
        const draw = tier.querySelector('.landing-tier__draw');
        const drawStyle = getComputedStyle(draw);
        const mask = draw.closest('mask');
        const arrow = tier.querySelector('.landing-tier__arrow .icon');
        return {
          ...state(tier),
          viewTimeline: getComputedStyle(tier).viewTimelineName,
          persons: [...tier.querySelectorAll('.landing-tier__person')].map(
            (person) => ({
              ...state(person),
              index: person.style.getPropertyValue('--sequence-index').trim(),
            }),
          ),
          draw: {
            offset: Number.parseFloat(drawStyle.strokeDashoffset),
            name: drawStyle.animationName,
            timeline: drawStyle.animationTimeline,
            // The arrow is painted only through the mask holding this stroke.
            masked:
              arrow.parentElement.getAttribute('mask') === `url(#${mask.id})`,
            index: draw
              .closest('.landing-tier__arrow')
              .style.getPropertyValue('--sequence-index')
              .trim(),
          },
          reward: {
            ...state(tier.querySelector('.landing-tier__reward')),
            index: tier
              .querySelector('.landing-tier__reward')
              .style.getPropertyValue('--sequence-index')
              .trim(),
          },
          steps: tier.style.getPropertyValue('--sequence-steps').trim(),
          plus: state(tier.querySelector('.landing-tier__plus')),
        };
      }),
      prize: state(document.querySelector('.landing-prize')),
      footer: state(document.querySelector('.landing-rewards__footer')),
      // Every figure on the cards: its text, and whether anything animates
      // it or writes text over it.
      figures: {
        tiers: [...document.querySelectorAll('.landing-tier')].map((tier) => ({
          figure: text(tier.querySelector('.landing-figure')),
          discount: text(tier.querySelector('.pill--coral .tabular-figure')),
          people: tier.querySelectorAll('.landing-tier__person svg').length,
          sentence: text(tier.querySelector('.landing-hidden')),
        })),
        prize: [
          ...document.querySelectorAll('.landing-prize__line .landing-figure'),
        ].map(text),
        gifts: document.querySelectorAll('.landing-prize__gifts svg').length,
        prizeSentence: text(
          document.querySelector('.landing-prize .landing-hidden'),
        ),
        motion: [
          ...document.querySelectorAll(
            '#rewards .landing-figure, #rewards .pill--coral .tabular-figure',
          ),
        ].map((figure) => ({
          declared: getComputedStyle(figure).animationName,
          animations: figure.getAnimations({ subtree: true }).length,
          before: getComputedStyle(figure, '::before').content,
          after: getComputedStyle(figure, '::after').content,
        })),
      },
      // The progress of every scroll-driven or keyframe animation in effect
      // in #rewards.
      running: document
        .getAnimations()
        .filter(
          (animation) =>
            !(animation instanceof globalThis.CSSTransition) &&
            animation.effect?.target?.closest?.('#rewards'),
        )
        .map((animation) => animation.effect.getComputedTiming().progress),
    };
  });
}

// What the screen shows of the first tier's arrow, read from a screenshot
// rather than from its mask's stroke (which animates whether or not anything
// is drawn through it): the share of the arrow's 20px box, in its left and
// right halves, painted at least half-way from the well's colour to the
// arrow's. The small-width signup dock is hidden from the capture.
async function arrowPainted(page) {
  const target = await page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const icon = document.querySelector('.landing-tier__arrow .icon');
    const box = icon.getBoundingClientRect();
    return {
      clip: { x: box.left, y: box.top, width: box.width, height: box.height },
      stroke: getComputedStyle(icon).color,
      background: getComputedStyle(icon.closest('.landing-reward__well'))
        .backgroundColor,
    };
  });
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
  const background = rgb(target.background);
  const stroke = rgb(target.stroke);
  const full = stroke.reduce(
    (sum, channel, index) => sum + Math.abs(channel - background[index]),
    0,
  );
  const halves = [0, 0];
  for (let y = 0; y < info.height; y += 1)
    for (let x = 0; x < info.width; x += 1) {
      const at = (y * info.width + x) * info.channels;
      const distance = background.reduce(
        (sum, channel, index) => sum + Math.abs(data[at + index] - channel),
        0,
      );
      if (distance >= full / 2) halves[x < info.width / 2 ? 0 : 1] += 1;
    }
  const half = (info.width * info.height) / 2;
  return halves.map((count) => count / half);
}

const atRest = (element) =>
  element.opacity === 1 && element.translate === 'none' && element.scaleX === 1;

// Every figure in a frame equals its source: the build's ladder and rules.
function assertFigures(figures, source, label) {
  assert.deepEqual(
    figures.tiers,
    source.tiers.map((tier) => ({
      figure: String(tier.threshold),
      discount: `${tier.discount}%`,
      people: tier.threshold,
      sentence: `${tier.threshold} confirmed referrals → move up an access wave and ${tier.discount}% off at launch`,
    })),
    `${label} tier figures`,
  );
  assert.deepEqual(
    figures.prize,
    [String(source.prizeCount), `€${source.prizeValue}`],
    `${label} prize figures`,
  );
  assert.equal(figures.gifts, source.prizeCount, `${label} gift icons`);
  assert.equal(
    figures.prizeSentence,
    `${source.prizeCount} prizes, approximately €${source.prizeValue} each`,
    `${label} prize sentence`,
  );
  for (const figure of figures.motion)
    assert.deepEqual(
      figure,
      { declared: 'none', animations: 0, before: 'none', after: 'none' },
      `${label} a figure is never animated or overwritten`,
    );
}

const sources = {
  A: {
    tiers: [{ threshold: 3, discount: 15 }],
    prizeCount: 5,
    prizeValue: 300,
  },
  F: {
    tiers: [
      { threshold: 4, discount: 17 },
      { threshold: 6, discount: 30 },
    ],
    prizeCount: 4,
    prizeValue: 350,
  },
};

test('card anatomy and geometry match the canvas at 1440, 1024, 768, 390 and 320, in both themes, at rest', async () => {
  for (const colorScheme of themes) {
    for (const width of canvasWidths) {
      const label = `${colorScheme} ${width}`;
      const { context, page } = await openVariant('A', { width, colorScheme });
      const m = await measure(page);
      assert.equal(m.overflow, 0, `${label} no horizontal overflow`);
      assertCanvas(m.geometry, canvas.widths[width].A, label);

      // Type, colour and surface, from the canvas and the tokens.
      const { styles, tokens } = m;
      for (const card of styles.cards) {
        assert.equal(card.radius, '12px', `${label} card radius`);
        assert.equal(card.background, tokens.surface);
        assert.equal(card.shadow, tokens.shadowCard, `${label} E1`);
        assert.deepEqual(
          card.padding,
          Array(4).fill(width >= 768 ? 32 : 24),
          `${label} card padding`,
        );
      }
      // The divider is the head's border-bottom, 20px below the H3 row, so
      // the dividers line up; the medium access card has none.
      for (const [index, head] of styles.heads.entries()) {
        if (width === 768 && index === 0) {
          assert.equal(head.borderBottom, '0px none', `${label} no divider`);
          continue;
        }
        assert.equal(head.borderBottom, '1px solid', `${label} divider`);
        assert.equal(head.borderBottomColor, tokens.line);
        assert.equal(head.padding[2], 20);
      }
      assert.equal(styles.tile.background, tokens.coralTint);
      assert.equal(styles.tile.radius, '8px');
      assert.equal(styles.h3.font, '20px/28px 600', `${label} H3 type`);
      assert.equal(styles.h3.letterSpacing, '-0.2px');
      assert.equal(styles.body.font, '16px/24px 400');
      assert.equal(styles.body.color, tokens.ink600);
      for (const well of styles.wells) {
        assert.equal(well.background, tokens.well, `${label} well`);
        assert.equal(well.radius, '8px');
        assert.deepEqual(well.padding, [16, 16, 16, 16]);
      }
      assert.equal(styles.waveLabel.font, '13px/18px 600');
      assert.match(styles.waveLabel.family, /^"JetBrains Mono"/u);
      assert.equal(styles.waveLabel.color, tokens.ink);
      assert.equal(styles.waveTrack.background, tokens.washStrong);
      assert.equal(styles.waveTrack.radius, '999px');
      assert.equal(styles.waveFill.background, tokens.ink);
      assert.equal(styles.waveDot.background, tokens.coral);
      assert.equal(styles.waveDot.shadow, `${tokens.surface} 0px 0px 0px 2px`);
      assert.deepEqual(
        styles.waveLines.map((line) => line.borderLeft),
        ['0px none', '1px dashed', '1px dashed', '1px dashed'],
        `${label} the quarter grid`,
      );
      assert.equal(styles.waveLines[1].borderLeftColor, tokens.line);
      assert.equal(styles.axis.font, '13px/18px 400');
      assert.equal(styles.axis.color, tokens.ink600);
      assert.equal(styles.axisRule.background, tokens.ink300);
      assert.equal(styles.axisRule.height, '1px');
      assert.equal(styles.figure.font, '32px/40px 600');
      assert.match(styles.figure.family, /^"JetBrains Mono"/u);
      assert.equal(styles.figure.letterSpacing, '-0.64px');
      assert.equal(styles.people.color, tokens.ink600);
      assert.equal(styles.label.font, '13px/18px 400');
      assert.equal(styles.label.color, tokens.ink600);
      for (const operator of [styles.arrow, styles.plus]) {
        assert.equal(operator.color, tokens.ink600);
        assert.equal(operator.font, '16px/24px 600');
      }
      assert.equal(styles.pills[0].background, tokens.coralTint);
      assert.equal(styles.pills[0].color, tokens.ink);
      assert.equal(styles.pills[0].font, '13px/18px 600');
      assert.equal(styles.pills[1].background, tokens.coral);
      assert.equal(styles.pills[1].color, tokens.onCoral);
      assert.equal(styles.held.font, '14px/20px 400');
      assert.equal(styles.held.color, tokens.ink600);
      assert.equal(styles.prizeFigure.font, '32px/40px 600');
      assert.equal(styles.prizeFigure.letterSpacing, '-0.64px');
      assert.equal(styles.prizeWords.font, '16px/24px 500');
      assert.equal(styles.gifts.color, tokens.ink300);
      assert.equal(styles.note.font, '14px/20px 400');
      assert.equal(styles.note.color, tokens.ink600);
      assert.equal(styles.verified.font, '14px/20px 500');
      assert.equal(styles.verifiedIcon.color, tokens.ink600);
      await context.close();
    }
  }
});

test('every figure comes from the ladder and the published rules: a changed fixture changes N, X, the person icons, the prize count, the gifts and the value', async () => {
  const rules = await readFile(join(projectRoot, rulesPath), 'utf8');
  const changedRules = await readFile(join(changedRoot, rulesPath), 'utf8');
  const { context, page } = await openVariant('A', { width: 1440 });
  const baseline = await measure(page);
  await context.close();
  const changed = await openVariant('F', { width: 1440 });
  const revised = await measure(changed.page);
  await changed.context.close();

  assert.deepEqual(
    baseline.tiers.map(({ figure, people, discount, sentence }) => ({
      figure,
      people,
      discount,
      sentence,
    })),
    [
      {
        figure: '3',
        people: 3,
        discount: '15%',
        sentence:
          '3 confirmed referrals → move up an access wave and 15% off at launch',
      },
    ],
  );
  assert.deepEqual(
    revised.tiers.map(({ figure, people, discount, sentence }) => ({
      figure,
      people,
      discount,
      sentence,
    })),
    [
      {
        figure: '4',
        people: 4,
        discount: '17%',
        sentence:
          '4 confirmed referrals → move up an access wave and 17% off at launch',
      },
      {
        figure: '6',
        people: 6,
        discount: '30%',
        sentence:
          '6 confirmed referrals → move up an access wave and 30% off at launch',
      },
    ],
  );

  // The prize figures, and one gift per prize, are the rules' own
  // frontmatter, before and after.
  for (const [measured, source] of [
    [baseline, rules],
    [revised, changedRules],
  ]) {
    const count = frontmatterNumber(source, 'prizeCount');
    const value = frontmatterNumber(source, 'prizeApproxRetailValueEur');
    assert.deepEqual(measured.prizeFigures, [String(count), `€${value}`]);
    assert.equal(measured.gifts, count);
    assert.equal(
      measured.prizeSentence,
      `${count} prizes, approximately €${value} each`,
    );
  }
  assert.deepEqual(baseline.prizeFigures, ['5', '€300']);
  assert.deepEqual(revised.prizeFigures, ['4', '€350']);
  assert.equal(baseline.gifts, 5);
  assert.equal(revised.gifts, 4);

  // No figure is literal in the copy layer.
  const copy = await readFile(join(projectRoot, 'src/copy/landing.ts'), 'utf8');
  assert.doesNotMatch(copy, /€\d|\d%|\b(?:3|5) (?:prizes|confirmed)\b/u);
});

test('no figure is ever shown at a value other than its real one: every frame of the reveal, at its start, middle and end, shows the source values', async () => {
  for (const name of ['A', 'F']) {
    for (const width of [1440, 390]) {
      const label = `variant ${name}, ${width}`;
      const { context, page } = await openVariant(name, {
        width,
        motion: true,
      });
      let midway = false;
      // Start: the cards just entering; middle: the referral sequence and
      // the prize block mid-way; end: everything at rest by 70%.
      const frames = [
        ['start', '.landing-rewards', 0.99],
        ['start', '.landing-rewards', 0.9],
        ['middle', '.landing-tier', 0.85],
        ['middle', '.landing-tier', 0.82],
        ['middle', '.landing-prize', 0.92],
        ['end', '.landing-tier:last-of-type', 0.7],
        ['end', '.landing-prize', 0.7],
      ];
      for (const [moment, selector, at] of frames) {
        await scrollToTop(page, selector, at);
        const motion = await readMotion(page);
        assertFigures(
          motion.figures,
          sources[name],
          `${label} ${moment} (${selector} at ${at})`,
        );
        if (
          moment === 'middle' &&
          motion.running.some((progress) => progress > 0 && progress < 1)
        )
          midway = true;
      }
      assert.ok(midway, `${label} the middle frames are mid-reveal`);
      await context.close();
    }
  }
});

test('variants A to F render as Switches.dc.html at 1440 and 390, in both themes, with no grid holes, at rest and after the reveals', async () => {
  for (const [name, variant] of Object.entries(variants)) {
    for (const colorScheme of themes) {
      for (const width of [1440, 768, 390]) {
        const label = `variant ${name}, ${colorScheme}, ${width}`;
        const { context, page } = await openVariant(name, {
          width,
          colorScheme,
        });
        const m = await measure(page);
        assert.equal(m.overflow, 0, `${label} no horizontal overflow`);
        assert.deepEqual(
          m.geometry.cards.map((card) => card.kind),
          variant.cards,
          `${label} cards`,
        );
        assert.equal(m.tiers.length, variant.tiers, `${label} tier rows`);
        assert.equal(
          m.geometry.verified !== null,
          variant.verified,
          `${label} verified line`,
        );
        assert.equal(
          m.leaderboardHref === '/leaderboard',
          variant.leaderboard,
          `${label} leaderboard link`,
        );
        // With neither line, the footer row is absent, not empty.
        assert.equal(
          m.geometry.footer !== null,
          variant.verified || variant.leaderboard,
          `${label} footer row`,
        );
        if (m.geometry.footer !== null)
          near(m.geometry.footer[1] - m.geometry.grid[3], 24, label);
        const rows = assertNoGridHoles(m, label);
        // As drawn: every box the canvas draws for this variant.
        assertCanvas(m.geometry, canvas.widths[width][name], label);

        if (width === 1440) {
          // One row: three, two or one equal columns.
          assert.equal(rows, 1, `${label} one row`);
          const expected =
            (1200 - 24 * (variant.cards.length - 1)) / variant.cards.length;
          for (const card of m.geometry.cards)
            near(card.box[2], expected, `${label} card width`);
        }
        if (width === 768) {
          // Earlier access spans both columns; the rest share the next row.
          near(m.geometry.cards[0].box[2], 704, `${label} access spans both`);
          assert.equal(rows, variant.cards.length === 1 ? 1 : 2, label);
        }
        if (width === 390) {
          assert.equal(rows, variant.cards.length, `${label} one column`);
          for (const card of m.geometry.cards) near(card.box[2], 358, label);
          if (m.geometry.cards.length > 1)
            near(m.gridGap, 16, `${label} 16px gaps`);
        }

        if (name === 'E' && width === 1440) {
          // One full-width card in a wide two-column composition: 48px
          // padding, an 80px column gap and no divider.
          assert.deepEqual(m.styles.cards[0].padding, [48, 48, 48, 48]);
          assert.equal(m.styles.heads[0].borderBottom, '0px none');
          const [card] = m.geometry.cards;
          near(card.visual[0] - (card.head[0] + card.head[2]), 80, label);
        }
        if (name === 'F') {
          // The second tier row: 16px apart, 16px padding over a 1px dashed
          // line, and the grid row grows.
          const [first, second] = m.tiers;
          near(second.box[1] - (first.box[1] + first.box[3]), 16, label);
          assert.equal(m.styles.tiers[1].borderTop, '1px dashed');
          assert.equal(m.styles.tiers[1].padding[0], 16);
          assert.equal(m.styles.tiers[0].borderTop, '0px none');
        }
        await context.close();

        // After the reveals, with motion on, every box is the at-rest box.
        if (width !== 768) {
          const moving = await openVariant(name, {
            width,
            colorScheme,
            motion: true,
          });
          await scrollToEnd(moving.page);
          const revealed = await measure(moving.page);
          assertCanvas(
            revealed.geometry,
            canvas.widths[width][name],
            `${label} after the reveals`,
          );
          assertNoGridHoles(revealed, `${label} after the reveals`);
          await moving.context.close();
        }
      }
    }
  }
  // F's row is taller than A's: the second tier grows it.
  const heights = {};
  for (const name of ['A', 'F']) {
    const { context, page } = await openVariant(name, { width: 1440 });
    heights[name] = (await measure(page)).geometry.grid[3];
    await context.close();
  }
  assert.ok(heights.F > heights.A, `F ${heights.F} grows past A ${heights.A}`);
});

test('assistive technology reads each tier sentence and the prize sentence, never the drawn equation', async () => {
  for (const name of ['A', 'F']) {
    const { context, page } = await openVariant(name, { width: 390 });
    const m = await measure(page);
    for (const tier of m.tiers) {
      assert.equal(tier.equationHidden, 'true');
      // On screen the sentence is clipped away inside its own row.
      assert.equal(tier.hidden.clipPath, 'inset(50%)');
      assert.ok(tier.hiddenBox[2] <= tier.box[2] + tolerance);
    }
    assert.equal(m.axisHidden, 'true');
    assert.equal(m.giftsHidden, 'true');
    const referral = await page.locator('[data-referral-card]').ariaSnapshot();
    for (const tier of m.tiers) assert.ok(referral.includes(tier.sentence));
    // The drawn pill and labels are never read on their own: their words
    // reach the tree only inside each tier's sentence.
    assert.ok(!referral.includes(landingCopy.rewards.tierWave));
    for (const drawn of [
      landingCopy.rewards.tierDiscountLabel,
      landingCopy.rewards.tierReferrals,
    ]) {
      assert.equal(
        referral.split(drawn).length - 1,
        m.tiers.length,
        `"${drawn}" is read only inside each tier sentence`,
      );
    }
    assert.ok(referral.includes(landingCopy.rewards.held));
    const giveaway = await page.locator('[data-giveaway-card]').ariaSnapshot();
    assert.ok(giveaway.includes(m.prizeSentence));
    assert.equal(
      giveaway.split(landingCopy.rewards.prizeCountLabel).length - 1,
      1,
    );
    assert.ok(giveaway.includes(landingCopy.rewards.rulesLink));
    const access = await page.locator('[data-access-card]').ariaSnapshot();
    // The axis labels are decorative ("earlier" also opens the body line).
    assert.doesNotMatch(
      access,
      new RegExp(`\\b${landingCopy.rewards.waveAxis.later}\\b`, 'u'),
    );
    for (let wave = 1; wave <= 4; wave += 1)
      assert.ok(access.includes(landingCopy.rewards.waveLabel(wave)));
    await context.close();
  }
});

test('the giveaway card states the published rules: the figures, one gift per prize, no purchase necessary, 18+ and the rules link', async () => {
  const rules = await readFile(join(projectRoot, rulesPath), 'utf8');
  const { context, page } = await openVariant('A', { width: 1440 });
  const m = await measure(page);
  await context.close();
  assert.deepEqual(m.prizeFigures, [
    String(frontmatterNumber(rules, 'prizeCount')),
    `€${frontmatterNumber(rules, 'prizeApproxRetailValueEur')}`,
  ]);
  assert.equal(m.gifts, frontmatterNumber(rules, 'prizeCount'));
  assert.match(rules, /No purchase or payment is necessary/u);
  assert.match(rules, /18 or older/u);
  assert.equal(
    m.noteText,
    `${landingCopy.rewards.freeEntry} · ${landingCopy.rewards.age}`,
  );
  assert.equal(m.rulesHref, '/giveaway/rules');
});

test('the cards reveal in reading order, the waves grow from their start points, the equation runs icons → arrow → pills, the prize line and then the footer reveal, at rest by 70%', async () => {
  for (const width of [1440, 768, 390]) {
    const label = `${width}`;
    const { context, page } = await openVariant('A', { width, motion: true });
    let motion = await readMotion(page);

    // The cards: data-reveal, indexed in reading order.
    assert.deepEqual(
      motion.cards.map((card) => [card.index, card.name, card.timeline]),
      [
        ['0', 'motion-reveal', 'view(0px)'],
        ['1', 'motion-reveal', 'view(0px)'],
        ['2', 'motion-reveal', 'view(0px)'],
      ],
      `${label} cards`,
    );
    if (width === 1440) {
      await scrollToTop(page, '.landing-rewards', 0.97);
      motion = await readMotion(page);
      const [first, second, third] = motion.cards;
      assert.ok(first.opacity < 1, `${label} the row is revealing`);
      assert.ok(
        first.opacity >= second.opacity && second.opacity >= third.opacity,
        `${label} the cards reveal in reading order`,
      );
      assert.ok(third.opacity < first.opacity, `${label} left to right`);
    }

    // The waves: each fill grows from its start point to the right end on
    // the access card's view timeline, wave n indexed n.
    assert.equal(motion.cards[0].viewTimeline, '--landing-access');
    assert.deepEqual(
      motion.fills.map((fill) => [
        fill.index,
        fill.name,
        fill.timeline,
        fill.origin.split(' ')[0],
      ]),
      [1, 2, 3, 4].map((index) => [
        String(index),
        'landing-wave-grow',
        '--landing-access',
        '0px',
      ]),
      `${label} wave fills`,
    );
    let growing = false;
    for (let at = 1; at >= 0.7; at -= 4 / 900) {
      await scrollToTop(page, '[data-access-card]', at);
      motion = await readMotion(page);
      const scales = motion.fills.map((fill) => fill.scaleX);
      for (const [index, fill] of motion.fills.entries()) {
        near(
          fill.left,
          fill.start,
          `${label} wave ${index + 1} starts at its point`,
        );
        if (index > 0)
          assert.ok(
            scales[index] <= scales[index - 1] + 1e-6,
            `${label} wave ${index + 1} is no further on than wave ${index}: ${scales}`,
          );
      }
      if (scales[0] > 0 && scales[0] < 1 && scales[3] < scales[0])
        growing = true;
    }
    assert.ok(growing, `${label} the waves grow in order`);
    await scrollToTop(page, '[data-access-card]', 0.7);
    motion = await readMotion(page);
    assert.ok(motion.cards[0].opacity === 1, `${label} access card at rest`);
    for (const fill of motion.fills)
      assert.equal(fill.scaleX, 1, `${label} wave fill at rest at 70%`);

    // The equation, on the tier's own view timeline: N person icons one
    // after another, then the arrow draws, then the two pills rise in.
    const [tier] = motion.tiers;
    assert.equal(tier.viewTimeline, '--landing-tier');
    assert.equal(tier.steps, String(tier.persons.length + 2));
    assert.deepEqual(
      tier.persons.map((person) => [
        person.index,
        person.name,
        person.timeline,
      ]),
      tier.persons.map((_, index) => [
        String(index),
        'landing-person-appear',
        '--landing-tier',
      ]),
    );
    assert.deepEqual(
      [tier.draw.index, tier.draw.name, tier.draw.timeline, tier.draw.masked],
      [
        String(tier.persons.length),
        'landing-arrow-draw',
        '--landing-tier',
        true,
      ],
    );
    assert.deepEqual(
      [tier.reward.index, tier.reward.name, tier.reward.timeline],
      [
        String(tier.persons.length + 1),
        'landing-reward-rise',
        '--landing-tier',
      ],
    );
    // The "+" and the figures never move.
    assert.equal(tier.plus.name, 'none');
    const seen = { persons: false, arrow: false, pills: false };
    for (let at = 1; at >= 0.7; at -= 2 / 900) {
      await scrollToTop(page, '.landing-tier', at);
      motion = await readMotion(page);
      const [current] = motion.tiers;
      const opacities = current.persons.map((person) => person.opacity);
      for (let index = 1; index < opacities.length; index += 1)
        assert.ok(
          opacities[index] <= opacities[index - 1] + 1e-6,
          `${label} person ${index + 1} appears after person ${index}: ${opacities}`,
        );
      if (current.draw.offset < 1)
        assert.ok(
          opacities.every((opacity) => opacity === 1),
          `${label} the arrow draws after every person: ${opacities}`,
        );
      if (current.reward.opacity > 0)
        assert.equal(
          current.draw.offset,
          0,
          `${label} the pills rise after the arrow`,
        );
      if (opacities[0] > 0 && opacities.at(-1) === 0) seen.persons = true;
      if (current.draw.offset > 0 && current.draw.offset < 1) seen.arrow = true;
      if (
        current.reward.opacity > 0 &&
        current.reward.opacity < 1 &&
        current.reward.translate !== 'none'
      )
        seen.pills = true;
      assertFigures(motion.figures, sources.A, `${label} at ${at}`);
    }
    assert.deepEqual(
      seen,
      { persons: true, arrow: true, pills: true },
      `${label} each step is seen mid-way`,
    );
    // Nothing has started before the sequence, and all of it is at rest by
    // the time the tier's top is at 70% of the viewport height.
    await scrollToTop(page, '.landing-tier', 0.99);
    motion = await readMotion(page);
    assert.deepEqual(
      [
        motion.tiers[0].persons.map((person) => person.opacity),
        motion.tiers[0].draw.offset,
        motion.tiers[0].reward.opacity,
      ],
      [motion.tiers[0].persons.map(() => 0), 1, 0],
      `${label} nothing before the sequence`,
    );
    // The arrow is painted only through its mask: on screen, still empty
    // just before its step, with the tier in view.
    await scrollToTop(page, '.landing-tier', 0.92);
    assert.equal((await readMotion(page)).tiers[0].draw.offset, 1);
    assert.deepEqual(
      await arrowPainted(page),
      [0, 0],
      `${label} the arrow is not yet drawn on screen`,
    );
    await scrollToTop(page, '.landing-tier', 0.7);
    motion = await readMotion(page);
    for (const share of await arrowPainted(page))
      assert.ok(
        share > 0.05,
        `${label} the arrow is drawn on screen: ${share}`,
      );
    for (const person of motion.tiers[0].persons)
      assert.ok(atRest(person), `${label} person at rest at 70%`);
    assert.equal(motion.tiers[0].draw.offset, 0, `${label} arrow drawn`);
    assert.ok(atRest(motion.tiers[0].reward), `${label} pills at rest`);
    // Each card, read with its own top at 70% of the viewport height.
    for (const [index, card] of [
      '[data-access-card]',
      '[data-referral-card]',
      '[data-giveaway-card]',
    ].entries()) {
      await scrollToTop(page, card, 0.7);
      motion = await readMotion(page);
      assert.ok(atRest(motion.cards[index]), `${label} ${card} at rest at 70%`);
    }

    // The prize line reveals as one unit: its block reveals; its figures
    // have no motion of their own.
    assert.equal(motion.prize.name, 'motion-reveal');
    await scrollToTop(page, '.landing-prize', 0.97);
    motion = await readMotion(page);
    assert.ok(motion.prize.opacity < 1, `${label} the prize line reveals`);
    assertFigures(motion.figures, sources.A, `${label} prize mid-reveal`);
    await scrollToTop(page, '.landing-prize', 0.7);
    motion = await readMotion(page);
    assert.ok(atRest(motion.prize), `${label} prize line at rest at 70%`);

    // The footer row reveals after the cards: once it has started, every
    // card is at rest.
    assert.equal(motion.footer.name, 'motion-reveal');
    let started = false;
    for (let at = 1.02; at >= 0.9 && !started; at -= 2 / 900) {
      await scrollToTop(page, '.landing-rewards__footer', at);
      motion = await readMotion(page);
      if (motion.footer.opacity > 0 && motion.footer.opacity < 1) {
        started = true;
        for (const card of motion.cards)
          assert.ok(atRest(card), `${label} the cards rest before the footer`);
      }
    }
    assert.ok(started, `${label} the footer row reveals`);
    await scrollToTop(page, '.landing-rewards__footer', 0.7);
    motion = await readMotion(page);
    assert.ok(atRest(motion.footer), `${label} footer at rest at 70%`);
    await context.close();
  }
});

test('under reduced motion nothing in #rewards moves: every wave is full, every icon shown, the arrow drawn and the pills in place', async () => {
  for (const name of ['A', 'F']) {
    for (const width of [1440, 390]) {
      const label = `variant ${name}, ${width}`;
      const { context, page } = await openVariant(name, { width });
      for (const [selector, at] of [
        ['.landing-rewards', 0.99],
        ['.landing-tier', 0.85],
        ['.landing-prize', 0.95],
        ['.landing-rewards__footer', 0.98],
      ]) {
        await scrollToTop(page, selector, at);
        const motion = await readMotion(page);
        assert.deepEqual(motion.running, [], `${label} nothing animates`);
        assert.equal(motion.cards[0].viewTimeline, 'none');
        for (const element of [
          ...motion.cards,
          ...motion.fills,
          motion.prize,
          motion.footer,
        ])
          assert.ok(atRest(element), `${label} at rest`);
        for (const tier of motion.tiers) {
          for (const person of tier.persons)
            assert.ok(atRest(person), `${label} person shown`);
          assert.equal(tier.draw.offset, 0, `${label} arrow drawn`);
          assert.ok(atRest(tier.reward), `${label} pills in place`);
        }
        if (selector === '.landing-tier')
          for (const share of await arrowPainted(page))
            assert.ok(share > 0.05, `${label} the arrow shows: ${share}`);
        assertFigures(motion.figures, sources[name], label);
      }
      await context.close();
    }
  }
});

test('with animations unsupported, #rewards is at rest: every wave full, every icon shown, the arrow drawn', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openVariant('A', { width, motion: true });
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; }',
    });
    for (const [selector, at] of [
      ['.landing-rewards', 0.99],
      ['.landing-tier', 0.85],
      ['.landing-prize', 0.95],
    ]) {
      await scrollToTop(page, selector, at);
      const motion = await readMotion(page);
      for (const element of [
        ...motion.cards,
        ...motion.fills,
        motion.prize,
        motion.footer,
      ])
        assert.ok(atRest(element), `${width} at rest`);
      for (const tier of motion.tiers) {
        for (const person of tier.persons)
          assert.ok(atRest(person), `${width} person shown`);
        assert.equal(tier.draw.offset, 0, `${width} arrow drawn`);
        assert.ok(atRest(tier.reward), `${width} pills in place`);
      }
      if (selector === '.landing-tier')
        for (const share of await arrowPainted(page))
          assert.ok(share > 0.05, `${width} the arrow shows: ${share}`);
    }
    await context.close();
  }
});

// The landing page's enforced layout check renders its default flags only
// (giveaway off). Every reward variant passes the same checks within
// #rewards, at every design width in both themes.
test('every variant passes the layout checks within #rewards at every design width, in both themes', async () => {
  for (const name of Object.keys(variants)) {
    for (const colorScheme of themes) {
      for (const width of designWidths) {
        const { context, page } = await openVariant(name, {
          width,
          colorScheme,
        });
        assert.deepEqual(
          await checkRegionLayout(page, ['#rewards']),
          [],
          `variant ${name} layout, ${colorScheme}, ${width}px`,
        );
        await context.close();
      }
    }
  }
});

async function rewardsAxe(page) {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async () => {
    const result = await globalThis.axe.run(
      globalThis.document.querySelector('#rewards'),
      {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
        },
      },
    );
    return result.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    }));
  });
}

test('the reward section passes WCAG axe in both themes for every variant: on load, at rest and after the reveals', async () => {
  // On load with motion allowed (as E11.5-11e read it), at rest (reduced
  // motion), and with motion allowed once every reveal is over.
  const modes = [
    ['on load', { motion: true }, false],
    ['at rest', { motion: false }, false],
    ['after the reveals', { motion: true }, true],
  ];
  for (const name of Object.keys(variants)) {
    for (const colorScheme of themes) {
      for (const width of [1440, 390]) {
        for (const [mode, options, revealed] of modes) {
          const { context, page } = await openVariant(name, {
            width,
            colorScheme,
            ...options,
          });
          if (revealed) await scrollToEnd(page);
          assert.deepEqual(
            await rewardsAxe(page),
            [],
            `rewards axe, variant ${name}, ${colorScheme}, ${width}px, ${mode}`,
          );
          await context.close();
        }
      }
    }
  }
});
