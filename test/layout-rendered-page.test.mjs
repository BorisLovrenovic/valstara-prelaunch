import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-layout-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const permanentFooterUrls = [
  '/legit',
  '/guarantee',
  '/about',
  '/terms',
  '/privacy',
];
// E11.5-03: the footer's two columns and contact, in DOM order, after the
// footer wordmark.
const footerUrls = [
  '/',
  '/about',
  '/legit',
  '/guarantee',
  '/terms',
  '/privacy',
  '/privacy/storage',
  '/giveaway/rules',
  'mailto:support@valstara.com',
];
const designWidths = [320, 360, 390, 768, 1024, 1280, 1440, 1920];
const sectionAnchors = ['#how', '#rewards', '#guarantee', '#faq'];

let app;
let browser;
let browserOrigin;
let browserServer;
let browserServerError;

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

before(async () => {
  await ensureAppBuild();
  // A reserved port below the kernel's ephemeral range; only a lost bind
  // race is retried (test/helpers/listen-port.mjs).
  app = await startAppServer({
    label: 'Layout rendered-page test',
    env: () => ({
      ADMIN_CREDENTIAL: 'layout-rendered-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL:
        'postgresql://unused:unused@127.0.0.1:5434/unused-layout-test',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'layout-rendered-page-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'layout-rendered-page-referral-secret',
      RESEND_API_KEY: 'layout-rendered-page-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'layout-rendered-page-turnstile-secret',
    }),
  });
  browserOrigin = `http://host.docker.internal:${app.port}`;
  const browserServerEndpoint = await startBrowserServer();
  browser = await chromium.connect(browserServerEndpoint);
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

test('the shell exposes one main landmark and a skip link as the first focusable element', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(browserOrigin);

  // Exactly one main, and the banner/contentinfo landmarks are present.
  assert.equal(await page.getByRole('main').count(), 1);
  assert.equal(await page.getByRole('banner').count(), 1);
  assert.equal(await page.getByRole('contentinfo').count(), 1);
  // E11.5-11b: the skip link targets #main, as the wireframe frames draw it.
  assert.equal(await page.locator('main').getAttribute('id'), 'main');

  // The very first Tab lands on the skip link, and it points at the main.
  await page.keyboard.press('Tab');
  const skipLink = page.locator('a.skip-link');
  assert.equal(
    await skipLink.evaluate((element) => element.matches(':focus')),
    true,
    'the skip link is the first focusable element',
  );
  assert.equal(await skipLink.getAttribute('href'), '#main');

  // Hidden off-screen by default, it becomes visible within the viewport once
  // focused, so a keyboard visitor can see and use it. The reveal is a timed
  // transition, so wait for it to settle before sampling the box — otherwise
  // the position is read mid-animation and the assertion races the transition.
  await page.waitForFunction(() => {
    const link = globalThis.document.querySelector('a.skip-link');
    return link !== null && link.getBoundingClientRect().top >= 0;
  });
  const focusedBox = await skipLink.boundingBox();
  assert.ok(
    focusedBox !== null && focusedBox.y >= 0,
    'skip link is visible on focus',
  );

  // Following it moves the document to the main content.
  await skipLink.press('Enter');
  assert.equal(new URL(page.url()).hash, '#main');

  await context.close();
});

test('the landing page ships only the theme toggle and signup form islands', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(browserOrigin);

  // The shell itself adds only the theme toggle; the landing page adds the one
  // signup form island (E3-05), the first-party page-view emitter (E10-01)
  // and Cloudflare's Turnstile loader. Every script must fit an approved
  // source — a stray script or a third island fails.
  const scripts = await page.locator('script').evaluateAll((elements) =>
    elements.map((element) => ({
      content: element.textContent ?? '',
      src: element.getAttribute('src') ?? '',
      type: element.getAttribute('type') ?? '',
    })),
  );
  const theme = scripts.filter((script) =>
    script.content.includes('valstara-theme'),
  );
  const signupIsland = scripts.filter((script) =>
    /SignupForm\.astro[^"']*\.js/u.test(script.src),
  );
  const turnstileLoader = scripts.filter((script) =>
    script.src.includes('challenges.cloudflare.com/turnstile'),
  );
  const pageView = scripts.filter((script) => script.src === '/page-view.js');
  const structuredData = scripts.filter(
    (script) => script.type === 'application/ld+json',
  );

  assert.equal(theme.length, 2, 'the toggle bootstrap and island scripts ship');
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

  await context.close();
});

// Rewritten in E11.5-03 to the new link set: Company and Legal columns plus
// contact. The five permanent URLs (E2-05) must all still be linked.
test('the footer is a midnight band with Company and Legal columns, contact and the legal line', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({
      colorScheme,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(browserOrigin);

    const footer = page.getByRole('contentinfo');
    const hrefs = await footer
      .locator('a')
      .evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.getAttribute('href')),
      );
    assert.deepEqual(hrefs, footerUrls);
    for (const permanent of permanentFooterUrls) {
      assert.ok(hrefs.includes(permanent), `footer links ${permanent}`);
    }

    for (const [heading, links] of [
      ['Company', ['About', 'Legit', 'Guarantee']],
      ['Legal', ['Terms', 'Privacy', 'Storage inventory', 'Giveaway rules']],
    ]) {
      const list = footer.getByRole('list', { name: heading });
      assert.deepEqual(
        (await list.getByRole('link').allTextContents()).map((text) =>
          text.trim(),
        ),
        links,
      );
    }
    assert.equal(
      (await footer
        .getByRole('link', { exact: true, name: 'Valstara' })
        .count()) +
        (await footer
          .locator('a', { hasText: 'support@valstara.com' })
          .count()),
      2,
    );
    assert.equal(
      (await footer.locator('.site-footer__legal').textContent()).trim(),
      'Valstara is a trading brand of 3NITY Digital Limited, registered in Hong Kong.',
    );

    const band = await footer.evaluate((element) => {
      const probe = globalThis.document.createElement('div');
      probe.style.backgroundColor = 'var(--midnight)';
      globalThis.document.body.append(probe);
      const midnight = globalThis.getComputedStyle(probe).backgroundColor;
      probe.remove();
      const box = element.getBoundingClientRect();
      return {
        background: globalThis.getComputedStyle(element).backgroundColor,
        left: box.left,
        midnight,
        width: box.width,
      };
    });
    assert.equal(band.background, band.midnight, colorScheme);
    assert.equal(band.left, 0, 'the band is full width');
    assert.equal(band.width, 1280, 'the band is full width');

    // The two link columns sit side by side from medium width.
    const columns = await footer
      .locator('.footer-links')
      .evaluateAll((lists) =>
        lists.map((list) => list.getBoundingClientRect().top),
      );
    assert.equal(columns.length, 2);
    assert.equal(columns[0], columns[1]);

    await context.close();
  }
});

