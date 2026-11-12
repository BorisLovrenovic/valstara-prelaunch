// E11.5-11s: the trust, legal and giveaway rules pages on the final-design
// canvas (Doc.dc.html, as TrustLegit, TrustGuarantee, TrustAbout,
// LegalPrivacy, LegalTermsStorage, Rules and RulesArchived place it, and the
// document rules in valstara.css), plus the ticket's motion and finish. The
// E11.5-09 behaviour is asserted, unchanged, by
// test/document-pages-rendered.test.mjs. Geometry is read at rest (a
// reduced-motion context, design rule 12) with a 1px tolerance (rule 7), in
// both themes, at each width the canvas draws.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';

import { designThemes } from '../scripts/design/layout-checks.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { scrollSettled } from './helpers/motion.mjs';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const browserImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const browserContainer = 'valstara-document-final-' + process.pid;
const tolerance = 1;

const archivedRoute = '/giveaway/rules/VAL-GW-LAUNCH-20260925-r1';
const trustRoutes = ['/legit', '/guarantee', '/about'];
const legalRoutes = ['/privacy', '/terms', '/privacy/storage'];
const rulesRoutes = ['/giveaway/rules', archivedRoute];
const routes = [...trustRoutes, ...legalRoutes, ...rulesRoutes];
// The widths each page is drawn at: the trust pages at 390, 768 and 1440;
// the legal and rules pages at 390 and 1440.
const drawnWidths = (route) =>
  trustRoutes.includes(route) ? [390, 768, 1440] : [390, 1440];

