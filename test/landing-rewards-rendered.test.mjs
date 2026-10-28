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

import { landingCopy } from '../src/copy/landing.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { renderLanding } from './helpers/landing-render.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import {
  checkRegionLayout,
  designWidths,
} from '../scripts/design/layout-checks.mjs';

// E11.5-11e: the #rewards section from Main.dc.html, Tablet.dc.html,
// Phone.dc.html and Switches.dc.html. Every number below is the frame's,
// measured from the frame's own CSS and markup on the self-hosted fonts, with
// a 1px tolerance.

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const browserContainer = `valstara-landing-rewards-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const themes = ['light', 'dark'];
const tolerance = 1;
const rulesPath = 'src/content/giveaway-rules/VAL-GW-LAUNCH-20261009-r1.md';
const configPath = 'src/server/referral/config.ts';

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
  F: {
    flags: [giveawayOn],
    cards: ['access', 'referral', 'giveaway'],
    tiers: 2,
    verified: true,
    leaderboard: true,
  },
};

// The frame boxes, relative to the reward grid's top-left: [x, y, w, h].
// Two differ from the frames below 64rem, where a 44px link hit area would
// otherwise stick out of its parent and fail the layout check's overflow
// rule: the giveaway visual block is 12px taller (it holds the rules link's
// lower padding, with a matching negative margin, so the card is unchanged),
// and the leaderboard link's box starts 24px above its line instead of 12px.
// Every visible position is the frame's.
const frames = {
  1440: {
    grid: [0, 0, 1200, 341],
    card: [
      [0, 0, 384, 341],
      [408, 0, 384, 341],
      [816, 0, 384, 341],
    ],
    tile: [
      [24, 24, 40, 40],
      [432, 24, 40, 40],
      [840, 24, 40, 40],
    ],
    h3: [
      [24, 76, null, 28],
      [432, 76, null, 28],
      [840, 76, null, 28],
    ],
    visual: [
      [24, 160, 336, 157],
      [432, 124, 336, 173],
      [840, 124, 336, 133],
    ],
    waveLabel: [24, 181, 56, 18],
    waveTrack: [92, 186, 268, 8],
    waveFill: [
      [92, 186, 268, 8],
      [159, 214, 201, 8],
      [226, 242, 134, 8],
      [293, 270, 67, 8],
    ],
    axis: [92, 299, 268, 18],
    equation: [432, 145, 336, 96],
    referrals: [432, 145, 114, 96],
    figure: [432, 145, 114, 40],
    people: [432, 187, 114, 16],
    arrow: [562, 181, 24, 24],
    reward: [602, 152, 166, 82],
    held: [432, 257, 336, 40],
    prize: [840, 145, 336, 40],
    note: [840, 201, 336, 20],
    rulesLink: [840, 237, null, 20],
    footer: [0, 365, 1200, 20],
    verified: [0, 365, null, 20],
    leaderboardLink: [318, 365, null, 20],
  },
  768: {
    grid: [0, 0, 704, 553],
    card: [
      [0, 0, 704, 188],
      [0, 212, 340, 341],
      [364, 212, 340, 341],
    ],
    tile: [
      [24, 24, 40, 40],
      [24, 236, 40, 40],
      [388, 236, 40, 40],
    ],
    h3: [
      [24, 76, null, 28],
      [24, 288, null, 28],
      [388, 288, null, 28],
    ],
    // The access card's right column, then the two visual blocks.
    visual: [
      [368, 24, 312, 132],
      [24, 336, 292, 193],
      [388, 336, 292, 169],
    ],
    waveLabel: [368, 24, 56, 18],
    waveTrack: [436, 29, 244, 8],
    waveFill: [
      [436, 29, 244, 8],
      [497, 57, 183, 8],
      [558, 85, 122, 8],
      [619, 113, 61, 8],
    ],
    axis: [436, 138, 244, 18],
    equation: [24, 357, 292, 96],
    referrals: [24, 357, 70, 96],
    figure: [24, 357, 70, 40],
    people: [24, 399, 70, 16],
    arrow: [110, 393, 24, 24],
    reward: [150, 364, 166, 82],
    held: [24, 469, 292, 60],
    prize: [388, 357, 292, 64],
    note: [388, 437, 292, 20],
    rulesLink: [388, 461, null, 44],
    footer: [0, 577, 704, 20],
    verified: [0, 577, null, 20],
    leaderboardLink: [318, 553, null, 44],
  },
  390: {
    grid: [0, 0, 358, 1043],
    card: [
      [0, 0, 358, 365],
      [0, 381, 358, 341],
      [0, 738, 358, 305],
    ],
    tile: [
      [24, 24, 40, 40],
      [24, 405, 40, 40],
      [24, 762, 40, 40],
    ],
    h3: [
      [24, 76, null, 28],
      [24, 457, null, 28],
      [24, 814, null, 28],
    ],
    visual: [
      [24, 184, 310, 157],
      [24, 505, 310, 193],
      [24, 862, 310, 169],
    ],
    waveLabel: [24, 205, 56, 18],
    waveTrack: [92, 210, 242, 8],
    waveFill: [
      [92, 210, 242, 8],
      [153, 238, 182, 8],
      [213, 266, 121, 8],
      [274, 294, 61, 8],
    ],
    axis: [92, 323, 242, 18],
    equation: [24, 526, 310, 96],
    referrals: [24, 526, 88, 96],
    figure: [24, 526, 88, 40],
    people: [24, 568, 88, 16],
    arrow: [128, 562, 24, 24],
    reward: [168, 533, 166, 82],
    held: [24, 638, 310, 60],
    prize: [24, 883, 310, 64],
    note: [24, 963, 310, 20],
    rulesLink: [24, 987, null, 44],
    footer: [0, 1067, 358, 52],
    verified: [0, 1067, null, 20],
    leaderboardLink: [0, 1075, null, 44],
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
// from the running app server.
async function openVariant(
  name,
  { width, height = 900, colorScheme = 'light' },
) {
  const { html, assets } = pages[name];
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme,
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
  return { context, page };
}

// Every box, style and figure the assertions read, relative to the grid.
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
    const all = (selector, root = document) =>
      [...root.querySelectorAll(selector)].map(box);
    const one = (selector) => box(document.querySelector(selector));
    const style = (element) => {
      const css = getComputedStyle(element);
      return {
        font: `${css.fontSize}/${css.lineHeight} ${css.fontWeight}`,
        family: css.fontFamily,
        color: css.color,
        background: css.backgroundColor,
        radius: css.borderTopLeftRadius,
        borderTop: `${css.borderTopWidth} ${css.borderTopStyle}`,
        borderTopColor: css.borderTopColor,
        padding: [
          css.paddingTop,
          css.paddingRight,
          css.paddingBottom,
          css.paddingLeft,
        ].map(Number.parseFloat),
        marginTop: Number.parseFloat(css.marginTop),
        shadow: css.boxShadow,
        clipPath: css.clipPath,
        letterSpacing: css.letterSpacing,
      };
    };
    // A token's computed colour, read through a probe element.
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
    return {
      viewport: globalThis.innerWidth,
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      grid: box(grid),
      gridGap: Number.parseFloat(getComputedStyle(grid).rowGap),
      columnGap: Number.parseFloat(getComputedStyle(grid).columnGap),
      cards: cards.map((card) => ({
        kind: cardKind(card),
        box: box(card),
        style: style(card),
      })),
      tile: all('.landing-rewards .icon-tile'),
      tileStyle: style(document.querySelector('.landing-rewards .icon-tile')),
      h3: all('.landing-rewards h3'),
      h3Style: style(document.querySelector('.landing-rewards h3')),
      body: style(document.querySelector('.landing-reward__body')),
      visual: all('.landing-reward__visual'),
      visualStyle: [
        ...document.querySelectorAll('.landing-reward__visual'),
      ].map(style),
      waveLabel: all('.landing-wave__label'),
      waveLabelStyle: style(document.querySelector('.landing-wave__label')),
      waveTrack: all('.landing-wave__track'),
      waveTrackStyle: style(document.querySelector('.landing-wave__track')),
      waveFill: all('.landing-wave__fill'),
      waveFillStyle: style(document.querySelector('.landing-wave__fill')),
      axis: one('.landing-wave-axis'),
      axisStyle: style(document.querySelector('.landing-wave-axis')),
      axisHidden: document
        .querySelector('.landing-wave-axis')
        .getAttribute('aria-hidden'),
      tiers: tiers.map((tier) => ({
        box: box(tier),
        style: style(tier),
        figure: tier.querySelector('.landing-figure')?.textContent.trim(),
        people: tier.querySelectorAll('.landing-tier__people svg').length,
        discount: tier
          .querySelector('.pill--coral .tabular-figure')
          ?.textContent.trim(),
        sentence: tier.querySelector('.landing-hidden')?.textContent.trim(),
        hidden: style(tier.querySelector('.landing-hidden')),
        hiddenBox: box(tier.querySelector('.landing-hidden')),
        equationHidden: tier
          .querySelector('.landing-tier__equation')
          .getAttribute('aria-hidden'),
      })),
      equation: all('.landing-tier__equation'),
      referrals: all('.landing-tier__referrals'),
      figure: all('.landing-tier .landing-figure'),
      figureStyle: tiers[0]
        ? style(tiers[0].querySelector('.landing-figure'))
        : null,
      people: all('.landing-tier__people'),
      personStyle: tiers[0]
        ? style(tiers[0].querySelector('.landing-tier__people'))
        : null,
      arrow: all('.landing-tier__arrow'),
      reward: all('.landing-tier__reward'),
      pills: [...document.querySelectorAll('.landing-tier .pill')].map(
        (pill) => ({ box: box(pill), style: style(pill) }),
      ),
      held: one('.landing-held'),
      heldStyle: style(
        document.querySelector('.landing-held') ?? document.body,
      ),
      prize: one('.landing-prize__line'),
      prizeFigures: [
        ...document.querySelectorAll('.landing-prize__line .landing-figure'),
      ].map((figure) => figure.textContent.trim()),
      prizeWordsStyle: document.querySelector('.landing-prize__words')
        ? style(document.querySelector('.landing-prize__words'))
        : null,
      prizeSentence: document
        .querySelector('.landing-prize .landing-hidden')
        ?.textContent.trim(),
      note: one('.landing-reward__note'),
      noteText: document
        .querySelector('.landing-reward__note')
        ?.textContent.replace(/\s+/gu, ' ')
        .trim(),
      rulesLink: one('[data-giveaway-card] a'),
      rulesHref: document
        .querySelector('[data-giveaway-card] a')
        ?.getAttribute('href'),
      footer: box(footer),
      verified: one('.landing-rewards__verified'),
      verifiedStyle: document.querySelector('.landing-rewards__verified')
        ? style(document.querySelector('.landing-rewards__verified'))
        : null,
      leaderboardLink: one('.landing-rewards__footer a'),
      leaderboardHref: document
        .querySelector('.landing-rewards__footer a')
        ?.getAttribute('href'),
      tokens: {
        ink: token('--ink'),
        ink600: token('--ink-600'),
        line: token('--line', 'background-color'),
        coral: token('--coral', 'background-color'),
        coralTint: token('--coral-tint', 'background-color'),
        onCoral: token('--on-coral'),
        paper: token('--paper', 'background-color'),
        surface: token('--surface', 'background-color'),
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

function nearBox(actual, expected, label) {
  assert.ok(actual, `${label} renders`);
  ['x', 'y', 'w', 'h'].forEach((axis, index) => {
    if (expected[index] !== null)
      near(actual[index], expected[index], `${label} ${axis}`);
  });
}

function nearBoxes(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} count`);
  expected.forEach((box, index) =>
    nearBox(actual[index], box, `${label} ${index + 1}`),
  );
}

