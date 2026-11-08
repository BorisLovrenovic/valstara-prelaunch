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
import { providerShowcaseCopy } from '../src/copy/provider-showcase.ts';
import {
  bannerForeground,
  bannerShapes,
  bannerTone,
} from '../src/components/provider-banner.ts';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { designWidths } from '../scripts/design/layout-checks.mjs';
import { entranceEnded, transitionsEnded } from './helpers/motion.mjs';

// E11.5-11n: the #catalogue and #how sections from the final-design canvas
// (Main.dc.html and its 1024, 768, 390 and 320 frames, light and dark, and
// the provider banner on Components.dc.html), with the motion and finish the
// ticket adds. Geometry is compared box by box with the canvas, measured from
// the pinned snapshot by test/fixtures/final-ui/measure-catalogue-geometry.mjs, at
// rest and with a 1px tolerance (final-design rule 7).

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
const canvas = JSON.parse(
  await readFile(
    new URL('./fixtures/final-ui/catalogue-geometry.json', import.meta.url),
    'utf8',
  ),
);
const canvasWidths = [1440, 1024, 768, 390, 320];
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

// Geometry is read at rest: in a reduced-motion context, which by design
// rule 12 is the at-rest layout (E11.5-11i). Motion tests open with motion
// allowed and wait for the hero's entrance to end.
async function openLanding({
  width,
  height = 900,
  colorScheme = 'light',
  motion = false,
}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme,
    reducedMotion: motion ? 'no-preference' : 'reduce',
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
  if (motion) await entranceEnded(page);
  return { context, page };
}

// The built page in the canvas fixture's shape: boxes relative to each
// section's heading block (banner parts relative to their banner), plus the
// styles the assertions read.
function measure(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const relative = (element, from) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return [
        rect.left - from.left,
        rect.top - from.top,
        rect.width,
        rect.height,
      ];
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
        gridColumns: style.gridTemplateColumns,
        borderStyle: style.borderTopStyle,
        borderWidth: style.borderTopWidth,
        borderColor: style.borderTopColor,
        scrollSnapType: style.scrollSnapType,
        scrollSnapAlign: style.scrollSnapAlign,
        scrollbarWidth: style.scrollbarWidth,
        scrollBehavior: style.scrollBehavior,
        overflowX: style.overflowX,
        objectFit: style.objectFit,
        stroke: style.stroke,
        fill: style.fill,
        strokeWidth: style.strokeWidth,
        strokeDasharray: style.strokeDasharray,
      };
    };
    const probe = (value, property = 'color') => {
      const element = document.createElement('span');
      element.style[property] = value;
      document.body.append(element);
      const resolved = getComputedStyle(element)[property];
      element.remove();
      return resolved;
    };
    const section = document.querySelector('#catalogue');
    const how = document.querySelector('#how');
    const catalogueHead = section
      .querySelector('.section__heading')
      .getBoundingClientRect();
    const howHead = how
      .querySelector('.section__heading')
      .getBoundingClientRect();
    return {
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      tokens: {
        ...Object.fromEntries(
          [
            'ink',
            'ink-600',
            'ink-300',
            'paper',
            'surface',
            'well',
            'banner-white',
            'banner-ink',
            'banner-tone-dark',
            'banner-tone-light',
            'banner-tone-ink',
            'banner-ring-dark',
            'banner-ring-ink',
          ].map((name) => [name, probe(`var(--${name})`)]),
        ),
        shadowChip: probe('var(--shadow-chip)', 'boxShadow'),
        borderCheck: (() => {
          const element = document.createElement('span');
          element.style.borderTop = 'var(--border-check) solid';
          document.body.append(element);
          const width = getComputedStyle(element).borderTopWidth;
          element.remove();
          return width;
        })(),
        insetLine: probe('var(--inset-line)', 'boxShadow'),
        ringBadge: probe('var(--ring-badge)', 'boxShadow'),
        panelShadow: probe('var(--shadow-1), var(--edge)', 'boxShadow'),
        restShadow: probe('var(--shadow-1), var(--banner-edge)', 'boxShadow'),
      },
      catalogue: {
        sectionEnd: section.getBoundingClientRect().bottom - catalogueHead.top,
        head: relative(
          section.querySelector('.section__heading'),
          catalogueHead,
        ),
        heading: relative(section.querySelector('h2'), catalogueHead),
        headingStyle: css(section.querySelector('h2')),
        line: relative(
          section.querySelector('.section__heading p'),
          catalogueHead,
        ),
        lineStyle: css(section.querySelector('.section__heading p')),
        groups: [...section.querySelectorAll('.provider-rail__category')].map(
          (group) => {
            const label = group.querySelector('h3');
            const track = group.querySelector('.provider-rail__track');
            return {
              box: relative(group, catalogueHead),
              label: label.textContent.trim(),
              labelBox: relative(label, catalogueHead),
              labelStyle: css(label),
              rail: relative(track, catalogueHead),
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
                const own = banner.getBoundingClientRect();
                const chip = banner.querySelector('.provider-banner__logo');
                const name = banner.querySelector('.provider-banner__name');
                const image = chip.querySelector('img');
                const category = banner.querySelector(
                  '.provider-banner__category',
                );
                const tone = banner.querySelector('.provider-banner__tone');
                const ring = banner.querySelector('.provider-banner__ring');
                return {
                  name: banner.dataset.providerBanner,
                  box: relative(banner, catalogueHead),
                  page: [own.left, own.right],
                  style: css(banner),
                  chip: relative(chip, own),
                  chipStyle: css(chip),
                  chipScroll: [
                    chip.scrollWidth,
                    chip.clientWidth,
                    chip.scrollHeight,
                    chip.clientHeight,
                  ],
                  logo: relative(image, own),
                  wordmark: image.classList.contains(
                    'provider-banner__wordmark',
                  ),
                  label: relative(name, own),
                  nameScroll: name && [name.scrollWidth, name.clientWidth],
                  nameHidden: name?.getAttribute('aria-hidden') ?? null,
                  nameText: name?.textContent.trim() ?? null,
                  chipText: chip.textContent.trim(),
                  image: {
                    src: image.getAttribute('src'),
                    alt: image.getAttribute('alt'),
                    fit: getComputedStyle(image).objectFit,
                  },
                  category: category.textContent.trim(),
                  categoryBox: relative(category, own),
                  categoryStyle: css(category),
                  shape: relative(tone, own),
                  ring: relative(ring, own),
                  toneBackground: getComputedStyle(tone).backgroundColor,
                  ringStyle: css(ring),
                  shapeName: [...tone.classList]
                    .find((name) => /^provider-banner__tone--t\d$/u.test(name))
                    ?.slice(-2),
                  ringName: [...ring.classList]
                    .find((name) => /^provider-banner__ring--t\d$/u.test(name))
                    ?.slice(-2),
                  layersHidden:
                    tone.closest('[aria-hidden="true"]')?.contains(ring) ===
                    true,
                };
              }),
            };
          },
        ),
      },
      how: {
        head: relative(how.querySelector('.section__heading'), howHead),
        panel: relative(how.querySelector('.landing-steps-panel'), howHead),
        panelStyle: css(how.querySelector('.landing-steps-panel')),
        list: relative(how.querySelector('ol'), howHead),
        listStyle: css(how.querySelector('ol')),
        steps: [...how.querySelectorAll('ol > li')].map((step) => {
          const tile = step.querySelector('.landing-step__tile');
          const badge = step.querySelector('.landing-step__badge');
          const title = step.querySelector('.landing-step__title');
          // A step's connector is drawn inside the step it leads into, so
          // it never overflows the step it leaves; it is read as the
          // leaving step's, as the canvas draws it.
          const next = step.nextElementSibling;
          const visible = [
            ...(next?.querySelectorAll('.landing-step__connector') ?? []),
          ].filter((svg) => getComputedStyle(svg).display !== 'none');
          const connector = visible[0];
          const line = connector?.querySelector('.landing-step__line');
          const head = connector?.querySelector('.landing-step__head polygon');
          return {
            box: relative(step, howHead),
            style: css(step),
            tile: relative(tile, howHead),
            tileStyle: css(tile),
            tileHidden: tile.getAttribute('aria-hidden'),
            icon: relative(tile.querySelector('svg'), howHead),
            badge: relative(badge, howHead),
            badgeStyle: css(badge),
            badgeText: badge.textContent.trim(),
            title: relative(title, howHead),
            titleText: title.textContent.trim(),
            titleStyle: css(title),
            connectors: visible.length,
            connector: connector && {
              kind: connector.classList.contains(
                'landing-step__connector--across',
              )
                ? 'across'
                : 'down',
              dashed: connector.classList.contains(
                'landing-step__connector--dashed',
              ),
              box: relative(connector, howHead),
              hidden: connector.getAttribute('aria-hidden'),
              line: css(line),
              head: head && {
                box: relative(head, howHead),
                fill: getComputedStyle(head).fill,
              },
            },
          };
        }),
      },
    };
  });
}