let app;
let browserServer;
let browser;
let origin;
let hostOrigin;
before(async () => {
  await executeFile('npm', ['run', 'build'], { cwd: root });
  app = await startAppServer({
    label: 'Document pages final design',
    readyPath: '/legit',
    env: () => ({
      ADMIN_CREDENTIAL: 'document-final-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'document-final-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'document-final-referral-secret',
      RESEND_API_KEY: 'document-final-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    }),
  });
  hostOrigin = 'http://127.0.0.1:' + app.port;
  origin = 'http://host.docker.internal:' + app.port;
  for (const route of routes) {
    const response = await globalThis.fetch(hostOrigin + route);
    assert.equal(response.status, 200, route);
    await response.arrayBuffer();
  }

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
      root + ':/work:ro',
      '--workdir',
      '/work',
      browserImage,
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
  browserServer.stdout.on('data', (chunk) => {
    output += chunk;
  });
  browserServer.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (
    let attempt = 0;
    attempt < 240 && !output.includes('Listening on');
    attempt += 1
  ) {
    if (browserServer.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  assert.match(output, /Listening on/u);
  browser = await chromium.connect(
    'ws://127.0.0.1:' + (await publishedPort(browserContainer, 3000)) + '/',
  );
});

after(async () => {
  await browser?.close();
  await executeFile('docker', ['rm', '--force', browserContainer]).catch(
    () => {},
  );
  if (browserServer && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
  await app?.stop();
});

async function openPage(route, { width, colorScheme = 'light', motion }) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme,
    reducedMotion: motion ? 'no-preference' : 'reduce',
  });
  const page = await context.newPage();
  await page.goto(origin + route);
  return { context, page };
}

const near = (actual, expected) => Math.abs(actual - expected) <= tolerance;

// Everything the canvas fixes for one page at one width, read at rest.
function measureDocument(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const probe = document.createElement('div');
    document.body.append(probe);
    const resolve = (property, value) => {
      probe.style[property] = value;
      return getComputedStyle(probe)[property];
    };
    const font = (style) =>
      `${style.fontSize}/${style.lineHeight} ${style.fontWeight}`;
    const box = (element) => {
      if (!element) return null;
      const { top, bottom, left, right, width, height } =
        element.getBoundingClientRect();
      return { top, bottom, left, right, width, height };
    };
    const main = document.querySelector('.document__main');
    const article = main.querySelector('article.document__prose');
    const eyebrow = document.querySelector('[data-document-eyebrow]');
    const title = article.querySelector(':scope > h1');
    const summary = document.querySelector('[data-document-summary]');
    const notice = document.querySelector('[data-archived-rules-notice]');
    const aside = document.querySelector('.document__aside');
    const card = document.querySelector('.document__card');
    const cardHeading = document.querySelector('.document__card-heading');
    const bar = document.querySelector('[data-join-bar]');
    const band = getComputedStyle(main, '::before');
    const rule = getComputedStyle(eyebrow, '::before');
    const mainStyle = getComputedStyle(main);
    const firstH2 = article.querySelector(':scope > h2');
    const firstP = article.querySelector(':scope > p');
    const result = {
      viewport: {
        width: document.documentElement.clientWidth,
        height: globalThis.innerHeight,
      },
      header: box(document.querySelector('body > header')),
      main: box(main),
      eyebrow: box(eyebrow),
      // The band's own padding sits on the eyebrow and the summary, so the
      // text edges are read inside it.
      eyebrowText:
        eyebrow.getBoundingClientRect().top +
        Number.parseFloat(getComputedStyle(eyebrow).paddingTop),
      summaryText:
        summary.getBoundingClientRect().bottom -
        Number.parseFloat(getComputedStyle(summary).paddingBottom),
      title: box(title),
      summary: box(summary),
      body: box(article.children[1]),
      articleEnd: Math.max(
        ...[...article.children].map(
          (child) => child.getBoundingClientRect().bottom,
        ),
      ),
      eyebrowFont: font(getComputedStyle(eyebrow)),
      eyebrowColor: getComputedStyle(eyebrow).color,
      rule: {
        width: rule.width,
        height: rule.height,
        color: rule.backgroundColor,
      },
      titleFont: font(getComputedStyle(title)),
      titleColor: getComputedStyle(title).color,
      summaryFont: font(getComputedStyle(summary)),
      summaryColor: getComputedStyle(summary).color,
      band: {
        color: band.backgroundColor,
        shadow: band.boxShadow,
        clip: band.clipPath,
      },
      paragraphFont: font(getComputedStyle(firstP)),
      h2: firstH2
        ? {
            font: font(getComputedStyle(firstH2)),
            border: getComputedStyle(firstH2).borderTopWidth,
          }
        : null,
      columns: mainStyle.gridTemplateColumns,
      columnGap: mainStyle.columnGap,
      aside: box(aside),
      asidePosition: aside ? getComputedStyle(aside).position : null,
      asideTop: aside ? getComputedStyle(aside).top : null,
      card: box(card),
      cardHeading: box(cardHeading),
      contents: [...document.querySelectorAll('.document__contents a')].map(
        (link) => ({
          ...box(link),
          padding: getComputedStyle(link).paddingLeft,
        }),
      ),
      notice: notice
        ? {
            ...box(notice),
            font: font(getComputedStyle(notice)),
            color: getComputedStyle(notice).backgroundColor,
            padding: `${getComputedStyle(notice).paddingTop} ${getComputedStyle(notice).paddingBottom}`,
            icon: box(notice.querySelector('svg')),
          }
        : null,
      bar: bar
        ? {
            ...box(bar),
            visible: getComputedStyle(bar).display !== 'none',
            padding: `${getComputedStyle(bar).paddingTop} ${getComputedStyle(bar).paddingLeft}`,
            link: box(bar.querySelector('a')),
          }
        : null,
      // IMG-01 is not built (final-design rule 3): no image, slot or box.
      media: document.querySelectorAll(
        '.document img, .document picture, .document [class*="media"]',
      ).length,
      tokens: {
        surface: resolve('backgroundColor', 'var(--surface)'),
        midnight: resolve('backgroundColor', 'var(--midnight)'),
        coral: resolve('backgroundColor', 'var(--coral)'),
        coralLift: resolve('backgroundColor', 'var(--coral-lift)'),
        coralTint: resolve('backgroundColor', 'var(--coral-tint)'),
        ink: resolve('color', 'var(--ink)'),
        ink600: resolve('color', 'var(--ink-600)'),
        onMidnight: resolve('color', 'var(--on-midnight)'),
        onMidnight600: resolve('color', 'var(--on-midnight-600)'),
      },
    };
    probe.remove();
    return result;
  });
}