test('the header shows wordmark, Join and toggle at small widths, and the section links from medium', async () => {
  for (const width of designWidths) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        colorScheme,
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      for (const [path, prefix] of [
        ['/', ''],
        ['/verify', '/'],
      ]) {
        await page.goto(`${browserOrigin}${path}`);
        const header = page.getByRole('banner');
        const visible = await header.evaluate((element) =>
          [...element.querySelectorAll('a[href], button')]
            .filter((control) => control.getClientRects().length > 0)
            .map((control) => ({
              href: control.getAttribute('href'),
              name: (
                control.getAttribute('aria-label') ?? control.textContent
              ).trim(),
              tag: control.tagName,
            })),
        );
        const sectionLinks = sectionAnchors.map((anchor) => ({
          href: `${prefix}${anchor}`,
          tag: 'A',
        }));
        const expected = [
          { href: '/', name: 'Valstara', tag: 'A' },
          ...(width >= 768
            ? sectionLinks.map((link, index) => ({
                ...link,
                name: ['How it works', 'What you get', 'Guarantee', 'FAQ'][
                  index
                ],
              }))
            : []),
          // E11.5-11b: the theme toggle, then Join, as the frames draw them.
          { href: null, name: 'Use dark theme', tag: 'BUTTON' },
          { href: `${prefix}#join`, name: 'Join the waitlist', tag: 'A' },
        ];
        if (colorScheme === 'dark') expected.at(-2).name = 'Use light theme';
        await page.waitForFunction(
          () =>
            globalThis.document.querySelector('valstara-theme-toggle button')
              ?.disabled === false,
        );
        const settled = await header.evaluate((element) =>
          [...element.querySelectorAll('a[href], button')]
            .filter((control) => control.getClientRects().length > 0)
            .map((control) => ({
              href: control.getAttribute('href'),
              name: control.textContent.trim(),
              tag: control.tagName,
            })),
        );
        assert.equal(visible.length, settled.length);
        assert.deepEqual(
          settled,
          expected,
          `${path} at ${width}px ${colorScheme}`,
        );

        // Not sticky: the header scrolls away with the page.
        assert.equal(
          await header.evaluate(
            (element) => globalThis.getComputedStyle(element).position,
          ),
          'static',
        );
        const overflow = await header.evaluate(
          (element) => element.scrollWidth > element.clientWidth,
        );
        assert.equal(overflow, false, `header fits at ${width}px`);
      }
      await context.close();
    }
  }
});