const bannersOf = (catalogueMeasure) =>
  catalogueMeasure.groups.flatMap((group) => group.banners);

function nearBox(actual, expected, label) {
  assert.ok(actual && expected, `${label}: ${actual} against ${expected}`);
  for (const [index, side] of ['x', 'y', 'width', 'height'].entries())
    near(actual[index], expected[index], `${label} ${side}`);
}

test('every banner uses its real logo, its data brand colour, its computed label colour, its chip tone and the canvas tonal system, over the full data file', async () => {
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
      // Founder decision 2026-11-08: a wordmark shows alone at its data
      // height; an icon mark sits 20px tall beside the name, which is not
      // read twice.
      if (provider.wordmarkHeight === undefined) {
        assert.equal(banner.wordmark, false, label);
        assert.equal(banner.nameText, provider.name, label);
        assert.equal(banner.nameHidden, 'true', label);
        near(banner.logo[3], 20, `${label} icon height`);
      } else {
        assert.equal(banner.wordmark, true, label);
        assert.equal(banner.nameText, null, `${label} has no visible name`);
        assert.equal(banner.chipText, '', `${label} shows the logo alone`);
        near(
          banner.logo[3],
          Math.min(provider.wordmarkHeight, 36),
          `${label} wordmark height`,
        );
      }
      const white = bannerForeground(provider.brandColor) === 'white';
      assert.equal(
        banner.categoryStyle.color,
        white ? result.tokens['banner-white'] : result.tokens['banner-ink'],
        label,
      );
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
      // Two tonal layers: the shape, in the token its brand colour selects,
      // and the ring, white under white text and ink under ink, both in the
      // composition the catalogue cycles t1 to t6 in order (founder decision
      // 2026-11-08: the canvas cycle, no per-brand override), and hidden
      // from assistive technology.
      assert.equal(
        banner.toneBackground,
        result.tokens[`banner-tone-${bannerTone(provider.brandColor)}`],
        label,
      );
      assert.equal(
        banner.ringStyle.borderColor,
        white
          ? result.tokens['banner-ring-dark']
          : result.tokens['banner-ring-ink'],
        label,
      );
      assert.equal(banner.ringStyle.borderStyle, 'solid', label);
      assert.equal(banner.shapeName, bannerShapes[index % 6], label);
      assert.equal(banner.ringName, bannerShapes[index % 6], label);
      assert.equal(banner.layersHidden, true, label);
    }
    // 18 wordmarks and 16 icon marks, as the data file marks them.
    assert.equal(banners.filter((banner) => banner.wordmark).length, 18);
    assert.equal(banners.filter((banner) => !banner.wordmark).length, 16);
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
    assert.deepEqual(
      new Set(catalogue.map((provider) => bannerTone(provider.brandColor))),
      new Set(['dark', 'light', 'ink']),
    );
    await context.close();
  }
});