function documentIssues(route, width, m) {
  const issues = [];
  const check = (ok, message) => {
    if (!ok) issues.push(message);
  };
  const equal = (actual, expected, label) =>
    check(actual === expected, `${label}: ${actual} ≠ ${expected}`);
  const gap = (actual, expected, label) =>
    check(near(actual, expected), `${label}: ${actual} ≠ ${expected}`);
  const t = m.tokens;
  const midnight = route === '/guarantee';
  const small = width < 768;

  // The band: 40px over the eyebrow (64 from 48rem), 12px between eyebrow,
  // title and summary, and the body 80px below the summary (40 + 40), 96
  // from 48rem (48 + 48) and 112 from 64rem (48 + 64).
  const above = m.notice ? m.notice.bottom : m.header.bottom;
  gap(m.eyebrowText - above, small ? 40 : 64, 'band top padding');
  gap(m.title.top - m.eyebrow.bottom, 12, 'eyebrow to title');
  gap(m.summary.top - m.title.bottom, 12, 'title to summary');
  gap(
    m.body.top - m.summaryText,
    small ? 80 : width < 1024 ? 96 : 112,
    'summary to body',
  );
  equal(m.eyebrowFont, '14px/20px 600', 'eyebrow type');
  equal(m.titleFont, '32px/40px 700', 'title type');
  equal(m.summaryFont, '16px/24px 400', 'summary type');
  equal(m.rule.width, '16px', 'eyebrow rule width');
  equal(m.rule.height, '2px', 'eyebrow rule height');
  // The band paints surface (midnight on /guarantee) and bleeds to both
  // viewport edges as a shadow clipped to its own height.
  const bandColour = midnight ? t.midnight : t.surface;
  equal(m.band.color, bandColour, 'band colour');
  check(
    m.band.shadow.startsWith(bandColour) &&
      / 0px 0px 0px \d+(\.\d+)?px$/u.test(m.band.shadow),
    `band bleed: ${m.band.shadow}`,
  );
  check(/^inset\(0px -\d/u.test(m.band.clip), `band clip: ${m.band.clip}`);
  equal(m.eyebrowColor, midnight ? t.onMidnight600 : t.ink600, 'eyebrow ink');
  equal(m.rule.color, midnight ? t.coralLift : t.coral, 'eyebrow rule');
  equal(m.titleColor, midnight ? t.onMidnight : t.ink, 'title ink');
  equal(m.summaryColor, midnight ? t.onMidnight600 : t.ink600, 'summary ink');
  equal(m.media, 0, 'image slot');

  // Prose: 16/24 paragraphs; an H2 24/32 600, except the three /guarantee
  // promises, 32/40 700 under a 2px ink rule.
  equal(m.paragraphFont, '16px/24px 400', 'paragraph type');
  if (m.h2) {
    equal(m.h2.font, midnight ? '32px/40px 700' : '24px/32px 600', 'H2 type');
    equal(m.h2.border, midnight ? '2px' : '0px', 'H2 rule');
  }

  // The side card: below the prose under 64rem, at the column's width; from
  // 64rem, a sticky column of at least 320px, 80px beside the prose and
  // level with its first line.
  if (m.aside) {
    if (width >= 1024) {
      const [prose, side] = m.columns.split(' ').map(Number.parseFloat);
      equal(m.columnGap, '80px', 'column gap');
      check(side >= 320 - tolerance, `side column ${side}`);
      gap(m.aside.left - m.main.left, prose + 80, 'side card offset');
      gap(m.aside.width, side, 'side card width');
      gap(m.aside.top, m.body.top, 'side card level with the body');
      equal(m.asidePosition, 'sticky', 'side card position');
      equal(m.asideTop, '24px', 'side card sticky top');
    } else {
      gap(m.aside.width, m.main.width, 'side card width');
      gap(m.aside.top - m.articleEnd, 40, 'side card below the prose');
    }
    // Contents links: 44px tall under 64rem, 36 from it; each capsule's
    // text lines up with the card heading.
    for (const link of m.contents) {
      gap(link.height, width >= 1024 ? 36 : 44, 'contents link height');
      gap(
        link.left + Number.parseFloat(link.padding),
        m.cardHeading.left,
        'contents text edge',
      );
      check(
        link.right <= m.card.right + tolerance,
        'contents link inside the card',
      );
    }
  }

  // The archived revision's notice: coral tint, 14/20 500, a 20px icon, 16px
  // above and below, directly under the header.
  if (m.notice) {
    equal(m.notice.color, t.coralTint, 'notice tint');
    equal(m.notice.font, '14px/20px 500', 'notice type');
    equal(m.notice.padding, '16px 16px', 'notice padding');
    gap(m.notice.icon.width, 20, 'notice icon');
    gap(m.notice.top, m.header.bottom, 'notice under the header');
  }

  // The trust pages' join bar: below 48rem only, docked at the viewport's
  // foot across its width, padded 12px and the 16px gutter, the link a full
  // width 48px control.
  if (m.bar) {
    equal(m.bar.visible, small, 'join bar shown');
    if (small) {
      gap(m.bar.bottom, m.viewport.height, 'join bar docked');
      gap(m.bar.left, 0, 'join bar left');
      gap(m.bar.right, m.viewport.width, 'join bar right');
      equal(m.bar.padding, '12px 16px', 'join bar padding');
      gap(m.bar.link.width, m.viewport.width - 32, 'join link width');
      gap(m.bar.link.height, 48, 'join link height');
    }
  }
  return issues;
}

test('every page renders as drawn at each canvas width, in both themes, at rest', async () => {
  const issues = [];
  for (const route of routes) {
    for (const width of drawnWidths(route)) {
      for (const colorScheme of designThemes) {
        const { context, page } = await openPage(route, { width, colorScheme });
        try {
          const label = `${route} ${width}px ${colorScheme}`;
          for (const issue of documentIssues(
            route,
            width,
            await measureDocument(page),
          ))
            issues.push(`${label} ${issue}`);
        } finally {
          await context.close();
        }
      }
    }
  }
  assert.deepEqual(issues, []);
});

test('tables of three or more columns restack per row on phone, and no table overflows the page at 320', async () => {
  for (const route of ['/privacy', '/privacy/storage', '/legit']) {
    for (const width of [320, 390, 1440]) {
      const { context, page } = await openPage(route, { width });
      try {
        const result = await page.evaluate(() => {
          const { document } = globalThis;
          const rows = [...document.querySelectorAll('.document__prose tr')];
          return {
            overflow:
              document.documentElement.scrollWidth >
              document.documentElement.clientWidth,
            rows: rows.map((row) => ({
              row: row.getBoundingClientRect().toJSON(),
              cells: [...row.children].map((cell) =>
                cell.getBoundingClientRect().toJSON(),
              ),
            })),
          };
        });
        const label = `${route} ${width}px`;
        assert.equal(result.overflow, false, `${label} overflows the page`);
        assert.ok(result.rows.length > 0, `${label} has table rows`);
        for (const { row, cells } of result.rows) {
          if (cells.length < 3 || width >= 768) {
            // Two columns, or a wide viewport: one line per row.
            for (const cell of cells)
              assert.ok(near(cell.top, cells[0].top), `${label} row line`);
            continue;
          }
          // The first cell spans the row; the second and third sit side by
          // side beneath it; a fourth takes its own full-width line.
          assert.ok(near(cells[0].width, row.width), `${label} first cell`);
          assert.ok(near(cells[1].top, cells[2].top), `${label} pair line`);
          assert.ok(cells[1].top >= cells[0].bottom - tolerance, label);
          assert.ok(near(cells[1].width, row.width / 2), `${label} half`);
          assert.ok(near(cells[2].left, row.left + row.width / 2), label);
          if (cells[3]) {
            assert.ok(near(cells[3].width, row.width), `${label} fourth`);
            assert.ok(cells[3].top >= cells[1].bottom - tolerance, label);
          }
          for (const cell of cells)
            assert.ok(
              cell.right <= row.right + tolerance,
              `${label} cell inside`,
            );
        }
      } finally {
        await context.close();
      }
    }
  }
});

// Restarts each named element's CSS animation, holds it at its first frame,
// reads it, then reads its last frame: the entrance as the browser runs it.
function readEntrance(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const read = (element) => {
      if (!element) return null;
      element.style.animationName = 'none';
      void element.offsetWidth;
      element.style.animationName = '';
      const animations = element.getAnimations();
      const state = () => {
        const style = getComputedStyle(element);
        return {
          opacity: style.opacity,
          translate: style.translate,
          transform: style.transform,
        };
      };
      if (animations.length === 0) return { name: 'none', start: state() };
      const [animation] = animations;
      animation.pause();
      animation.currentTime = 0;
      const start = state();
      const timing = animation.effect.getComputedTiming();
      animation.currentTime = timing.endTime;
      const end = state();
      animation.cancel();
      return {
        name: animation.animationName,
        count: animations.length,
        delay: timing.delay,
        duration: timing.duration,
        endTime: timing.endTime,
        start,
        end,
      };
    };
    return {
      eyebrow: read(document.querySelector('[data-document-eyebrow]')),
      title: read(document.querySelector('article.document__prose > h1')),
      summary: read(document.querySelector('[data-document-summary]')),
      card: read(document.querySelector('.document__card')),
      bar: read(document.querySelector('[data-join-bar]')),
    };
  });
}

