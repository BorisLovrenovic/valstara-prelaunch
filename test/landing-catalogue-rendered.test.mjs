import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import axe from 'axe-core';

import { landingCopy } from '../src/copy/landing.ts';
import { providerShowcaseCopy } from '../src/copy/provider-showcase.ts';
import {
  bannerForeground,
  bannerShapes,
  bannerTone,
} from '../src/components/provider-banner.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { designWidths } from '../scripts/design/layout-checks.mjs';

// E11.5-11d: the #catalogue and #how sections from Main.dc.html,
// Tablet.dc.html, Phone.dc.html and the provider banner on
// Components.dc.html. Every number below is the frame's, with a 1px
// tolerance.

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-landing-catalogue-playwright-${process.pid}`;
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
// The catalogue order: v2 category order, then data-file order.
const catalogue = Object.entries(providerShowcaseCopy.categories).flatMap(
  ([token]) => showcase.filter((provider) => provider.category === token),
);
const groupLabels = Object.entries(providerShowcaseCopy.categories)
  .filter(([token]) => showcase.some((entry) => entry.category === token))
  .map(([, label]) => label);

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
    label: 'Landing catalogue test',
    env: () => ({
      ADMIN_CREDENTIAL: 'landing-catalogue-admin-credential-32',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL:
        'postgresql://unused:unused@127.0.0.1:5434/unused-catalogue',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'landing-catalogue-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'landing-catalogue-referral-secret',
      RESEND_API_KEY: 'landing-catalogue-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'landing-catalogue-turnstile-secret',
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

async function openLanding({ width, height = 900, colorScheme = 'light' }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme,
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.abort(),
  );
  const page = await context.newPage();
  await page.goto(browserOrigin);
  await page.evaluate(() => globalThis.document.fonts.ready);
  // Lazy logos load before measuring, so every chip has its final width.
  await page.evaluate(async () => {
    const images = [...globalThis.document.querySelectorAll('#catalogue img')];
    for (const image of images) image.loading = 'eager';
    await Promise.all(images.map((image) => image.decode().catch(() => {})));
  });
  return { context, page };
}

// Every box and style the assertions read, measured once per page.
function measure(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const box = (element) => {
      if (!element) return null;
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
    const css = (element, pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return {
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
        color: style.color,
        background: style.backgroundColor,
        borderRadius: style.borderTopLeftRadius,
        padding: [
          style.paddingTop,
          style.paddingRight,
          style.paddingBottom,
          style.paddingLeft,
        ].map(Number.parseFloat),
        boxShadow: style.boxShadow,
        display: style.display,
        gap: Number.parseFloat(style.columnGap),
        rowGap: Number.parseFloat(style.rowGap),
        gridColumns: style.gridTemplateColumns,
        borderTop: style.borderTopStyle,
        borderLeft: style.borderLeftStyle,
        borderLeftWidth: style.borderLeftWidth,
        borderColor: style.borderLeftColor,
        content: style.content,
        scrollSnapType: style.scrollSnapType,
        scrollSnapAlign: style.scrollSnapAlign,
        scrollbarWidth: style.scrollbarWidth,
        overflowX: style.overflowX,
        objectFit: style.objectFit,
      };
    };
    const probe = (value) => {
      const element = document.createElement('span');
      element.style.color = value;
      document.body.append(element);
      const resolved = getComputedStyle(element).color;
      element.remove();
      return resolved;
    };
    // Chromium snaps a 1.5px border to whole pixels, so the optional tile's
    // border is checked against the token as declared and as rendered.
    const border = document.createElement('span');
    border.style.borderTop = 'var(--border-check) solid';
    document.body.append(border);
    const borderCheck = {
      declared: getComputedStyle(document.documentElement)
        .getPropertyValue('--border-check')
        .trim(),
      rendered: getComputedStyle(border).borderTopWidth,
    };
    border.remove();
    const section = document.querySelector('#catalogue');
    const how = document.querySelector('#how');
    return {
      borderCheck,
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      tokens: Object.fromEntries(
        [
          'ink',
          'ink-600',
          'ink-300',
          'paper',
          'surface',
          'banner-white',
          'banner-ink',
        ].map((name) => [name, probe(`var(--${name})`)]),
      ),
      hero: box(document.querySelector('#join')),
      catalogue: {
        box: box(section),
        content: box(section.querySelector('.container__content')),
        heading: box(section.querySelector('h2')),
        headingStyle: css(section.querySelector('h2')),
        line: box(section.querySelector('.section__heading p')),
        lineStyle: css(section.querySelector('.section__heading p')),
        headingBlock: box(section.querySelector('.section__heading')),
        groups: [...section.querySelectorAll('.provider-rail__category')].map(
          (group) => {
            const label = group.querySelector('h3');
            const track = group.querySelector('.provider-rail__track');
            return {
              box: box(group),
              label: label.textContent.trim(),
              labelBox: box(label),
              labelStyle: css(label),
              track: box(track),
              trackStyle: css(track),
              trackScroll: [track.scrollWidth, track.clientWidth],
              trackAttributes: {
                tabindex: track.getAttribute('tabindex'),
                role: track.getAttribute('role'),
                label: track.getAttribute('aria-label'),
              },
              banners: [
                ...track.querySelectorAll('[data-provider-banner]'),
              ].map((banner) => {
                const chip = banner.querySelector('.provider-banner__logo');
                const name = banner.querySelector('.provider-banner__name');
                const image = chip.querySelector('img');
                const category = banner.querySelector(
                  '.provider-banner__category',
                );
                const tone = banner.querySelector('.provider-banner__tone');
                return {
                  name: banner.dataset.providerBanner,
                  box: box(banner),
                  style: css(banner),
                  snap: css(banner).scrollSnapAlign,
                  chip: box(chip),
                  chipStyle: css(chip),
                  chipScroll: [
                    chip.scrollWidth,
                    chip.clientWidth,
                    chip.scrollHeight,
                    chip.clientHeight,
                  ],
                  nameBox: box(name),
                  nameScroll: [name.scrollWidth, name.clientWidth],
                  nameHidden: name.getAttribute('aria-hidden'),
                  nameText: name.textContent.trim(),
                  image: {
                    box: box(image),
                    src: image.getAttribute('src'),
                    alt: image.getAttribute('alt'),
                    fit: css(image).objectFit,
                  },
                  gap: Number.parseFloat(getComputedStyle(chip).columnGap),
                  category: category.textContent.trim(),
                  categoryBox: box(category),
                  categoryStyle: css(category),
                  toneHidden: tone
                    .closest('[aria-hidden="true"]')
                    ?.contains(tone),
                  shape: [...tone.classList]
                    .find((name) => /^provider-banner__tone--t\d$/u.test(name))
                    ?.slice(-2),
                };
              }),
            };
          },
        ),
      },
      how: {
        box: box(how),
        heading: box(how.querySelector('h2')),
        headingBlock: box(how.querySelector('.section__heading')),
        list: box(how.querySelector('ol')),
        listStyle: css(how.querySelector('ol')),
        steps: [...how.querySelectorAll('ol > li')].map((step) => {
          const tile = step.querySelector('.landing-step__tile');
          const badge = step.querySelector('.landing-step__badge');
          const connector = step.querySelector('.landing-step__connector');
          const title = step.querySelector('.landing-step__title');
          return {
            box: box(step),
            style: css(step),
            tile: box(tile),
            tileStyle: css(tile),
            tileBorder: getComputedStyle(tile).borderTopStyle,
            tileBorderWidth: getComputedStyle(tile).borderTopWidth,
            tileBorderColor: getComputedStyle(tile).borderTopColor,
            tileColor: getComputedStyle(tile).color,
            tileHidden: tile.getAttribute('aria-hidden'),
            icon: box(tile.querySelector('svg')),
            badge: box(badge),
            badgeStyle: css(badge),
            badgeText: badge.textContent.trim(),
            connector: connector && {
              box: box(connector),
              style: css(connector),
              topStyle: getComputedStyle(connector).borderTopStyle,
              leftStyle: getComputedStyle(connector).borderLeftStyle,
              topWidth: getComputedStyle(connector).borderTopWidth,
              leftWidth: getComputedStyle(connector).borderLeftWidth,
              arrow: css(connector, '::after'),
              arrowBorder: getComputedStyle(connector, '::after')
                .borderLeftWidth,
              hidden: connector.getAttribute('aria-hidden'),
            },
            title: box(title),
            titleText: title.textContent.trim(),
            titleStyle: css(title),
          };
        }),
      },
    };
  });
}

const bannersOf = (catalogueMeasure) =>
  catalogueMeasure.groups.flatMap((group) => group.banners);

test('every banner uses its real logo, its data brand colour, its computed label colour and its chip tone, over the full data file', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await openLanding({ width: 1440, colorScheme });
    const result = await measure(page);
    const banners = bannersOf(result.catalogue);
    assert.deepEqual(
      banners.map((banner) => banner.name),
      catalogue.map((provider) => provider.name),
    );
    const rgb = (hex) => {
      const value = Number.parseInt(hex.slice(1), 16);
      return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
    };
    for (const [index, banner] of banners.entries()) {
      const provider = catalogue[index];
      const label = `${colorScheme} ${provider.name}`;
      assert.equal(banner.style.background, rgb(provider.brandColor), label);
      assert.equal(banner.image.src, provider.logo, label);
      assert.equal(banner.image.alt, provider.name, label);
      // The logo names the provider; the visible name is not read twice.
      assert.equal(banner.nameText, provider.name, label);
      assert.equal(banner.nameHidden, 'true', label);
      const foreground =
        bannerForeground(provider.brandColor) === 'white'
          ? result.tokens['banner-white']
          : result.tokens['banner-ink'];
      assert.equal(banner.categoryStyle.color, foreground, label);
      assert.equal(
        banner.category,
        providerShowcaseCopy.categories[provider.category],
        label,
      );
      // The chip stays light in dark mode; only chipTone "dark" inverts it.
      const dark = provider.chipTone === 'dark';
      assert.equal(
        banner.chipStyle.background,
        dark ? result.tokens['banner-ink'] : result.tokens['banner-white'],
        label,
      );
      assert.equal(
        banner.chipStyle.color,
        dark ? result.tokens['banner-white'] : result.tokens['banner-ink'],
        label,
      );
      // The tonal shape cycles t1 to t6 in catalogue order, hidden from
      // assistive technology.
      assert.equal(banner.shape, bannerShapes[index % 6], label);
      assert.equal(banner.toneHidden, true, label);
    }
    assert.deepEqual(
      banners
        .filter(
          (banner) =>
            banner.chipStyle.background === result.tokens['banner-ink'],
        )
        .map((banner) => banner.name),
      showcase
        .filter((provider) => provider.chipTone === 'dark')
        .map((provider) => provider.name),
    );
    // The tone selection itself is the shared function's (unit-tested), and
    // all three tones occur in the real data.
    assert.deepEqual(
      new Set(catalogue.map((provider) => bannerTone(provider.brandColor))),
      new Set(['dark', 'light', 'ink']),
    );
    await context.close();
  }
});

test('banner anatomy matches the component sheet at 1440, in both themes', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await openLanding({ width: 1440, colorScheme });
    const result = await measure(page);
    for (const banner of bannersOf(result.catalogue)) {
      const label = `${colorScheme} ${banner.name}`;
      near(banner.box.width, 227, `${label} width`);
      near(banner.box.height, 96, `${label} height`);
      assert.deepEqual(banner.style.padding, [16, 16, 16, 16], label);
      assert.equal(banner.style.borderRadius, '12px', label);
      // Shadow 1 at rest, plus the 1px light edge in dark.
      assert.match(banner.style.boxShadow, /6px 16px|8px 20px/u, label);
      if (colorScheme === 'dark')
        assert.match(
          banner.style.boxShadow,
          /rgba\(240, 240, 238, 0\.1\) 0px 0px 0px 1px inset/u,
          label,
        );
      near(banner.chip.height, 36, `${label} chip height`);
      near(banner.chip.top - banner.box.top, 16, `${label} chip top`);
      near(banner.chip.left - banner.box.left, 16, `${label} chip left`);
      assert.equal(banner.chipStyle.padding[1], 12, `${label} chip padding`);
      assert.equal(banner.chipStyle.padding[3], 12, `${label} chip padding`);
      assert.equal(banner.chipStyle.borderRadius, '8px', label);
      assert.equal(banner.chipStyle.fontSize, '14px', label);
      assert.equal(banner.chipStyle.lineHeight, '20px', label);
      assert.equal(banner.chipStyle.fontWeight, '600', label);
      assert.equal(banner.gap, 8, label);
      near(banner.image.box.height, 16, `${label} logo`);
      assert.equal(banner.categoryStyle.fontSize, '13px', label);
      assert.equal(banner.categoryStyle.lineHeight, '18px', label);
      assert.equal(banner.categoryStyle.fontWeight, '500', label);
      // The category label sits at the bottom, inside the padding.
      near(banner.box.bottom - banner.categoryBox.bottom, 16, `${label} label`);
    }
    // The chip shadow is --shadow-chip in light; the dark chip adds its light
    // ring in dark (--shadow-chip-dark).
    const shadowChip = await page.evaluate(() => {
      const element = globalThis.document.createElement('span');
      element.style.boxShadow = 'var(--shadow-chip)';
      globalThis.document.body.append(element);
      const resolved = globalThis.getComputedStyle(element).boxShadow;
      element.remove();
      return resolved;
    });
    const darkChips = bannersOf(result.catalogue).filter((banner) =>
      showcase.some(
        (provider) =>
          provider.name === banner.name && provider.chipTone === 'dark',
      ),
    );
    assert.ok(darkChips.length > 0, 'a dark chip is in the catalogue');
    for (const banner of darkChips) {
      const label = `${colorScheme} ${banner.name} chip shadow`;
      if (colorScheme === 'dark')
        assert.match(
          banner.chipStyle.boxShadow,
          /rgba\(240, 240, 238, 0\.18\) 0px 0px 0px 1px/u,
          label,
        );
      else assert.equal(banner.chipStyle.boxShadow, shadowChip, label);
    }
    // Shadow 2 on hover, plus the 0.14 light edge in dark.
    const hovered = page.locator('[data-provider-banner]').first();
    await hovered.hover();
    const hoverShadow = await hovered.evaluate(async (banner) => {
      await Promise.all(
        banner.getAnimations().map((animation) => animation.finished),
      );
      return globalThis.getComputedStyle(banner).boxShadow;
    });
    if (colorScheme === 'dark') {
      assert.match(hoverShadow, /20px 48px/u, 'dark hover shadow');
      assert.match(
        hoverShadow,
        /rgba\(240, 240, 238, 0\.14\) 0px 0px 0px 1px inset/u,
        'dark hover edge',
      );
    } else assert.match(hoverShadow, /18px 44px/u, 'light hover shadow');
    await context.close();
  }
});

test('the section frame and the catalogue grid match Main.dc.html at 1440, in both themes', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await openLanding({ width: 1440, colorScheme });
    const { catalogue: section, how, tokens } = await measure(page);
    // The H2 at 24/32 600 with -0.01em tracking, and the supporting line 8px
    // below it at 16/24 ink-600; 32px below the block.
    assert.equal(section.headingStyle.fontSize, '24px');
    assert.equal(section.headingStyle.lineHeight, '32px');
    assert.equal(section.headingStyle.fontWeight, '600');
    assert.equal(section.headingStyle.letterSpacing, '-0.24px');
    near(section.line.top - section.heading.bottom, 8, 'supporting line gap');
    assert.equal(section.lineStyle.fontSize, '16px');
    assert.equal(section.lineStyle.lineHeight, '24px');
    assert.equal(section.lineStyle.color, tokens['ink-600']);
    near(
      section.groups[0].labelBox.top - section.headingBlock.bottom,
      32,
      'block to the first group',
    );
    // The section gap of 80px above #how.
    near(how.box.top - section.box.bottom, 80, 'section gap');
    // One group per v2 category with providers, labelled 14/20 600 ink-600.
    assert.deepEqual(
      section.groups.map((group) => group.label),
      groupLabels,
    );
    for (const [index, group] of section.groups.entries()) {
      assert.equal(group.labelStyle.fontSize, '14px');
      assert.equal(group.labelStyle.lineHeight, '20px');
      assert.equal(group.labelStyle.fontWeight, '600');
      assert.equal(group.labelStyle.color, tokens['ink-600']);
      near(group.banners[0].box.top - group.labelBox.bottom, 12, 'label gap');
      if (index > 0)
        near(
          group.box.top - section.groups[index - 1].box.bottom,
          32,
          `${group.label} group gap`,
        );
      // Five equal columns, 16px apart, inside the 1200px container.
      assert.equal(group.trackStyle.display, 'grid');
      assert.equal(group.trackStyle.gap, 16);
      assert.equal(group.trackStyle.gridColumns.split(' ').length, 5);
      near(group.track.left, section.content.left, 'grid start');
      near(group.track.right, section.content.right, 'grid end');
      for (const [column, banner] of group.banners.slice(0, 5).entries())
        near(
          banner.box.left,
          section.content.left + column * (227 + 16),
          `${banner.name} column`,
        );
    }
    near(section.content.width, 1200, 'container');
    await context.close();
  }
});

test('the rails match Tablet.dc.html at 768 and Phone.dc.html at 390, in both themes', async () => {
  for (const [width, frame] of [
    [768, { gutter: 32, groupGap: 24, block: 32, sectionGap: 64 }],
    [390, { gutter: 16, groupGap: 20, block: 24, sectionGap: 64 }],
  ]) {
    for (const colorScheme of themes) {
      const { context, page } = await openLanding({ width, colorScheme });
      const result = await measure(page);
      const { catalogue: section, how } = result;
      const label = `${width} ${colorScheme}`;
      assert.equal(result.scrollWidth, result.viewport, `${label} overflow`);
      near(
        section.groups[0].labelBox.top - section.headingBlock.bottom,
        frame.block,
        `${label} block`,
      );
      near(how.box.top - section.box.bottom, frame.sectionGap, `${label} gap`);
      for (const [index, group] of section.groups.entries()) {
        const where = `${label} ${group.label}`;
        if (index > 0)
          near(
            group.box.top - section.groups[index - 1].box.bottom,
            frame.groupGap,
            `${where} group gap`,
          );
        // The label 8px above the rail, whose 4px top padding sets the first
        // banner 12px below it.
        near(group.track.top - group.labelBox.bottom, 8, `${where} label`);
        near(group.banners[0].box.top - group.labelBox.bottom, 12, where);
        assert.equal(group.trackStyle.display, 'flex', where);
        assert.equal(group.trackStyle.gap, 12, where);
        assert.equal(group.trackStyle.overflowX, 'auto', where);
        assert.equal(group.trackStyle.scrollSnapType, 'x mandatory', where);
        assert.equal(group.trackStyle.scrollbarWidth, 'none', where);
        // The rail starts at the content edge and bleeds to the viewport's
        // right edge.
        near(group.track.left, frame.gutter, `${where} rail start`);
        near(group.track.right, result.viewport, `${where} rail bleed`);
        for (const banner of group.banners) {
          near(banner.box.width, 224, `${where} ${banner.name} width`);
          near(banner.box.height, 96, `${where} ${banner.name} height`);
          assert.equal(banner.snap, 'start', where);
        }
        if (group.banners.length > 1)
          near(
            group.banners[1].box.left - group.banners[0].box.right,
            12,
            `${where} banner gap`,
          );
        // Wherever the group outruns the rail, the next banner peeks.
        const [scrollWidth, clientWidth] = group.trackScroll;
        if (scrollWidth > clientWidth) {
          const peeking = group.banners.find(
            (banner) =>
              banner.box.left < result.viewport &&
              banner.box.right > result.viewport,
          );
          assert.ok(peeking, `${where} the next banner peeks`);
        }
      }
      await context.close();
    }
  }
});

test('no chip text overflows or truncates at any test width, in both themes', async () => {
  for (const width of designWidths) {
    for (const colorScheme of themes) {
      const { context, page } = await openLanding({ width, colorScheme });
      const result = await measure(page);
      for (const banner of bannersOf(result.catalogue)) {
        const label = `${width} ${colorScheme} ${banner.name}`;
        const [scrollWidth, clientWidth, scrollHeight, clientHeight] =
          banner.chipScroll;
        assert.ok(scrollWidth <= clientWidth + 1, `${label} chip width`);
        assert.ok(scrollHeight <= clientHeight + 1, `${label} chip height`);
        const [nameScroll, nameClient] = banner.nameScroll;
        assert.ok(nameScroll <= nameClient + 1, `${label} name`);
        // The chip and the label stay inside the banner's padding.
        assert.ok(
          banner.chip.right <= banner.box.right - 16 + 1,
          `${label} chip right`,
        );
        assert.ok(
          banner.nameBox.right <= banner.chip.right + 1,
          `${label} name right`,
        );
        assert.ok(
          banner.categoryBox.bottom <= banner.box.bottom - 16 + 1,
          `${label} category`,
        );
        assert.ok(
          banner.chip.bottom <= banner.categoryBox.top + 1,
          `${label} chip above category`,
        );
        // The logo is never squeezed out: at least 16px wide, scaled whole.
        assert.ok(banner.image.box.width >= 16 - 1, `${label} logo`);
        assert.equal(banner.image.fit, 'contain', label);
        if (width >= 1280)
          near(banner.chip.height, 36, `${label} one-line chip`);
      }
      await context.close();
    }
  }
});

test('between 64rem and 80rem a chip takes the compact two-line style', async () => {
  const { context, page } = await openLanding({ width: 1024 });
  const result = await measure(page);
  for (const banner of bannersOf(result.catalogue)) {
    assert.equal(banner.chipStyle.fontSize, '13px', banner.name);
    assert.equal(banner.chipStyle.lineHeight, '18px', banner.name);
    assert.deepEqual(banner.chipStyle.padding, [6, 10, 6, 10], banner.name);
    assert.ok(banner.chip.height >= 32 - 1, banner.name);
  }
  // A long name wraps inside its chip rather than overflow.
  const adobe = bannersOf(result.catalogue).find(
    (banner) => banner.name === 'Adobe Creative Cloud',
  );
  assert.ok(adobe.nameBox.height > 18 + 1, 'Adobe Creative Cloud wraps');
  await context.close();
});

test('each rail scrolls by keyboard, is labelled with its category, and ships no script of its own', async () => {
  const { context, page } = await openLanding({ width: 390 });
  const result = await measure(page);
  for (const group of result.catalogue.groups)
    assert.deepEqual(group.trackAttributes, {
      tabindex: '0',
      role: 'region',
      label: group.label,
    });
  const tree = await page.locator('#catalogue').ariaSnapshot();
  for (const name of groupLabels)
    assert.ok(tree.includes(`region "${name}"`), `${name} region`);
  const track = page.locator('#catalogue .provider-rail__track').nth(1);
  await track.focus();
  const before = await track.evaluate((element) => element.scrollLeft);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(
    (start) =>
      globalThis.document.querySelectorAll(
        '#catalogue .provider-rail__track',
      )[1].scrollLeft > start,
    before,
  );
  // No script lives in the catalogue, and nothing advances on its own.
  assert.equal(await page.locator('#catalogue script').count(), 0);
  // Once the keyboard scroll and its snap settle, it stays put.
  let settled = await track.evaluate((element) => element.scrollLeft);
  for (let read = 0; read < 20; read += 1) {
    await page.waitForTimeout(150);
    const now = await track.evaluate((element) => element.scrollLeft);
    if (now === settled) break;
    settled = now;
  }
  assert.ok(settled > before, 'the rail moved');
  await page.waitForTimeout(400);
  assert.equal(await track.evaluate((element) => element.scrollLeft), settled);
  await context.close();
});

test('"How it works" matches the frames at 1440, 768 and 390, in both themes', async () => {
  for (const width of [1440, 768, 390]) {
    for (const colorScheme of themes) {
      const { context, page } = await openLanding({ width, colorScheme });
      const { how, tokens, borderCheck } = await measure(page);
      assert.equal(borderCheck.declared, '1.5px');
      const label = `${width} ${colorScheme}`;
      const small = width < 768;
      assert.deepEqual(
        how.steps.map((step) => step.titleText),
        landingCopy.how.steps,
      );
      assert.equal(how.steps.length, 3);
      near(
        how.list.top - how.headingBlock.bottom,
        small ? 24 : 32,
        `${label} block`,
      );
      if (small) {
        // 28px apart: each step's bottom padding holds its connector.
        for (const index of [1, 2])
          near(
            how.steps[index].tile.top - how.steps[index - 1].tile.bottom,
            28,
            `${label} step gap`,
          );
        for (const step of how.steps)
          near(step.box.left, how.list.left, `${label} one column`);
      } else {
        assert.equal(how.listStyle.gridColumns.split(' ').length, 3, label);
        assert.equal(how.listStyle.gap, 24, label);
        near(how.steps[1].box.left - how.steps[0].box.right, 24, label);
        near(how.steps[0].box.width, how.steps[2].box.width, `${label} equal`);
      }
      for (const [index, step] of how.steps.entries()) {
        const where = `${label} step ${index + 1}`;
        const optional = index === 2;
        // The 56px tile, radius 12, its 24px icon and the badge at -10/-10.
        near(step.tile.width, 56, where);
        near(step.tile.height, 56, where);
        near(step.tile.left, step.box.left, `${where} tile left`);
        assert.equal(step.tileStyle.borderRadius, '12px', where);
        assert.equal(step.tileHidden, 'true', where);
        near(step.icon.width, 24, `${where} icon`);
        near(step.badge.width, 24, `${where} badge`);
        near(step.badge.height, 24, `${where} badge`);
        near(step.badge.left - step.tile.left, -10, `${where} badge left`);
        near(step.badge.top - step.tile.top, -10, `${where} badge top`);
        assert.equal(step.badgeText, String(index + 1), where);
        assert.equal(step.badgeStyle.fontSize, '13px', where);
        assert.equal(step.badgeStyle.color, tokens.paper, where);
        if (optional) {
          // Drawn as optional: paper tile, 1.5px dashed ink-300, no shadow,
          // ink-600 icon, badge and title.
          assert.equal(step.tileStyle.background, tokens.paper, where);
          assert.equal(step.tileBorder, 'dashed', where);
          assert.equal(step.tileBorderWidth, borderCheck.rendered, where);
          assert.equal(step.tileBorderColor, tokens['ink-300'], where);
          assert.equal(step.tileStyle.boxShadow, 'none', where);
          assert.equal(step.tileColor, tokens['ink-600'], where);
          assert.equal(step.badgeStyle.background, tokens['ink-600'], where);
          assert.equal(step.titleStyle.color, tokens['ink-600'], where);
          assert.equal(step.connector, null, `${where} has no connector`);
        } else {
          assert.equal(step.tileStyle.background, tokens.surface, where);
          assert.match(step.tileStyle.boxShadow, /6px 16px|8px 20px/u, where);
          assert.equal(step.tileColor, tokens.ink, where);
          assert.equal(step.badgeStyle.background, tokens.ink, where);
          assert.equal(step.titleStyle.color, tokens.ink, where);
        }
        assert.equal(step.titleStyle.fontWeight, '600', where);
        assert.equal(
          step.titleStyle.letterSpacing,
          small ? '-0.16px' : '-0.2px',
          where,
        );
        if (small) {
          assert.equal(step.titleStyle.fontSize, '16px', where);
          assert.equal(step.titleStyle.lineHeight, '24px', where);
          // A row: the title centred beside the tile, 16px from it.
          near(step.title.left - step.tile.right, 16, `${where} title gap`);
          near(
            step.title.top + step.title.height / 2,
            step.tile.top + 28,
            `${where} title centred`,
          );
        } else {
          assert.equal(step.titleStyle.fontSize, '20px', where);
          assert.equal(step.titleStyle.lineHeight, '28px', where);
          near(step.title.top - step.tile.bottom, 16, `${where} title gap`);
        }
        if (step.connector === null) continue;
        const connector = step.connector;
        const dashed = index === 1;
        assert.equal(connector.hidden, 'true', where);
        if (small) {
          // Vertical, 2 × 24, 27px from the left and 60px from the top, no
          // arrowhead.
          near(connector.box.left - step.box.left, 27, `${where} connector x`);
          near(connector.box.top - step.box.top, 60, `${where} connector y`);
          near(connector.box.width, 2, `${where} connector width`);
          near(connector.box.height, 24, `${where} connector height`);
          assert.equal(connector.arrow.content, 'none', where);
          assert.equal(connector.leftStyle, dashed ? 'dashed' : 'none', where);
          if (dashed) assert.equal(connector.leftWidth, '2px', where);
          else
            assert.equal(connector.style.background, tokens['ink-300'], where);
          // It reaches the next step's tile.
          near(connector.box.bottom, how.steps[index + 1].box.top, where);
        } else {
          // Horizontal, 2px, 27px from the top, from 72px right of the tile's
          // left edge to 8px short of the column's end, with an arrowhead.
          near(connector.box.top - step.box.top, 27, `${where} connector y`);
          near(connector.box.left - step.tile.left, 72, `${where} start`);
          near(step.box.right - connector.box.right, 8, `${where} end`);
          near(connector.box.height, 2, `${where} connector height`);
          assert.notEqual(connector.arrow.content, 'none', where);
          assert.equal(connector.arrowBorder, '7px', where);
          assert.equal(connector.arrow.borderColor, tokens['ink-300'], where);
          assert.equal(connector.topStyle, dashed ? 'dashed' : 'none', where);
          if (dashed) assert.equal(connector.topWidth, '2px', where);
          else
            assert.equal(connector.style.background, tokens['ink-300'], where);
        }
      }
      await context.close();
    }
  }
});

test('the catalogue and "How it works" pass WCAG axe in both themes', async () => {
  for (const colorScheme of themes) {
    for (const width of [1440, 390]) {
      const { context, page } = await openLanding({ width, colorScheme });
      await page.addScriptTag({ content: axe.source });
      for (const selector of ['#catalogue', '#how']) {
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