test('the small-width header adds no script and no menu', async () => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(browserOrigin);
  const header = page.getByRole('banner');

  // The only script inside the header belongs to the theme toggle island.
  const headerScripts = await header.locator('script').evaluateAll((scripts) =>
    scripts.map((script) => ({
      inToggle: script.closest('valstara-theme-toggle') !== null,
      toggleCode: (script.getAttribute('src') ?? script.textContent).includes(
        'valstara-theme-toggle',
      ),
    })),
  );
  assert.ok(headerScripts.length <= 1, JSON.stringify(headerScripts));
  for (const script of headerScripts) {
    assert.ok(script.inToggle || script.toggleCode, JSON.stringify(script));
  }

  // No disclosure, popup or hidden menu pattern exists in the header.
  for (const selector of [
    '[aria-expanded]',
    '[aria-haspopup]',
    '[aria-controls]',
    'details',
    'dialog',
    '[popover]',
    '[role="menu"]',
    '[role="menubar"]',
  ]) {
    assert.equal(await header.locator(selector).count(), 0, selector);
  }
  // The section links are not rendered at all at this width, not merely moved.
  assert.equal(
    await header
      .locator('.site-nav')
      .evaluate((element) => globalThis.getComputedStyle(element).display),
    'none',
  );

  // The page ships the same scripts at small and large widths: nothing loads
  // to drive a small-screen menu.
  const scripts = async () =>
    page
      .locator('script')
      .evaluateAll((elements) =>
        elements.map(
          (element) => element.getAttribute('src') ?? element.textContent,
        ),
      );
  const small = await scripts();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  assert.deepEqual(await scripts(), small);

  await context.close();
});

test('trust pages render the same shell without the toggle or any script', async () => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`${browserOrigin}/legit`);
  assert.equal(await page.getByRole('main').count(), 1);
  assert.equal(await page.locator('valstara-theme-toggle').count(), 0);
  const footerHrefs = await page
    .getByRole('contentinfo')
    .locator('a')
    .evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute('href')),
    );
  assert.deepEqual(footerHrefs, footerUrls);
  assert.equal(
    await page
      .getByRole('banner')
      .getByRole('link', { name: 'Join the waitlist' })
      .getAttribute('href'),
    '/#join',
  );
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .locator('a.skip-link')
      .evaluate((element) => element.matches(':focus')),
    true,
  );
  await context.close();
});

test('the page never scrolls horizontally from 320px upward', async () => {
  const breakpoints = [320, 375, 414, 768, 1024, 1440];
  const context = await browser.newContext();
  const page = await context.newPage();

  for (const width of breakpoints) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(browserOrigin);
    const overflow = await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth,
    );
    assert.ok(
      overflow <= width,
      `no horizontal overflow at ${width}px (content width ${overflow})`,
    );
  }

  await context.close();
});

// E11.5-11b: the header and footer geometry from Main.dc.html (1440),
// Tablet.dc.html (768) and Phone.dc.html (390), plus 360 and 320 for the
// 22.5rem Join step, in both themes. Every value is a frame value, measured
// with a 1px tolerance.
const wireframeWidths = [1440, 768, 390, 360, 320];

function near(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) <= 1,
    `${message}: ${actual} is not ${expected} ± 1`,
  );
}