test('catalogue and step geometry matches the canvas at 1440, 1024, 768, 390 and 320, in both themes, at rest', async () => {
  assert.deepEqual(
    Object.keys(canvas.widths)
      .map(Number)
      .sort((a, b) => b - a),
    canvasWidths,
  );
  for (const width of canvasWidths) {
    const frame = canvas.widths[width];
    for (const colorScheme of themes) {
      const { context, page } = await openLanding({ width, colorScheme });
      const result = await measure(page);
      const label = `${width} ${colorScheme}`;
      assert.equal(result.scrollWidth, result.viewport, `${label} overflow`);
      const built = result.catalogue;
      nearBox(built.head, frame.catalogue.head, `${label} heading block`);
      nearBox(built.heading, frame.catalogue.heading, `${label} H2`);
      nearBox(built.line, frame.catalogue.line, `${label} supporting line`);
      near(
        built.sectionEnd,
        frame.catalogue.sectionEnd,
        `${label} section end`,
      );
      assert.equal(built.groups.length, frame.catalogue.groups.length);
      for (const [index, group] of built.groups.entries()) {
        const drawn = frame.catalogue.groups[index];
        const where = `${label} ${group.label}`;
        // The group's box, except its width: the build bleeds the whole
        // catalogue into the right gutter and the canvas bleeds each rail, so
        // below 64rem the built group is one gutter wider. The rail itself,
        // the box that bleeds, is compared whole below.
        nearBox(
          [group.box[0], group.box[1], drawn.box[2], group.box[3]],
          drawn.box,
          `${where} group`,
        );
        // The label spans its group, so its width follows the group's.
        nearBox(
          [
            group.labelBox[0],
            group.labelBox[1],
            drawn.label[2],
            group.labelBox[3],
          ],
          drawn.label,
          `${where} label`,
        );
        nearBox(group.rail, drawn.rail, `${where} rail`);
        assert.deepEqual(
          group.banners.map((banner) => banner.name),
          drawn.banners.map((banner) => banner.name),
          where,
        );
        for (const [position, banner] of group.banners.entries()) {
          const target = drawn.banners[position];
          const at = `${where} ${banner.name}`;
          nearBox(banner.box, target.box, `${at} banner`);
          nearBox(banner.chip, target.chip, `${at} chip`);
          nearBox(banner.logo, target.logo, `${at} logo`);
          if (target.label === null)
            assert.equal(banner.label, null, `${at} name`);
          else nearBox(banner.label, target.label, `${at} name`);
          nearBox(banner.categoryBox, target.category, `${at} category`);
          nearBox(banner.shape, target.shape, `${at} tonal shape`);
          nearBox(banner.ring, target.ring, `${at} ring`);
        }
      }
      // "How it works": the panel, the list, each step's tile, badge and
      // title, and its connector. The canvas draws a connector as a 2px CSS
      // line with a 7 × 12 arrowhead whose tip is 2px past its end; the build
      // draws it in SVG, so across it boxes the line and the arrowhead (5px
      // above the line, 12px tall, to the tip), and down it is the line.
      const how = result.how;
      nearBox(how.head, frame.how.head, `${label} how heading block`);
      nearBox(how.panel, frame.how.panel, `${label} panel`);
      nearBox(how.list, frame.how.list, `${label} steps`);
      for (const [index, step] of how.steps.entries()) {
        const drawn = frame.how.steps[index];
        const where = `${label} step ${index + 1}`;
        nearBox(step.box, drawn.box, `${where} box`);
        nearBox(step.tile, drawn.tile, `${where} tile`);
        nearBox(step.badge, drawn.badge, `${where} badge`);
        nearBox(step.title, drawn.title, `${where} title`);
        if (drawn.connector === null) {
          assert.equal(step.connectors, 0, `${where} has no connector`);
          continue;
        }
        assert.equal(step.connectors, 1, `${where} one connector`);
        const [x, y, w, h] = drawn.connector;
        if (width >= 768) {
          assert.equal(step.connector.kind, 'across', where);
          nearBox(step.connector.box, [x, y - 5, w + 2, 12], `${where} line`);
          nearBox(
            step.connector.head.box,
            [x + w - 5, y - 5, 7, 12],
            `${where} arrowhead`,
          );
        } else {
          assert.equal(step.connector.kind, 'down', where);
          assert.equal(step.connector.head, null, `${where} no arrowhead`);
          nearBox(step.connector.box, [x, y, w, h], `${where} line`);
        }
      }
      await context.close();
    }
  }
});

