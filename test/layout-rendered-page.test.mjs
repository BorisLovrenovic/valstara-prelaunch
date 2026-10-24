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
  assert.equal(await page.locator('main').getAttribute('id'), 'main-content');

  // The very first Tab lands on the skip link, and it points at the main.
  await page.keyboard.press('Tab');
  const skipLink = page.locator('a.skip-link');
  assert.equal(
    await skipLink.evaluate((element) => element.matches(':focus')),
    true,
    'the skip link is the first focusable element',
  );
  assert.equal(await skipLink.getAttribute('href'), '#main-content');

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
  assert.equal(new URL(page.url()).hash, '#main-content');

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
          ...(width >= 640
            ? sectionLinks.map((link, index) => ({
                ...link,
                name: ['How it works', 'What you get', 'Guarantee', 'FAQ'][
                  index
                ],
              }))
            : []),
          { href: `${prefix}#join`, name: 'Join the waitlist', tag: 'A' },
          { href: null, name: 'Use dark theme', tag: 'BUTTON' },
        ];
        if (colorScheme === 'dark') expected.at(-1).name = 'Use light theme';
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