async function openSettled(width, colorScheme, path = '/') {
  const context = await browser.newContext({
    colorScheme,
    viewport: { width, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`${browserOrigin}${path}`);
  await page.evaluate(() => globalThis.document.fonts.ready);
  return { context, page };
}

// The container's content edges at a width: 16px gutters below 48rem, 32px
// from 48rem, and a 1200px cap.
function containerEdges(width) {
  const gutter = width >= 768 ? 32 : 16;
  const content = Math.min(width - gutter * 2, 1200);
  const left = (width - content) / 2;
  return { left, right: left + content, width: content };
}

test('the header matches the wireframe geometry at every frame width in both themes', async () => {
  for (const width of wireframeWidths) {
    for (const colorScheme of ['light', 'dark']) {
      const { context, page } = await openSettled(width, colorScheme);
      const label = `${width}px ${colorScheme}`;
      const header = await page.getByRole('banner').evaluate((element) => {
        const box = (node) => {
          const rect = node.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          };
        };
        const style = (node) => globalThis.getComputedStyle(node);
        const wordmark = element.querySelector('.site-name');
        const toggle = element.querySelector('valstara-theme-toggle button');
        const join = element.querySelector('.site-header__join');
        const links = [...element.querySelectorAll('.site-nav__links a')];
        const probe = globalThis.document.createElement('span');
        probe.style.color = 'var(--ink-600)';
        element.append(probe);
        const ink600 = style(probe).color;
        probe.remove();
        // Widen the label, as a font swap can, and measure Join again.
        join.style.letterSpacing = '0.1em';
        const widerLabelWidth = join.getBoundingClientRect().width;
        join.style.removeProperty('letter-spacing');
        return {
          box: box(element),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          position: style(element).position,
          ink600,
          wordmark: {
            ...box(wordmark),
            fontSize: style(wordmark).fontSize,
            lineHeight: style(wordmark).lineHeight,
            fontWeight: style(wordmark).fontWeight,
            letterSpacing: style(wordmark).letterSpacing,
          },
          navDisplay: style(element.querySelector('.site-nav')).display,
          links: links.map((link) => ({
            ...box(link),
            color: style(link).color,
            fontSize: style(link).fontSize,
            lineHeight: style(link).lineHeight,
            fontWeight: style(link).fontWeight,
            paddingTop: style(link).paddingTop,
            paddingLeft: style(link).paddingLeft,
          })),
          toggle: box(toggle),
          join: {
            ...box(join),
            widerLabelWidth,
            fontSize: style(join).fontSize,
            lineHeight: style(join).lineHeight,
            paddingLeft: style(join).paddingLeft,
            paddingRight: style(join).paddingRight,
          },
        };
      });
      const edges = containerEdges(width);
      const large = width >= 1024;
      const medium = width >= 768 && !large;
      const height = width >= 768 ? 80 : 72;

      assert.equal(header.position, 'static', `${label}: not sticky`);
      near(header.box.height, height, `${label}: header height`);
      assert.ok(
        header.scrollWidth <= header.clientWidth,
        `${label}: the header fits with no horizontal overflow`,
      );

      // The wordmark: 20/28 600 with -0.01em tracking, on the container edge.
      assert.equal(header.wordmark.fontSize, '20px', label);
      assert.equal(header.wordmark.lineHeight, '28px', label);
      assert.equal(header.wordmark.fontWeight, '600', label);
      assert.equal(header.wordmark.letterSpacing, '-0.2px', label);
      near(header.wordmark.left, edges.left, `${label}: wordmark left`);

      // Every item is centred in the header row.
      for (const [name, item] of [
        ['wordmark', header.wordmark],
        ['toggle', header.toggle],
        ['join', header.join],
      ]) {
        near(
          item.top + item.height / 2,
          header.box.top + height / 2,
          `${label}: ${name} centred`,
        );
      }

      // The toggle is 44 × 44; the h44 Join (xs below 22.5rem) ends on the
      // container edge, 12px after the toggle (8px at small widths).
      near(header.toggle.width, 44, `${label}: toggle width`);
      near(header.toggle.height, 44, `${label}: toggle height`);
      near(header.join.height, 44, `${label}: join height`);
      near(header.join.right, edges.right, `${label}: join right edge`);
      near(
        header.join.left - header.toggle.right,
        width >= 768 ? 12 : 8,
        `${label}: toggle to join gap`,
      );
      const xs = width < 360;
      // The frames' widths: the label plus 20px padding (12px for xs).
      near(header.join.width, xs ? 130 : 159, `${label}: join width`);
      // The width is fixed, not the label's, so the right-aligned actions
      // do not move when the font swaps (E2-02).
      assert.equal(
        header.join.widerLabelWidth,
        header.join.width,
        `${label}: join width ignores the label width`,
      );
      assert.equal(header.join.fontSize, xs ? '14px' : '16px', label);
      assert.equal(header.join.lineHeight, xs ? '20px' : '24px', label);
      assert.equal(header.join.paddingLeft, xs ? '12px' : '20px', label);
      assert.equal(header.join.paddingRight, xs ? '12px' : '20px', label);

      if (width < 768) {
        // No nav links and no menu at small widths.
        assert.equal(header.navDisplay, 'none', label);
      } else {
        assert.equal(header.links.length, 4, label);
        near(
          header.links[0].left - header.wordmark.right,
          large ? 40 : 24,
          `${label}: wordmark to nav gap`,
        );
        header.links.forEach((link, index) => {
          assert.equal(link.fontSize, '14px', label);
          assert.equal(link.lineHeight, '20px', label);
          assert.equal(link.fontWeight, '500', label);
          assert.equal(link.color, header.ink600, `${label}: ink-600 link`);
          assert.equal(link.paddingTop, '12px', label);
          assert.equal(link.paddingLeft, medium ? '10px' : '12px', label);
          near(link.height, 44, `${label}: nav link height`);
          if (index > 0) {
            near(
              link.left - header.links[index - 1].right,
              large ? 4 : 0,
              `${label}: nav link gap`,
            );
          }
        });
      }
      await context.close();
    }
  }
});

test('the header Join button steps from xs to h44 at 22.5rem', async () => {
  for (const [width, padding] of [
    [359, '12px'],
    [360, '20px'],
  ]) {
    const { context, page } = await openSettled(width, 'light');
    const join = page.locator('.site-header__join');
    assert.equal(
      await join.evaluate(
        (element) => globalThis.getComputedStyle(element).paddingLeft,
      ),
      padding,
      `${width}px`,
    );
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.document.documentElement.clientWidth,
      ),
      true,
      `${width}px has no horizontal overflow`,
    );
    await context.close();
  }
});