test('the section frame, banner and step styles match the canvas, in both themes', async () => {
  for (const width of [1440, 1024, 768, 390]) {
    for (const colorScheme of themes) {
      const { context, page } = await openLanding({ width, colorScheme });
      const { catalogue: section, how, tokens } = await measure(page);
      const label = `${width} ${colorScheme}`;
      const small = width < 768;
      // The H2 at 24/32 600 with -0.01em tracking; the supporting line 16/24
      // ink-600; the heading block at most 40rem.
      assert.equal(section.headingStyle.fontSize, '24px', label);
      assert.equal(section.headingStyle.lineHeight, '32px', label);
      assert.equal(section.headingStyle.fontWeight, '600', label);
      assert.equal(section.headingStyle.letterSpacing, '-0.24px', label);
      assert.equal(section.lineStyle.color, tokens['ink-600'], label);
      assert.ok(section.head[2] <= 640 + tolerance, `${label} block width`);
      assert.deepEqual(
        section.groups.map((group) => group.label),
        groupLabels,
      );
      for (const group of section.groups) {
        const where = `${label} ${group.label}`;
        assert.equal(group.labelStyle.fontSize, '14px', where);
        assert.equal(group.labelStyle.lineHeight, '20px', where);
        assert.equal(group.labelStyle.fontWeight, '600', where);
        assert.equal(group.labelStyle.color, tokens['ink-600'], where);
        if (width >= 1024) {
          assert.equal(group.trackStyle.display, 'grid', where);
          assert.equal(group.trackStyle.gap, 16, where);
          assert.equal(group.trackStyle.gridColumns.split(' ').length, 5);
        } else {
          assert.equal(group.trackStyle.display, 'flex', where);
          assert.equal(group.trackStyle.gap, 12, where);
          assert.equal(group.trackStyle.overflowX, 'auto', where);
          assert.equal(group.trackStyle.scrollSnapType, 'x mandatory', where);
          assert.equal(group.trackStyle.scrollbarWidth, 'none', where);
          // Native scroll-snap, never animated.
          assert.equal(group.trackStyle.scrollBehavior, 'auto', where);
          assert.deepEqual(
            group.trackStyle.padding.slice(0, 3),
            [4, small ? 16 : 32, 16],
            where,
          );
        }
        for (const banner of group.banners) {
          const at = `${where} ${banner.name}`;
          assert.deepEqual(banner.style.padding, [14, 14, 14, 14], at);
          assert.equal(banner.style.borderRadius, '12px', at);
          assert.equal(banner.style.boxShadow, tokens.restShadow, at);
          if (width < 1024)
            assert.equal(banner.style.scrollSnapAlign, 'start', at);
          assert.equal(banner.chipStyle.borderRadius, '8px', at);
          assert.equal(banner.chipStyle.fontWeight, '600', at);
          const compact = width >= 1024 && width < 1280;
          assert.equal(
            banner.chipStyle.fontSize,
            compact ? '13px' : '14px',
            at,
          );
          assert.deepEqual(
            banner.chipStyle.padding,
            compact ? [6, 8, 6, 8] : [0, 12, 0, 12],
            at,
          );
          assert.equal(banner.chipStyle.gap, 6, at);
          if (banner.chipStyle.background === tokens['banner-white'])
            assert.equal(banner.chipStyle.boxShadow, tokens.shadowChip, at);
          assert.equal(banner.categoryStyle.fontSize, '13px', at);
          assert.equal(banner.categoryStyle.lineHeight, '18px', at);
          assert.equal(banner.categoryStyle.fontWeight, '500', at);
          // --border-check, as Chromium renders 1.5px (snapped to whole
          // pixels), as the canvas's 1.5px ring renders.
          assert.equal(banner.ringStyle.borderWidth, tokens.borderCheck, at);
        }
      }
      // The steps panel, the well tile and the optional step.
      assert.equal(how.panelStyle.background, tokens.surface, label);
      assert.equal(how.panelStyle.boxShadow, tokens.panelShadow, label);
      assert.equal(how.panelStyle.borderRadius, '12px', label);
      for (const [index, step] of how.steps.entries()) {
        const where = `${label} step ${index + 1}`;
        const optional = index === 2;
        assert.equal(step.titleText, landingCopy.how.steps[index], where);
        assert.equal(step.tileHidden, 'true', where);
        assert.equal(step.tileStyle.borderRadius, '12px', where);
        near(step.icon[2], 24, `${where} icon`);
        assert.equal(step.badgeText, String(index + 1), where);
        assert.equal(step.badgeStyle.fontSize, '13px', where);
        assert.equal(step.badgeStyle.color, tokens.paper, where);
        assert.equal(step.badgeStyle.boxShadow, tokens.ringBadge, where);
        assert.equal(step.titleStyle.fontWeight, '600', where);
        assert.equal(step.titleStyle.fontSize, small ? '16px' : '20px', where);
        assert.equal(
          step.titleStyle.lineHeight,
          small ? '24px' : '28px',
          where,
        );
        assert.equal(
          step.titleStyle.letterSpacing,
          small ? 'normal' : '-0.2px',
          where,
        );
        if (optional) {
          assert.equal(step.tileStyle.background, 'rgba(0, 0, 0, 0)', where);
          assert.equal(step.tileStyle.borderStyle, 'dashed', where);
          assert.equal(step.tileStyle.borderColor, tokens['ink-300'], where);
          assert.equal(step.tileStyle.boxShadow, 'none', where);
          assert.equal(step.tileStyle.color, tokens['ink-600'], where);
          assert.equal(step.badgeStyle.background, tokens['ink-600'], where);
          assert.equal(step.titleStyle.color, tokens['ink-600'], where);
        } else {
          assert.equal(step.tileStyle.background, tokens.well, where);
          assert.equal(step.tileStyle.boxShadow, tokens.insetLine, where);
          assert.equal(step.tileStyle.color, tokens.ink, where);
          assert.equal(step.badgeStyle.background, tokens.ink, where);
          assert.equal(step.titleStyle.color, tokens.ink, where);
          const { connector } = step;
          assert.equal(connector.hidden, 'true', where);
          assert.equal(connector.dashed, index === 1, where);
          assert.equal(connector.line.stroke, tokens['ink-300'], where);
          assert.equal(connector.line.strokeWidth, '2px', where);
          assert.equal(
            connector.line.strokeDasharray,
            index === 1 ? '6px, 6px' : 'none',
            where,
          );
          if (connector.head)
            assert.equal(connector.head.fill, tokens['ink-300'], where);
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
      assert.equal(result.scrollWidth, result.viewport, `${width} overflow`);
      for (const banner of bannersOf(result.catalogue)) {
        const label = `${width} ${colorScheme} ${banner.name}`;
        const [scrollWidth, clientWidth, scrollHeight, clientHeight] =
          banner.chipScroll;
        assert.ok(scrollWidth <= clientWidth + 1, `${label} chip width`);
        assert.ok(scrollHeight <= clientHeight + 1, `${label} chip height`);
        if (banner.nameScroll) {
          const [nameScroll, nameClient] = banner.nameScroll;
          assert.ok(nameScroll <= nameClient + 1, `${label} name`);
          assert.ok(
            banner.label[0] + banner.label[2] <=
              banner.chip[0] + banner.chip[2] + 1,
            `${label} name inside the chip`,
          );
        }
        // The chip, its logo and the label stay inside the banner's padding;
        // the chip sits above the label.
        const bannerWidth = banner.box[2];
        const bannerHeight = banner.box[3];
        assert.ok(
          banner.chip[0] + banner.chip[2] <= bannerWidth - 14 + 1,
          `${label} chip right`,
        );
        assert.ok(
          banner.logo[0] + banner.logo[2] <=
            banner.chip[0] + banner.chip[2] + 1,
          `${label} logo inside the chip`,
        );
        assert.ok(
          banner.categoryBox[1] + banner.categoryBox[3] <=
            bannerHeight - 14 + 1,
          `${label} category`,
        );
        assert.ok(
          banner.chip[1] + banner.chip[3] <= banner.categoryBox[1] + 1,
          `${label} chip above category`,
        );
        assert.equal(
          banner.image.fit,
          banner.wordmark ? 'contain' : 'fill',
          `${label} logo scaled whole`,
        );
      }
      await context.close();
    }
  }
});

test('each rail scrolls by keyboard, is labelled with its category, ships no script and never animates its scroll', async () => {
  const { context, page } = await openLanding({ width: 390, motion: true });
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
  // Focus puts the rail at rest at once, whatever its reveal.
  assert.deepEqual(
    await track.evaluate((element) => [
      globalThis.getComputedStyle(element).opacity,
      globalThis.getComputedStyle(element).translate,
    ]),
    ['1', 'none'],
  );
  const before = await track.evaluate((element) => element.scrollLeft);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(
    (start) =>
      globalThis.document.querySelectorAll(
        '#catalogue .provider-rail__track',
      )[1].scrollLeft > start,
    before,
  );
  assert.equal(await page.locator('#catalogue script').count(), 0);
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
  // Touch: a swipe scrolls the rail natively and snaps a banner to its start.
  const touchContext = await browser.newContext({
    viewport: { width: 390, height: 900 },
    hasTouch: true,
    isMobile: true,
  });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(browserOrigin);
  const rail = touchPage.locator('#catalogue .provider-rail__track').first();
  await rail.scrollIntoViewIfNeeded();
  const swipe = await rail.boundingBox();
  const client = await touchContext.newCDPSession(touchPage);
  const x = Math.round(swipe.x + swipe.width * 0.8);
  const y = Math.round(swipe.y + swipe.height / 2);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 10; step += 1)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - step * 25, y }],
    });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await touchPage.waitForFunction(
    () =>
      globalThis.document.querySelector('#catalogue .provider-rail__track')
        .scrollLeft > 0,
  );
  await touchContext.close();
  await context.close();
});