test('the band and the side card enter at first paint within 600ms, the join bar slides in, and the title never moves', async () => {
  for (const [route, width] of [
    ['/legit', 390],
    ['/guarantee', 1440],
    ['/privacy', 1440],
    [archivedRoute, 390],
  ]) {
    const { context, page } = await openPage(route, { width, motion: true });
    try {
      const entrance = await readEntrance(page);
      const label = `${route} ${width}px`;
      const rest = { opacity: '1', translate: 'none', transform: 'none' };
      const risen = (state) => /^0px 12px$/u.test(state.translate);
      // The eyebrow (index 0) and the summary (index 2) rise 12px and fade
      // in over --duration-enter, one --stagger step apart per index.
      for (const [part, delay] of [
        ['eyebrow', 0],
        ['summary', 120],
      ]) {
        const read = entrance[part];
        assert.equal(read.name, 'motion-enter', `${label} ${part}`);
        assert.equal(read.delay, delay, `${label} ${part} delay`);
        assert.equal(read.duration, 400, `${label} ${part} duration`);
        assert.equal(read.start.opacity, '0', `${label} ${part} start`);
        assert.ok(risen(read.start), `${label} ${part} rises`);
        assert.deepEqual(read.end, rest, `${label} ${part} rest`);
      }
      // The title is the content's H1, inside the article: never animated.
      assert.equal(entrance.title.name, 'none', `${label} title`);
      assert.deepEqual(entrance.title.start, rest, `${label} title at rest`);
      // The side card (index 3) only rises: its controls are at full
      // opacity and usable from first paint.
      assert.equal(entrance.card.name, 'motion-enter-shift', label);
      assert.equal(entrance.card.delay, 180, `${label} card delay`);
      assert.equal(entrance.card.start.opacity, '1', `${label} card opacity`);
      assert.ok(risen(entrance.card.start), `${label} card rises`);
      assert.deepEqual(entrance.card.end, rest, `${label} card rest`);
      for (const part of ['eyebrow', 'summary', 'card'])
        assert.ok(
          Math.round(entrance[part].endTime) <= 580,
          `${label} ${part} ends: ${entrance[part].endTime}`,
        );
      // The join bar, on trust pages only, slides up from below its own
      // height over --duration-base, as the sticky bar does.
      if (route === '/legit') {
        assert.equal(entrance.bar.name, 'document-join-bar-in', label);
        assert.equal(entrance.bar.duration, 200, `${label} bar duration`);
        const [, , , , , y] = entrance.bar.start.transform
          .match(/-?[\d.]+/gu)
          .map(Number);
        const height = await page
          .locator('[data-join-bar]')
          .evaluate((bar) => bar.getBoundingClientRect().height);
        assert.ok(near(y, height), `${label} bar starts below: ${y}`);
        assert.deepEqual(entrance.bar.end, rest, `${label} bar rest`);
      } else if (trustRoutes.includes(route)) {
        // From 48rem the bar is not shown, so it has nothing to animate.
        assert.equal(entrance.bar.name, 'none', `${label} bar hidden`);
      } else {
        assert.equal(entrance.bar, null, `${label} has no join bar`);
      }
    } finally {
      await context.close();
    }
  }
});