test('the footer matches the wireframe grid at every frame width in both themes', async () => {
  for (const width of wireframeWidths) {
    for (const colorScheme of ['light', 'dark']) {
      const { context, page } = await openSettled(width, colorScheme);
      const label = `${width}px ${colorScheme}`;
      const footer = await page.getByRole('contentinfo').evaluate((element) => {
        const box = (node) => {
          const rect = node.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          };
        };
        const style = (node) => globalThis.getComputedStyle(node);
        const probe = globalThis.document.createElement('span');
        probe.style.color = 'var(--on-midnight)';
        probe.style.backgroundColor = 'var(--midnight)';
        element.append(probe);
        const onMidnight = style(probe).color;
        const midnight = style(probe).backgroundColor;
        probe.remove();
        const columns = [...element.querySelectorAll('.site-footer__column')];
        const lines = element.querySelector('.site-footer__lines');
        return {
          box: box(element),
          background: style(element).backgroundColor,
          color: style(element).color,
          boxShadow: style(element).boxShadow,
          marginTop: style(element).marginTop,
          paddingTop: style(element).paddingTop,
          paddingBottom: style(element).paddingBottom,
          midnight,
          onMidnight,
          wordmark: box(element.querySelector('.site-name--footer')),
          grid: box(element.querySelector('.site-footer__grid')),
          columns: columns.map((column) => {
            const heading = column.querySelector('.site-footer__heading');
            const links = [...column.querySelectorAll('a')];
            return {
              ...box(column),
              heading: {
                ...box(heading),
                fontSize: style(heading).fontSize,
                lineHeight: style(heading).lineHeight,
                fontWeight: style(heading).fontWeight,
              },
              links: links.map((link) => ({
                ...box(link),
                color: style(link).color,
                fontSize: style(link).fontSize,
                lineHeight: style(link).lineHeight,
                paddingTop: style(link).paddingTop,
              })),
            };
          }),
          lines: {
            ...box(lines),
            maxWidth: style(lines).maxWidth,
            opacity: style(lines).opacity,
            paragraphs: [...lines.querySelectorAll('p')].map((paragraph) => ({
              ...box(paragraph),
              fontSize: style(paragraph).fontSize,
              lineHeight: style(paragraph).lineHeight,
            })),
          },
        };
      });
      const edges = containerEdges(width);
      const large = width >= 1024;
      const medium = width >= 768 && !large;
      const columnsWide = width >= 768 ? 12 : 4;
      const gap = width >= 768 ? 24 : 16;
      const track = (edges.width - gap * (columnsWide - 1)) / columnsWide;
      const columnStart = (column) => edges.left + (column - 1) * (track + gap);

      // A full-width midnight band, padded 64 / 48, the section gap above it.
      assert.equal(footer.background, footer.midnight, label);
      assert.equal(footer.color, footer.onMidnight, label);
      near(footer.box.left, 0, `${label}: band left`);
      near(footer.box.width, width, `${label}: band width`);
      assert.equal(footer.paddingTop, '64px', label);
      assert.equal(footer.paddingBottom, '48px', label);
      assert.equal(footer.marginTop, large ? '80px' : '64px', label);
      // Only the section gap sits above the footer: main adds no bottom
      // padding, on the landing page and on a document page alike.
      for (const path of ['/', '/terms']) {
        const shell = await openSettled(width, colorScheme, path);
        near(
          await shell.page.evaluate(() => {
            const main = globalThis.document.querySelector('main');
            const footer = globalThis.document.querySelector('body > footer');
            return (
              footer.getBoundingClientRect().top -
              main.lastElementChild.getBoundingClientRect().bottom
            );
          }),
          large ? 80 : 64,
          `${label} ${path}: gap above the footer`,
        );
        await shell.context.close();
      }
      // The dark frames edge the band with the 1px `--edge` line.
      if (colorScheme === 'dark') {
        assert.match(
          footer.boxShadow,
          /rgba\(240, 240, 238, 0\.1\) 0px 0px 0px 1px/u,
        );
      } else {
        assert.match(footer.boxShadow, /rgba\(0, 0, 0, 0\) 0px 0px 0px 0px/u);
      }

      // The wordmark's text sits on the padding; its 44px target extends 8px
      // above and below the 28px line.
      const wordmarkText = footer.wordmark.top + 8;
      near(wordmarkText, footer.box.top + 64, `${label}: wordmark top`);
      near(footer.wordmark.height, 44, `${label}: wordmark target`);
      near(footer.wordmark.left, edges.left, `${label}: wordmark left`);

      const [company, legal, contact] = footer.columns;
      assert.deepEqual(
        footer.columns.map((column) => column.links.length),
        [3, 4, 1],
        label,
      );
      if (large) {
        // Columns 1–4, 5–6, 7–8 and 9–12, all on the wordmark's row.
        near(company.left, columnStart(5), `${label}: Company column`);
        near(legal.left, columnStart(7), `${label}: Legal column`);
        near(contact.left, columnStart(9), `${label}: Contact column`);
        for (const column of footer.columns) {
          near(column.top, wordmarkText, `${label}: column top`);
        }
      } else {
        // The wordmark on its own row, the columns 32px below its text.
        const columnsTop = wordmarkText + 28 + 32;
        near(company.top, columnsTop, `${label}: columns top`);
        near(legal.top, columnsTop, `${label}: columns top`);
        near(company.left, edges.left, `${label}: Company column`);
        if (medium) {
          // Three equal columns, span 4 each.
          near(legal.left, columnStart(5), `${label}: Legal column`);
          near(contact.left, columnStart(9), `${label}: Contact column`);
          near(contact.top, columnsTop, `${label}: Contact top`);
          near(company.width, track * 4 + gap * 3, `${label}: span 4`);
        } else {
          // Company span 2, Legal span 2, Contact span 4 on the next row.
          near(legal.left, columnStart(3), `${label}: Legal column`);
          near(company.width, track * 2 + gap, `${label}: span 2`);
          near(contact.left, edges.left, `${label}: Contact column`);
          near(contact.width, edges.width, `${label}: span 4`);
          near(
            contact.top - Math.max(company.bottom, legal.bottom),
            24,
            `${label}: row gap`,
          );
        }
      }

      for (const column of footer.columns) {
        assert.equal(column.heading.fontSize, '14px', label);
        assert.equal(column.heading.lineHeight, '20px', label);
        assert.equal(column.heading.fontWeight, '600', label);
        near(
          column.links[0].top - column.heading.bottom,
          8,
          `${label}: heading to links`,
        );
        for (const link of column.links) {
          assert.equal(link.color, footer.onMidnight, label);
          assert.equal(link.fontSize, '14px', label);
          assert.equal(link.lineHeight, '20px', label);
          assert.equal(link.paddingTop, large ? '6px' : '12px', label);
          near(link.height, large ? 32 : 44, `${label}: link height`);
        }
      }

      // The trademark and legal lines: 48 / 40 / 32px below the columns,
      // 14/20, 8px apart, at most 760px wide, at 85% opacity.
      near(
        footer.lines.top - footer.grid.bottom,
        large ? 48 : medium ? 40 : 32,
        `${label}: lines below the columns`,
      );
      assert.equal(footer.lines.maxWidth, '760px', label);
      assert.equal(footer.lines.opacity, '0.85', label);
      assert.ok(footer.lines.width <= 760, label);
      const [trademark, legalLine] = footer.lines.paragraphs;
      near(legalLine.top - trademark.bottom, 8, `${label}: lines gap`);
      for (const paragraph of footer.lines.paragraphs) {
        assert.equal(paragraph.fontSize, '14px', label);
        assert.equal(paragraph.lineHeight, '20px', label);
      }
      near(
        footer.box.bottom - footer.lines.bottom,
        48,
        `${label}: bottom padding`,
      );
      await context.close();
    }
  }
});