test('banners stay out of the tab order: the catalogue adds exactly its four rails to the landing tab sequence', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openLanding({ width });
    const sequence = [];
    for (let press = 0; press < 200; press += 1) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const element = globalThis.document.activeElement;
        if (!element || element === globalThis.document.body) return null;
        return {
          banner: element.matches('[data-provider-banner]'),
          inCatalogue: element.closest('#catalogue') !== null,
          inHow: element.closest('#how') !== null,
          label: element.getAttribute('aria-label'),
          footer: element.closest('footer') !== null,
        };
      });
      if (stop === null) break;
      sequence.push(stop);
      if (stop.footer) break;
    }
    assert.ok(
      sequence.some((stop) => stop.footer),
      `${width} reaches the footer`,
    );
    assert.equal(sequence.filter((stop) => stop.banner).length, 0, `${width}`);
    assert.equal(sequence.filter((stop) => stop.inHow).length, 0, `${width}`);
    assert.deepEqual(
      sequence.filter((stop) => stop.inCatalogue).map((stop) => stop.label),
      groupLabels,
      `${width} the rails, in order`,
    );
    await context.close();
  }
});

test('a banner rises by --lift from shadow 1 to shadow 2 and shifts its tonal layer by 4% on hover and on focus-visible, over --duration-base, and not under reduced motion', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await openLanding({
      width: 1440,
      colorScheme,
      motion: true,
    });
    const banner = page.locator('[data-provider-banner]').first();
    await banner.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const read = () =>
      banner.evaluate((element) => {
        const style = globalThis.getComputedStyle(element);
        const tones = element.querySelector('.provider-banner__tones');
        const toneBox = tones.getBoundingClientRect();
        const own = element.getBoundingClientRect();
        return {
          transform: style.transform,
          boxShadow: style.boxShadow,
          translate: globalThis.getComputedStyle(tones).translate,
          size: [toneBox.width, toneBox.height],
          shift: [toneBox.left - own.left, toneBox.top - own.top],
          transitions: [...element.getAnimations(), ...tones.getAnimations()]
            .filter(
              (animation) => animation instanceof globalThis.CSSTransition,
            )
            .map((animation) => [
              animation.transitionProperty,
              animation.effect.getComputedTiming().duration,
            ]),
        };
      });
    const rest = await read();
    assert.equal(rest.transform, 'none');
    assert.equal(rest.translate, 'none');
    await banner.hover();
    await page.waitForTimeout(30);
    const moving = await read();
    assert.deepEqual(
      moving.transitions.map(([property]) => property).sort(),
      ['box-shadow', 'transform', 'translate'],
      `${colorScheme} the hover transitions`,
    );
    for (const [, duration] of moving.transitions)
      assert.equal(duration, 200, `${colorScheme} --duration-base`);
    await transitionsEnded(page);
    const raised = await read();
    assert.equal(raised.transform, 'matrix(1, 0, 0, 1, 0, -2)');
    // Shadow 2, keeping the canvas's 1px light edge (0.1) in dark.
    assert.match(
      raised.boxShadow,
      colorScheme === 'dark' ? /20px 48px/u : /18px 44px/u,
    );
    if (colorScheme === 'dark')
      assert.match(
        raised.boxShadow,
        /rgba\(240, 240, 238, 0\.1\) 0px 0px 0px 1px inset/u,
      );
    // --tone-shift: 4% of the layer's own size, which is the banner's.
    assert.equal(raised.translate, '4% 4%');
    near(raised.shift[0], raised.size[0] * 0.04, 'tone shift x');
    near(raised.shift[1], raised.size[1] * 0.04, 'tone shift y');
    await page.mouse.move(0, 0);
    await transitionsEnded(page);
    assert.equal((await read()).transform, 'none');
    // Banners are not focusable (founder decision 2026-11-08); the
    // focus-visible rule is proved on a banner made focusable in place.
    await banner.evaluate((element) => {
      element.tabIndex = 0;
    });
    // A key press makes the next focus a keyboard focus.
    await page.keyboard.press('Tab');
    await banner.focus();
    assert.equal(
      await banner.evaluate((element) => element.matches(':focus-visible')),
      true,
    );
    await transitionsEnded(page);
    const focused = await read();
    assert.equal(focused.transform, 'matrix(1, 0, 0, 1, 0, -2)');
    assert.notEqual(focused.translate, 'none');
    await context.close();
  }
  // Reduced motion: the state changes snap, with no transition.
  const { context, page } = await openLanding({ width: 1440 });
  const banner = page.locator('[data-provider-banner]').first();
  await banner.hover();
  const transitions = await banner.evaluate(
    (element) =>
      [
        ...element.getAnimations(),
        ...element.querySelector('.provider-banner__tones').getAnimations(),
      ].filter((animation) => animation instanceof globalThis.CSSTransition)
        .length,
  );
  assert.equal(transitions, 0);
  assert.equal(
    await banner.evaluate(
      (element) => globalThis.getComputedStyle(element).transform,
    ),
    'matrix(1, 0, 0, 1, 0, -2)',
  );
  await context.close();
});