test('under reduced motion nothing on these pages moves: no entrance, no slide-in, no link transition, and anchors jump', async () => {
  for (const route of routes) {
    for (const width of [390, 1440]) {
      const { context, page } = await openPage(route, { width });
      try {
        await page.waitForLoadState('load');
        const label = `${route} ${width}px`;
        const entrance = await readEntrance(page);
        for (const part of ['eyebrow', 'title', 'summary', 'card', 'bar']) {
          if (entrance[part] === null) continue;
          assert.equal(entrance[part].name, 'none', `${label} ${part}`);
          assert.deepEqual(
            entrance[part].start,
            { opacity: '1', translate: 'none', transform: 'none' },
            `${label} ${part} at rest`,
          );
        }
        const link = page.locator('.document__contents a').first();
        if ((await link.count()) > 0 && width >= 1024) await link.hover();
        const still = await page.evaluate(() => ({
          animations: globalThis.document.getAnimations().length,
          scroll: globalThis.getComputedStyle(
            globalThis.document.documentElement,
          ).scrollBehavior,
          contents: [
            ...globalThis.document.querySelectorAll('.document__contents a'),
          ].map(
            (element) =>
              globalThis.getComputedStyle(element).transitionProperty,
          ),
        }));
        assert.equal(still.animations, 0, `${label} animations`);
        assert.equal(still.scroll, 'auto', `${label} anchors jump`);
        for (const property of still.contents)
          assert.equal(property, 'none', `${label} contents transition`);
      } finally {
        await context.close();
      }
    }
  }
});