// No grid hole: the cards fill every row of the grid edge to edge, each row
// shares one top and one height, and the rows stack with the grid's gap.
function assertNoGridHoles(m, label) {
  const rows = [];
  for (const { box } of m.cards) {
    const row = rows.find((candidate) => Math.abs(candidate.top - box[1]) <= 1);
    if (row) row.boxes.push(box);
    else rows.push({ top: box[1], boxes: [box] });
  }
  let expectedTop = 0;
  for (const [index, row] of rows.entries()) {
    const widths = row.boxes.reduce((sum, box) => sum + box[2], 0);
    near(
      widths + m.columnGap * (row.boxes.length - 1),
      m.grid[2],
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
    m.grid[3],
    `${label} the rows fill the grid height`,
  );
  return rows.length;
}

test('card anatomy and geometry match Main, Tablet and Phone at 1440, 768 and 390, in both themes', async () => {
  for (const colorScheme of themes) {
    for (const width of [1440, 768, 390]) {
      const label = `${colorScheme} ${width}`;
      const frame = frames[width];
      const { context, page } = await openVariant('A', { width, colorScheme });
      const m = await measure(page);
      assert.equal(m.overflow, 0, `${label} no horizontal overflow`);
      nearBox(m.grid, frame.grid, `${label} grid`);
      nearBoxes(
        m.cards.map((card) => card.box),
        frame.card,
        `${label} card`,
      );
      nearBoxes(m.tile, frame.tile, `${label} icon tile`);
      nearBoxes(m.h3, frame.h3, `${label} H3`);
      nearBoxes(m.visual, frame.visual, `${label} visual block`);
      for (let wave = 0; wave < 4; wave += 1) {
        nearBox(
          m.waveLabel[wave],
          [
            frame.waveLabel[0],
            frame.waveLabel[1] + 28 * wave,
            ...frame.waveLabel.slice(2),
          ],
          `${label} wave ${wave + 1} label`,
        );
        nearBox(
          m.waveTrack[wave],
          [
            frame.waveTrack[0],
            frame.waveTrack[1] + 28 * wave,
            ...frame.waveTrack.slice(2),
          ],
          `${label} wave ${wave + 1} track`,
        );
      }
      nearBoxes(m.waveFill, frame.waveFill, `${label} wave fill`);
      nearBox(m.axis, frame.axis, `${label} wave axis`);
      for (const key of [
        'equation',
        'referrals',
        'figure',
        'people',
        'arrow',
        'reward',
      ])
        nearBoxes(m[key], [frame[key]], `${label} ${key}`);
      near(m.pills[0].box[3], 26, `${label} reward pill height`);
      near(m.pills[1].box[3], 26, `${label} coral pill height`);
      for (const key of [
        'held',
        'prize',
        'note',
        'rulesLink',
        'footer',
        'verified',
        'leaderboardLink',
      ])
        nearBox(m[key], frame[key], `${label} ${key}`);

      // Type, colour and surface, from the frames and the tokens.
      for (const card of m.cards) {
        assert.equal(card.style.radius, '12px', `${label} card radius`);
        assert.equal(card.style.background, m.tokens.surface);
        assert.equal(card.style.shadow, m.tokens.shadowCard, `${label} E1`);
      }
      assert.equal(m.tileStyle.background, m.tokens.paper);
      assert.equal(m.tileStyle.radius, '8px');
      assert.equal(m.h3Style.font, '20px/28px 600', `${label} H3 type`);
      assert.equal(m.h3Style.letterSpacing, '-0.2px');
      assert.equal(m.body.font, '16px/24px 400');
      assert.equal(m.body.color, m.tokens.ink600);
      // The divider: 1px line above the visual block, 20px over it, except
      // in the medium access card's inner composition.
      const divided = width === 768 ? m.visualStyle.slice(1) : m.visualStyle;
      for (const visual of divided) {
        assert.equal(visual.borderTop, '1px solid', `${label} divider`);
        assert.equal(visual.borderTopColor, m.tokens.line);
        assert.equal(visual.padding[0], 20);
      }
      if (width === 768) assert.equal(m.visualStyle[0].borderTop, '0px none');
      assert.equal(m.waveLabelStyle.font, '13px/18px 400');
      assert.match(m.waveLabelStyle.family, /^"JetBrains Mono"/u);
      assert.equal(m.waveTrackStyle.background, m.tokens.line);
      assert.equal(m.waveTrackStyle.radius, '999px');
      assert.equal(m.waveFillStyle.background, m.tokens.ink);
      assert.equal(m.axisStyle.font, '13px/18px 400');
      assert.equal(m.axisStyle.color, m.tokens.ink600);
      assert.equal(m.figureStyle.font, '32px/40px 600');
      assert.match(m.figureStyle.family, /^"JetBrains Mono"/u);
      assert.equal(m.personStyle.color, m.tokens.ink600);
      assert.equal(m.pills[0].style.background, m.tokens.coralTint);
      assert.equal(m.pills[0].style.color, m.tokens.ink);
      assert.equal(m.pills[0].style.font, '13px/18px 600');
      assert.equal(m.pills[1].style.background, m.tokens.coral);
      assert.equal(m.pills[1].style.color, m.tokens.onCoral);
      assert.equal(m.heldStyle.font, '14px/20px 400');
      assert.equal(m.heldStyle.color, m.tokens.ink600);
      assert.equal(m.prizeWordsStyle.font, '16px/24px 500');
      assert.equal(m.verifiedStyle.font, '14px/20px 500');
      await context.close();
    }
  }
});

test('every figure comes from the ladder and the published rules: a changed fixture changes N, X, the person icons, the prize count and the value', async () => {
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

  // The prize figures are the rules' own frontmatter, before and after.
  for (const [measured, source] of [
    [baseline, rules],
    [revised, changedRules],
  ]) {
    const count = frontmatterNumber(source, 'prizeCount');
    const value = frontmatterNumber(source, 'prizeApproxRetailValueEur');
    assert.deepEqual(measured.prizeFigures, [String(count), `€${value}`]);
    assert.equal(
      measured.prizeSentence,
      `${count} prizes, approximately €${value} each`,
    );
  }
  assert.deepEqual(baseline.prizeFigures, ['5', '€300']);
  assert.deepEqual(revised.prizeFigures, ['4', '€350']);

  // No figure is literal in the copy layer.
  const copy = await readFile(join(projectRoot, 'src/copy/landing.ts'), 'utf8');
  assert.doesNotMatch(copy, /€\d|\d%|\b(?:3|5) (?:prizes|confirmed)\b/u);
});

test('variants A to F render as Switches.dc.html at 1440 and 390, in both themes, with no grid holes', async () => {
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
          m.cards.map((card) => card.kind),
          variant.cards,
          `${label} cards`,
        );
        assert.equal(m.tiers.length, variant.tiers, `${label} tier rows`);
        assert.equal(
          m.verified !== null,
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
          m.footer !== null,
          variant.verified || variant.leaderboard,
          `${label} footer row`,
        );
        if (m.footer !== null) near(m.footer[1] - m.grid[3], 24, label);
        const rows = assertNoGridHoles(m, label);

        if (width === 1440) {
          // One row: three, two or one equal columns.
          assert.equal(rows, 1, `${label} one row`);
          const expected =
            (1200 - 24 * (variant.cards.length - 1)) / variant.cards.length;
          for (const card of m.cards)
            near(card.box[2], expected, `${label} card width`);
        }
        if (width === 768) {
          // Earlier access spans both columns; the rest share the next row.
          near(m.cards[0].box[2], 704, `${label} access spans both`);
          assert.equal(rows, variant.cards.length === 1 ? 1 : 2, label);
        }
        if (width === 390) {
          assert.equal(rows, variant.cards.length, `${label} one column`);
          for (const card of m.cards) near(card.box[2], 358, label);
          if (m.cards.length > 1) near(m.gridGap, 16, `${label} 16px gaps`);
        }

        if (name === 'E' && width === 1440) {
          // One full-width card in a two-column composition: 40px padding,
          // a 64px column gap and the visual block without its divider.
          const [card] = m.cards;
          assert.deepEqual(card.style.padding, [40, 40, 40, 40]);
          nearBox(m.tile[0], [40, null, 40, 40], `${label} intro column`);
          nearBox(m.visual[0], [632, null, 528, null], `${label} visual`);
          assert.equal(m.visualStyle[0].borderTop, '0px none');
          assert.equal(m.visualStyle[0].padding[0], 0);
          // The two columns are centred on each other.
          const intro = [m.tile[0][1], m.h3[0][1] + 28 + 12 + 24];
          near(
            (intro[0] + intro[1]) / 2,
            m.visual[0][1] + m.visual[0][3] / 2,
            `${label} columns centred`,
          );
        }
        if (name === 'F') {
          // The second tier row: 4px more space, 16px padding over a 1px
          // line, and the grid row grows.
          const [first, second] = m.tiers;
          near(second.box[1] - (first.box[1] + first.box[3]), 20, label);
          assert.equal(second.style.borderTop, '1px solid');
          assert.equal(second.style.padding[0], 16);
          assert.equal(first.style.borderTop, '0px none');
        }
        await context.close();
      }
    }
  }
  // F's row is taller than A's: the second tier grows it.
  const heights = {};
  for (const name of ['A', 'F']) {
    const { context, page } = await openVariant(name, { width: 1440 });
    heights[name] = (await measure(page)).grid[3];
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

test('the giveaway card states the published rules: the figures, no purchase necessary, 18+ and the rules link', async () => {
  const rules = await readFile(join(projectRoot, rulesPath), 'utf8');
  const { context, page } = await openVariant('A', { width: 1440 });
  const m = await measure(page);
  await context.close();
  assert.deepEqual(m.prizeFigures, [
    String(frontmatterNumber(rules, 'prizeCount')),
    `€${frontmatterNumber(rules, 'prizeApproxRetailValueEur')}`,
  ]);
  assert.match(rules, /No purchase or payment is necessary/u);
  assert.match(rules, /18 or older/u);
  assert.equal(
    m.noteText,
    `${landingCopy.rewards.freeEntry} · ${landingCopy.rewards.age}`,
  );
  assert.equal(m.rulesHref, '/giveaway/rules');
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

test('the reward section passes WCAG axe in both themes for every variant', async () => {
  for (const name of Object.keys(variants)) {
    for (const colorScheme of themes) {
      for (const width of [1440, 390]) {
        const { context, page } = await openVariant(name, {
          width,
          colorScheme,
        });
        await page.addScriptTag({ content: axe.source });
        const violations = await page.evaluate(async () => {
          const result = await globalThis.axe.run(
            globalThis.document.querySelector('#rewards'),
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
          `rewards axe, variant ${name}, ${colorScheme}, ${width}px`,
        );
        await context.close();
      }
    }
  }
});