// The reveal state of every moving element in #catalogue and #how.
function readMotion(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const state = (element) => {
      const style = getComputedStyle(element);
      const animation = element
        .getAnimations()
        .find((running) => !(running instanceof globalThis.CSSTransition));
      return {
        opacity: Number(style.opacity),
        translate: style.translate,
        name: style.animationName,
        timeline: style.animationTimeline,
        progress: animation?.effect.getComputedTiming().progress ?? null,
        top: element.getBoundingClientRect().top,
      };
    };
    const drawn = (svg) => {
      const draw = svg.querySelector('.landing-step__draw');
      return {
        visible: getComputedStyle(svg).display !== 'none',
        offset: Number.parseFloat(getComputedStyle(draw).strokeDashoffset),
        name: getComputedStyle(draw).animationName,
        timeline: getComputedStyle(draw).animationTimeline,
      };
    };
    return {
      labels: [...document.querySelectorAll('#catalogue h3')].map(state),
      tracks: [
        ...document.querySelectorAll('#catalogue .provider-rail__track'),
      ].map(state),
      banners: [...document.querySelectorAll('[data-provider-banner]')].map(
        (banner) => ({
          ...state(banner),
          index: banner.style.getPropertyValue('--reveal-index').trim(),
        }),
      ),
      steps: [...document.querySelectorAll('#how ol > li')].map((step) => ({
        ...state(step),
        index: step.style.getPropertyValue('--reveal-index').trim(),
        // The connector leaving this step, drawn inside the next one.
        connectors: [
          ...(step.nextElementSibling?.querySelectorAll(
            '.landing-step__connector',
          ) ?? []),
        ].map(drawn),
      })),
      viewport: globalThis.innerHeight,
    };
  });
}

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
  // A scroll-driven animation updates in the next rendering frames.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve),
        ),
      ),
  );
}

const atRestState = (element) =>
  element.opacity === 1 && element.translate === 'none';

// What the screen shows of each connector, read from a screenshot rather than
// from the mask's own stroke (which animates whether or not anything is
// drawn through it). For the connector leaving steps 1 and 2: whether its
// line and its arrowhead are painted through the <mask> holding its
// animated .landing-step__draw; then, sampled pixel by pixel from its start
// to its end, the share of points showing its stroke (`painted`), how far
// along the last one is (`reach`, 0 to 1), whether its first 3px show it
// (`start`), and, across, whether its arrowhead does, sampled off the line
// so the line cannot stand in for it (`head`).
async function paintedConnectors(page) {
  const connectors = await page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    const maskOf = (element, svg) => {
      for (
        let node = element;
        node !== svg.parentNode;
        node = node.parentNode
      ) {
        const id = /url\("?#([^")]+)"?\)/u.exec(
          getComputedStyle(node).maskImage,
        )?.[1];
        if (id) return document.getElementById(id);
      }
      return null;
    };
    const panel = document.querySelector('.landing-steps-panel');
    return [...document.querySelectorAll('#how ol > li')]
      .slice(1)
      .map((step) => {
        const svg = [...step.querySelectorAll('.landing-step__connector')].find(
          (each) => getComputedStyle(each).display !== 'none',
        );
        const draw = svg.querySelector('.landing-step__draw');
        const mask = svg.querySelector('mask');
        const line = svg.querySelector('.landing-step__line');
        const head = svg.querySelector('.landing-step__head polygon');
        const drawsThrough = (element) =>
          element !== null &&
          maskOf(element, svg) === mask &&
          mask.contains(draw);
        const box = svg.getBoundingClientRect();
        return {
          across: svg.classList.contains('landing-step__connector--across'),
          masked: {
            line: drawsThrough(line),
            head: head === null ? null : drawsThrough(head),
          },
          box: {
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
          },
          stroke: getComputedStyle(line).stroke,
          dashes: getComputedStyle(line).strokeDasharray,
          background: getComputedStyle(panel).backgroundColor,
        };
      });
  });
  // The small-width signup dock is fixed over the bottom of the viewport; it
  // is hidden from the capture so it cannot cover, or stand in for, a line.
  const shot = await page.screenshot({
    scale: 'css',
    style: '.signup-dock { visibility: hidden !important; }',
  });
  const { data, info } = await sharp(shot)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = (value) => value.match(/\d+/gu).slice(0, 3).map(Number);
  return connectors.map((connector) => {
    const background = rgb(connector.background);
    const stroke = rgb(connector.stroke);
    const full = stroke.reduce(
      (sum, channel, index) => sum + Math.abs(channel - background[index]),
      0,
    );
    // A point shows the stroke when a pixel at one of the given offsets
    // from it is at least half-way from the panel's colour to the stroke's.
    const shows = (x, y, offsets) =>
      offsets.some(([dx, dy]) => {
        const px = Math.floor(x) + dx;
        const py = Math.floor(y) + dy;
        if (px < 0 || py < 0 || px >= info.width || py >= info.height)
          return false;
        const at = (py * info.width + px) * info.channels;
        const distance = background.reduce(
          (sum, channel, index) => sum + Math.abs(data[at + index] - channel),
          0,
        );
        return distance >= full / 2;
      });
    const { left, top, width, height } = connector.box;
    const length = connector.across ? width : height;
    // Along the line, each pixel is read with its neighbours across it only,
    // so nothing beyond either end (the next tile's border) can count.
    const across = [-1, 0, 1].map((spread) =>
      connector.across ? [0, spread] : [spread, 0],
    );
    const point = (along) =>
      connector.across
        ? [left + along, top + height / 2]
        : [left + width / 2, top + along];
    const samples = [];
    for (let along = 0.5; along < length; along += 1)
      samples.push(shows(...point(along), across) ? along : null);
    const shown = samples.filter((along) => along !== null);
    // The arrowhead, 7 × 12 with its tip at the line's end: two points 5.5px
    // back from the tip, 4px above and below the line.
    const near = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => [dx, dy]));
    const head = connector.across
      ? shows(left + width - 5.5, top + height / 2 - 4, near) &&
        shows(left + width - 5.5, top + height / 2 + 4, near)
      : null;
    return {
      across: connector.across,
      masked: connector.masked,
      length,
      // One dash and its gap, in px; 0 for a solid line.
      period: (connector.dashes.match(/[\d.]+/gu) ?? [])
        .map(Number)
        .reduce((sum, value) => sum + value, 0),
      painted: shown.length / samples.length,
      reach: shown.length === 0 ? 0 : (Math.max(...shown) + 0.5) / length,
      start: samples.slice(0, 3).every((along) => along !== null),
      head,
    };
  });
}