// Every element inside the article, and its generated boxes: no animation
// name, and no transition that could run; and no live animation of any kind
// targets one.
function articleMotion(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const article = document.querySelector('article.document__prose');
    const moving = [];
    for (const element of [article, ...article.querySelectorAll('*')]) {
      for (const pseudo of [null, '::before', '::after', '::marker']) {
        const style = getComputedStyle(element, pseudo);
        const durations = style.transitionDuration
          .split(',')
          .map((value) => Number.parseFloat(value));
        if (
          style.animationName !== 'none' ||
          (style.transitionProperty !== 'none' &&
            durations.some((value) => value > 0))
        )
          moving.push(`${element.tagName.toLowerCase()}${pseudo ?? ''}`);
      }
    }
    const live = document
      .getAnimations()
      .filter((animation) => article.contains(animation.effect?.target))
      .map((animation) => animation.effect.target.tagName.toLowerCase());
    return { moving, live, links: article.querySelectorAll('a').length };
  });
}

test('no element inside the article carries an animation or transition at any time', async () => {
  for (const route of routes) {
    for (const width of [390, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: 'no-preference',
      });
      try {
        const page = await context.newPage();
        const label = `${route} ${width}px`;
        // At first paint, while the band and card are entering.
        await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
        let motion = await articleMotion(page);
        assert.deepEqual(motion.moving, [], `${label} at first paint`);
        assert.deepEqual(motion.live, [], `${label} live at first paint`);
        // At rest, and while a reader hovers and focuses the article's links.
        await page.waitForLoadState('load');
        const links = page.locator('article.document__prose a');
        const count = Math.min(await links.count(), 6);
        for (let index = 0; index < count; index += 1) {
          const link = links.nth(index);
          await link.scrollIntoViewIfNeeded();
          await link.hover();
          await link.focus();
          motion = await articleMotion(page);
          assert.deepEqual(motion.moving, [], `${label} link ${index}`);
          assert.deepEqual(motion.live, [], `${label} live, link ${index}`);
        }
      } finally {
        await context.close();
      }
    }
  }
});