test('every header and footer link reaches a real route, and footer targets are 44px at small widths', async () => {
  const landing = await openSettled(390, 'light');
  const landingIds = await landing.page.evaluate(() =>
    [...globalThis.document.querySelectorAll('[id]')].map(
      (element) => element.id,
    ),
  );
  await landing.context.close();

  for (const path of ['/', '/legit', '/verify', '/terms']) {
    const { context, page } = await openSettled(1440, 'light', path);
    // The skip link targets the page's one main.
    assert.equal(
      await page.locator('a.skip-link').getAttribute('href'),
      '#main',
    );
    assert.equal(await page.locator('main#main').count(), 1, path);

    const hrefs = await page
      .locator('body > header a[href], body > footer a[href]')
      .evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.getAttribute('href')),
      );
    assert.ok(hrefs.length >= 14, `${path}: ${hrefs.length} shell links`);
    for (const href of hrefs) {
      if (href.startsWith('mailto:')) {
        assert.equal(href, 'mailto:support@valstara.com', path);
        continue;
      }
      const target = new URL(href, `${browserOrigin}${path}`);
      if (target.hash !== '') {
        // Section anchors live on the landing page; elsewhere they lead back.
        assert.equal(target.pathname, '/', `${path}: ${href}`);
        assert.ok(
          landingIds.includes(target.hash.slice(1)),
          `${path}: ${href} resolves on the landing page`,
        );
        if (path !== '/') assert.ok(href.startsWith('/#'), `${path}: ${href}`);
        continue;
      }
      const response = await page.request.get(target.href, {
        maxRedirects: 0,
      });
      assert.equal(response.status(), 200, `${path}: ${href}`);
    }
    await context.close();
  }

  for (const width of [320, 360, 390]) {
    for (const colorScheme of ['light', 'dark']) {
      const { context, page } = await openSettled(width, colorScheme);
      const targets = await page
        .locator('body > footer a[href]')
        .evaluateAll((anchors) =>
          anchors.map((anchor) => {
            const rect = anchor.getBoundingClientRect();
            return {
              href: anchor.getAttribute('href'),
              height: rect.height,
              width: rect.width,
            };
          }),
        );
      for (const target of targets) {
        assert.ok(
          target.height >= 44 && target.width >= 44,
          `${width}px ${colorScheme}: ${target.href} is ${target.width}x${target.height}`,
        );
      }
      await context.close();
    }
  }
});