// A whole connector on screen: painted from its start to its end and, across,
// its arrowhead; the solid one along its full length, the dashed one in
// dashes (about half its points).
function assertWhole(shown, dashed, label) {
  assert.deepEqual(
    shown.masked,
    { line: true, head: shown.across ? true : null },
    `${label} is drawn through its mask`,
  );
  assert.ok(shown.start, `${label} is drawn from its start`);
  assert.ok(
    shown.reach >= 0.98,
    `${label} is drawn to its end: ${shown.reach}`,
  );
  if (shown.across) assert.equal(shown.head, true, `${label} arrowhead drawn`);
  if (dashed)
    assert.ok(
      shown.painted > 0.4 && shown.painted < 0.8,
      `${label} is dashed: ${shown.painted}`,
    );
  else assert.ok(shown.painted >= 0.98, `${label} is whole: ${shown.painted}`);
}

test('the catalogue reveals its labels and large-width banners left to right, and its rails whole, at rest by 70% of the viewport height', async () => {
  for (const width of [1440, 1024, 768, 390]) {
    const { context, page } = await openLanding({ width, motion: true });
    const large = width >= 1024;
    let motion = await readMotion(page);
    for (const label of motion.labels) {
      assert.equal(label.name, 'motion-reveal', `${width} label reveals`);
      assert.equal(label.timeline, 'view(0px)', `${width} label timeline`);
    }
    for (const [index, track] of motion.tracks.entries())
      assert.equal(
        track.name,
        large ? 'none' : 'motion-reveal',
        `${width} rail ${index} reveals ${large ? 'per banner' : 'whole'}`,
      );
    for (const banner of motion.banners)
      assert.equal(
        banner.name,
        large ? 'motion-reveal' : 'none',
        `${width} banner reveal`,
      );
    // Each banner's index is its large-width column, 0 to 4.
    const groups = await page.evaluate(() =>
      [...globalThis.document.querySelectorAll('.provider-rail__track')].map(
        (track) =>
          [...track.querySelectorAll('[data-provider-banner]')].map((banner) =>
            Number(banner.style.getPropertyValue('--reveal-index')),
          ),
      ),
    );
    for (const group of groups)
      assert.deepEqual(
        group,
        group.map((_, position) => position % 5),
      );
    // Mid-reveal, a row is in reading order: the first row of AI tools, its
    // top a little above the viewport's bottom edge.
    await scrollToTop(page, '#catalogue .provider-rail__track', 0.97);
    motion = await readMotion(page);
    if (large) {
      const row = motion.banners.slice(0, 5);
      assert.ok(row[0].opacity < 1, `${width} the row is revealing`);
      for (let column = 1; column < 5; column += 1)
        assert.ok(
          row[column].opacity <= row[column - 1].opacity,
          `${width} column ${column} is no further on than column ${column - 1}`,
        );
      assert.ok(row[4].opacity < row[0].opacity, `${width} left to right`);
    } else {
      assert.ok(motion.tracks[0].opacity < 1, `${width} the rail is revealing`);
      for (const banner of motion.banners) assert.equal(banner.opacity, 1);
    }
    // At rest once each element's top is at 70% of the viewport height.
    const targets = motion.labels.map(
      (_, index) =>
        `#catalogue .provider-rail__category:nth-child(${index + 1}) h3`,
    );
    for (const selector of targets) {
      await scrollToTop(page, selector, 0.7);
      const element = await page.evaluate((target) => {
        const node = globalThis.document.querySelector(target);
        const style = globalThis.getComputedStyle(node);
        return { opacity: Number(style.opacity), translate: style.translate };
      }, selector);
      assert.ok(atRestState(element), `${width} ${selector} at rest at 70%`);
    }
    const bannerCount = motion.banners.length;
    for (let index = 0; index < bannerCount; index += 1) {
      const selector = `[data-provider-banner="${catalogue[index].name}"]`;
      await scrollToTop(page, selector, 0.7);
      const element = await page.evaluate((target) => {
        const node = globalThis.document.querySelector(target);
        const track = node.parentElement;
        const style = globalThis.getComputedStyle(node);
        const trackStyle = globalThis.getComputedStyle(track);
        return {
          opacity: Number(style.opacity) * Number(trackStyle.opacity),
          translate:
            style.translate === 'none' && trackStyle.translate === 'none'
              ? 'none'
              : `${style.translate} / ${trackStyle.translate}`,
        };
      }, selector);
      assert.ok(
        atRestState(element),
        `${width} ${catalogue[index].name} at rest at 70%: ${JSON.stringify(element)}`,
      );
    }
    await context.close();
  }
});