test('contents links scroll smoothly to the heading anchors already in the content, and take the link motion on hover', async () => {
  for (const [route, width] of [
    ['/giveaway/rules', 1440],
    ['/privacy', 390],
  ]) {
    const { context, page } = await openPage(route, { width, motion: true });
    try {
      await page.waitForLoadState('load');
      const label = `${route} ${width}px`;
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.getComputedStyle(globalThis.document.documentElement)
              .scrollBehavior,
        ),
        'smooth',
        label,
      );
      const link = page.locator('.document__contents a').nth(1);
      const id = (await link.getAttribute('href')).slice(1);
      // The link motion (E11.5-11k): colour, fill and underline colour over
      // --duration-fast with --ease-out.
      const motion = await link.evaluate((element) => {
        const style = globalThis.getComputedStyle(element);
        return [
          style.transitionProperty,
          style.transitionDuration,
          style.transitionTimingFunction,
        ];
      });
      assert.deepEqual(
        motion,
        [
          'color, background-color, text-decoration-color',
          '0.15s',
          'cubic-bezier(0.16, 1, 0.3, 1)',
        ],
        `${label} link motion`,
      );
      // Clicking scrolls through intermediate positions, then rests with
      // the heading 24px below the viewport top (its scroll margin).
      const positions = await page.evaluate(
        (target) =>
          new Promise((resolve) => {
            const seen = [];
            const sample = () => {
              seen.push(globalThis.scrollY);
              if (seen.length < 120) globalThis.requestAnimationFrame(sample);
              else resolve(seen);
            };
            globalThis.document
              .querySelector(`.document__contents a[href="#${target}"]`)
              .click();
            globalThis.requestAnimationFrame(sample);
          }),
        id,
      );
      await scrollSettled(page);
      const landed = await page.evaluate((target) => {
        const heading = globalThis.document.getElementById(target);
        return {
          top: heading.getBoundingClientRect().top,
          tag: heading.tagName,
          inArticle: Boolean(heading.closest('article.document__prose')),
          hash: globalThis.location.hash,
          y: globalThis.scrollY,
        };
      }, id);
      assert.equal(landed.tag, 'H2', label);
      assert.ok(landed.inArticle, `${label} anchor in the content`);
      assert.equal(landed.hash, `#${id}`, label);
      assert.ok(near(landed.top, 24), `${label} heading top ${landed.top}`);
      const between = new Set(
        positions.filter((y) => y > 0 && y < landed.y - tolerance),
      );
      assert.ok(between.size >= 2, `${label} scrolls smoothly`);
    } finally {
      await context.close();
    }
  }
});