test('"How it works" reveals its steps in order and draws each connector after its step, dash by dash, downward at small widths, at rest by 70%', async () => {
  for (const width of [1440, 768, 390]) {
    const { context, page } = await openLanding({ width, motion: true });
    const across = width >= 768;
    let motion = await readMotion(page);
    assert.deepEqual(
      motion.steps.map((step) => [step.index, step.name]),
      [
        ['0', 'motion-reveal'],
        ['1', 'motion-reveal'],
        ['2', 'motion-reveal'],
      ],
    );
    for (const [index, step] of motion.steps.slice(0, 2).entries()) {
      const visible = step.connectors.filter((connector) => connector.visible);
      assert.equal(visible.length, 1, `${width} one connector shows`);
      assert.equal(visible[0].name, 'landing-connector-draw');
      // From 48rem, the view timeline of the step it leaves; below, where
      // the steps stack, that of the step it sits in and leads into
      // (founder decision 2026-11-08).
      assert.equal(
        visible[0].timeline,
        `--landing-step-${index + (across ? 1 : 2)}`,
        `${width} same timeline`,
      );
    }
    assert.equal(motion.steps[2].connectors.length, 0, 'step 3 leads nowhere');
    // The line, and across its arrowhead, are painted only through the
    // connector's own mask, the one holding its animated stroke.
    for (const [index, connector] of (await paintedConnectors(page)).entries())
      assert.deepEqual(
        [connector.across, connector.masked],
        [across, { line: true, head: across ? true : null }],
        `${width} connector ${index + 1} is drawn through its mask`,
      );
    // While the steps are still revealing, no connector has started.
    await scrollToTop(page, '#how ol > li', 0.98);
    motion = await readMotion(page);
    assert.ok(motion.steps[0].opacity < 1, `${width} step 1 is revealing`);
    if (across)
      assert.ok(
        motion.steps[0].opacity >= motion.steps[1].opacity &&
          motion.steps[1].opacity >= motion.steps[2].opacity,
        `${width} the steps reveal in order`,
      );
    for (const step of motion.steps.slice(0, 2)) {
      const connector = step.connectors.find((each) => each.visible);
      if (step.opacity < 1)
        assert.equal(connector.offset, 1, `${width} drawn only after its step`);
    }
    // Scrolling the step it leads into up the viewport: while either step
    // it joins is still revealing, nothing is drawn; once both are at rest,
    // the screen shows it partway, from its start and not yet at its end or
    // its arrowhead, as far as its mask's stroke has reached. The dashed
    // 2 → 3 connector shows only the dashes that stroke has reached.
    for (const index of [0, 1]) {
      const label = `${width} connector ${index + 1}`;
      const dashed = index === 1;
      let partway = null;
      // In 2px scroll steps, so a 28px connector is caught partway.
      const scrollStep = 2 / motion.viewport;
      for (let at = 0.98; at >= 0.58 && partway === null; at -= scrollStep) {
        await scrollToTop(page, `#how ol > li:nth-child(${index + 2})`, at);
        motion = await readMotion(page);
        const joined = [motion.steps[index], motion.steps[index + 1]];
        const { offset } = motion.steps[index].connectors.find(
          (each) => each.visible,
        );
        if (!joined.every(atRestState)) {
          assert.equal(offset, 1, `${label} waits for both its steps`);
          continue;
        }
        if (offset < 0.25 || offset > 0.75) continue;
        const shown = (await paintedConnectors(page))[index];
        const drawn = 1 - offset;
        assert.equal(shown.period > 0, dashed, `${label} dashed`);
        // The dashed one is read once its stroke has passed a whole gap.
        if (dashed && drawn * shown.length < shown.period + 2) continue;
        partway = offset;
        assert.ok(shown.start, `${label} is drawn from its start`);
        assert.ok(
          shown.reach <= drawn + 2.5 / shown.length &&
            shown.reach >= drawn - (shown.period + 2.5) / shown.length,
          `${label} is shown as far as its mask: ${shown.reach} for ${drawn}`,
        );
        if (across)
          assert.equal(shown.head, false, `${label} arrowhead not yet drawn`);
        if (dashed)
          assert.ok(
            shown.painted <= shown.reach * 0.85,
            `${label} draws dash by dash: ${shown.painted} of ${shown.reach}`,
          );
      }
      assert.ok(partway !== null, `${label} draws after its step`);
    }
    if (!across) {
      // Downward: the visible part is the top of the line.
      const shown = await page.evaluate(() => {
        const svg = [
          ...globalThis.document.querySelectorAll(
            '#how ol > li:nth-child(3) .landing-step__connector',
          ),
        ].find((each) => globalThis.getComputedStyle(each).display !== 'none');
        const draw = svg.querySelector('.landing-step__draw');
        return [draw.getAttribute('y1'), draw.getAttribute('y2')];
      });
      assert.deepEqual(shown, ['0', '100%'], `${width} draws downward`);
    }
    // At rest by 70%: every step, and every connector, each read with its
    // own top at 70% of the viewport height; the screen shows the whole
    // connector and its arrowhead.
    for (const index of [1, 2, 3]) {
      await scrollToTop(page, `#how ol > li:nth-child(${index})`, 0.7);
      motion = await readMotion(page);
      const step = motion.steps[index - 1];
      assert.ok(atRestState(step), `${width} step ${index} at rest at 70%`);
    }
    for (const index of [0, 1]) {
      await scrollToTop(
        page,
        `#how ol > li:nth-child(${index + 2}) .landing-step__connector--${across ? 'across' : 'down'}`,
        0.7,
      );
      motion = await readMotion(page);
      const connector = motion.steps[index].connectors.find(
        (each) => each.visible,
      );
      assert.equal(
        connector.offset,
        0,
        `${width} connector ${index + 1} drawn at 70%: ${connector.offset}`,
      );
      assertWhole(
        (await paintedConnectors(page))[index],
        index === 1,
        `${width} connector ${index + 1} at 70%`,
      );
    }
    await context.close();
  }
});

test('under reduced motion nothing in the catalogue or "How it works" moves, and every connector is drawn', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openLanding({ width });
    for (const fraction of [0.98, 0.7]) {
      await scrollToTop(page, '#catalogue .provider-rail__track', fraction);
      const moving = await page.evaluate(
        () =>
          globalThis.document
            .getAnimations()
            .filter((animation) =>
              animation.effect?.target?.closest?.('#catalogue, #how'),
            ).length,
      );
      assert.equal(moving, 0, `${width} nothing animates`);
      await scrollToTop(page, '#how ol > li', 0.98);
      const motion = await readMotion(page);
      for (const element of [
        ...motion.labels,
        ...motion.tracks,
        ...motion.banners,
        ...motion.steps,
      ])
        assert.ok(atRestState(element), `${width} at rest`);
      for (const step of motion.steps)
        for (const connector of step.connectors)
          assert.equal(connector.offset, 0, `${width} drawn`);
    }
    // And the screen shows each one whole.
    await scrollToTop(page, '#how ol', 0.2);
    for (const [index, shown] of (await paintedConnectors(page)).entries())
      assertWhole(shown, index === 1, `${width} connector ${index + 1}`);
    await context.close();
  }
});

test('with animations unsupported, the catalogue and "How it works" are at rest and every connector is drawn', async () => {
  for (const width of [1440, 390]) {
    const { context, page } = await openLanding({ width, motion: true });
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; }',
    });
    for (const fraction of [0.98, 0.5]) {
      await scrollToTop(page, '#how ol > li', fraction);
      const motion = await readMotion(page);
      for (const element of [
        ...motion.labels,
        ...motion.tracks,
        ...motion.banners,
        ...motion.steps,
      ])
        assert.ok(atRestState(element), `${width} at rest`);
      for (const step of motion.steps)
        for (const connector of step.connectors)
          assert.equal(connector.offset, 0, `${width} drawn`);
    }
    // And the screen shows each one whole.
    await scrollToTop(page, '#how ol', 0.2);
    for (const [index, shown] of (await paintedConnectors(page)).entries())
      assertWhole(shown, index === 1, `${width} connector ${index + 1}`);
    await context.close();
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
