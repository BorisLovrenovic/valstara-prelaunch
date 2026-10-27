/* global getComputedStyle */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { chromium } from 'playwright';

import { primitivesCopy } from '../src/copy/primitives.ts';
import { themeToggleCopy } from '../src/copy/theme-toggle.ts';
import { publishedPort } from './helpers/listen-port.mjs';

const executeFile = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const componentsDirectory = join(projectRoot, 'src/components');
const fixtureRoot = join(projectRoot, 'test/fixtures/interface-primitives');
const fixtureConfig =
  '../../../scripts/fixtures/interface-primitives.astro.config.mjs';
const browserContainer = `valstara-primitives-playwright-${process.pid}`;
const fixtureServerStartupTimeoutMilliseconds = 30_000;
const serverOutputLimit = 16_384;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';

let browser;
let browserOrigin;
let fixtureOrigin;
let browserServer;
let browserServerError;
let server;
let serverError;
let serverOutput = '';

function relativeLuminance(color) {
  const channels = color
    .match(/[\d.]+/gu)
    .slice(0, 3)
    .map(Number)
    .map((channel) => channel / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

// An rgb() or rgba() string as [r, g, b, alpha].
function parseColor(color) {
  const [red, green, blue, alpha = 1] = color.match(/[\d.]+/gu).map(Number);
  return [red, green, blue, alpha];
}

// A translucent fill as the opaque colour it shows over its background.
function composite(fill, background) {
  const [red, green, blue, alpha] = parseColor(fill);
  const base = parseColor(background);
  const mix = (top, bottom) => Math.round(top * alpha + bottom * (1 - alpha));
  return `rgb(${mix(red, base[0])}, ${mix(green, base[1])}, ${mix(blue, base[2])})`;
}

// The colours of a computed box-shadow list, in order.
function shadowColors(boxShadow) {
  return [...boxShadow.matchAll(/rgba?\([^)]*\)/gu)].map((match) => match[0]);
}

async function componentSources() {
  const entries = await readdir(componentsDirectory, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && extname(entry.name) === '.astro')
      .map(async (entry) => ({
        name: entry.name,
        source: await readFile(join(componentsDirectory, entry.name), 'utf8'),
      })),
  );
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
    await new Promise((resolvePromise) =>
      globalThis.setTimeout(resolvePromise, 250),
    );
  }

  throw new Error(
    `Containerized Playwright server did not start within three minutes.\n${output}`,
  );
}

async function waitForFixtureServer() {
  const deadline =
    globalThis.performance.now() + fixtureServerStartupTimeoutMilliseconds;

  while (globalThis.performance.now() < deadline) {
    if (serverError !== undefined) {
      throw new Error(
        `Could not start the interface primitive fixture server: ${serverError.message}`,
        { cause: serverError },
      );
    }
    if (server.exitCode !== null) {
      throw new Error(
        `Interface primitive fixture server exited before startup.\n${serverOutput || '(no server output)'}`,
      );
    }
    const port = /local: http:\/\/localhost:(\d+)/u.exec(serverOutput)?.[1];
    if (port !== undefined) {
      try {
        const response = await globalThis.fetch(`http://127.0.0.1:${port}`, {
          signal: globalThis.AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          browserOrigin = `http://host.docker.internal:${port}`;
          fixtureOrigin = `http://127.0.0.1:${port}`;
          return;
        }
      } catch {
        // The fixture server may still be finishing startup.
      }
    }
    await new Promise((resolvePromise) =>
      globalThis.setTimeout(resolvePromise, 25),
    );
  }
  throw new Error(
    `Interface primitive fixture server did not start within 30 seconds.\n${serverOutput || '(no server output)'}`,
  );
}

before(async () => {
  await executeFile(
    process.execPath,
    [
      join(projectRoot, 'node_modules/astro/bin/astro.mjs'),
      'build',
      '--root',
      fixtureRoot,
      '--config',
      fixtureConfig,
    ],
    { cwd: projectRoot },
  );

  server = spawn(
    process.execPath,
    [join(projectRoot, 'scripts/fixtures/run-interface-primitives-server.mjs')],
    {
      env: { ...process.env, HOST: '0.0.0.0', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  const captureServerOutput = (chunk) => {
    serverOutput = `${serverOutput}${chunk}`.slice(-serverOutputLimit);
  };
  server.stdout.on('data', captureServerOutput);
  server.stderr.on('data', captureServerOutput);
  server.once('error', (error) => {
    serverError = error;
  });
  await waitForFixtureServer();
  const browserServerEndpoint = await startBrowserServer();
  browser = await chromium.connect(browserServerEndpoint);
});

after(async () => {
  await browser?.close();
  if (browserServerError === undefined) {
    await executeFile('docker', ['rm', '--force', browserContainer]).catch(
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
  if (server !== undefined && server.exitCode === null) {
    const serverExited = once(server, 'exit');
    server.kill('SIGTERM');
    await serverExited;
  }
});

test('all primitives and the icon registry are zero-JavaScript Astro components', async () => {
  const components = await componentSources();
  // E11.5-03 adds the zero-JS Container and Section layout primitives,
  // E11.5-11a the checkbox, icon tile and text link from the component sheet,
  // and E11.5-11c the hero banner (founder-authorised 2026-10-27).
  assert.deepEqual(components.map(({ name }) => name).sort(), [
    'accordion.astro',
    'button.astro',
    'card.astro',
    'checkbox.astro',
    'container.astro',
    'field.astro',
    'hero-banner.astro',
    'icon-tile.astro',
    'icon.astro',
    'input.astro',
    'pill.astro',
    'provider-banner.astro',
    'provider-rail.astro',
    'section.astro',
    'select.astro',
    'text-link.astro',
  ]);

  for (const { name, source } of components) {
    assert.doesNotMatch(source, /<script\b|client:/u, name);
    assert.match(source, /var\(--/u, name);
  }
});

test('icons render in currentColor at token sizes with decorative hiding', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(browserOrigin);
    const icons = await page.locator('svg.icon').evaluateAll((elements) =>
      elements.map((element) => ({
        role: element.getAttribute('role'),
        hidden: element.getAttribute('aria-hidden'),
        label: element.getAttribute('aria-label'),
        width: getComputedStyle(element).width,
        height: getComputedStyle(element).height,
        colors: [...element.querySelectorAll('path, circle, rect')].map(
          (path) => [path.getAttribute('fill'), path.getAttribute('stroke')],
        ),
      })),
    );
    // E11.5-03: the field error state adds its alert icon and the accordion
    // its chevron, after the five registry icons. E11.5-11a (founder-
    // authorised rewrite, 2026-10-26): the error icon is the 20px
    // alert-circle, the chevron is 20px and the small star is 12 × 18.
    assert.equal(icons.length, 7);
    assert.deepEqual(
      icons.map((icon) => icon.width),
      ['12px', '24px', '40px', '24px', '24px', '20px', '20px'],
    );
    assert.deepEqual(
      icons.map((icon) => icon.height),
      ['18px', '24px', '40px', '24px', '24px', '20px', '20px'],
    );
    assert.equal(icons[0].hidden, 'true');
    assert.equal(icons[1].role, 'img');
    assert.equal(icons[1].label, 'Confirmed');
    assert.equal(icons[1].hidden, null);
    for (const icon of icons) {
      for (const [fill, stroke] of icon.colors) {
        assert.ok(fill === 'currentColor' || stroke === 'currentColor');
      }
    }
  } finally {
    await context.close();
  }
});

test('the decorative star has four sharp, concave points and 1.5:1 symmetric arms', async () => {
  // E11.5-11a (founder-authorised rewrite, 2026-10-26): the wireframe's
  // star, drawn in its own 16 × 24 box with quadratic, concave sides.
  const source = await readFile(
    join(componentsDirectory, 'icon.astro'),
    'utf8',
  );
  assert.match(source, /viewBox=\{isStar \? '0 0 16 24'/u);
  const path = /isStar && \([\s\S]*?<path\s+d="([^"]+)"/u.exec(source)?.[1];
  assert.equal(path, 'M8 0Q9 11 16 12Q9 13 8 24Q7 13 0 12Q7 11 8 0Z');
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) =>
    Number(match[0]),
  );
  const points = [];
  for (let index = 0; index < numbers.length; index += 2)
    points.push([numbers[index], numbers[index + 1]]);
  // Tips at the box edges: top, right, bottom, left.
  const tips = [points[0], points[2], points[4], points[6], points[8]];
  assert.deepEqual(tips, [
    [8, 0],
    [16, 12],
    [8, 24],
    [0, 12],
    [8, 0],
  ]);
  // Each side's control point sits inside the box, near the centre, so the
  // sides are concave and the tips sharp.
  for (const [x, y] of [points[1], points[3], points[5], points[7]]) {
    assert.ok(Math.abs(x - 8) <= 1 && Math.abs(y - 12) <= 1, `${x},${y}`);
  }
  // Symmetric about the vertical axis x = 8.
  const mirrored = points.map(([x, y]) => `${16 - x},${y}`).sort();
  assert.deepEqual(mirrored, points.map(([x, y]) => `${x},${y}`).sort());
  assert.equal((24 - 0) / (16 - 0), 1.5);
  assert.match(path, /^M[^Z]+Z$/u);
});

test('components contain no literal colour, font, radius, spacing or duration values', async () => {
  const literalColor = /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/iu;
  const tokenizedProperties = [
    /\b(?:background-)?color\s*:\s*([^;]+)/giu,
    /\bfont(?:-family|-size)?\s*:\s*([^;]+)/giu,
    /\bline-height\s*:\s*([^;]+)/giu,
    /\bborder-radius\s*:\s*([^;]+)/giu,
    /\b(?:margin|padding|gap|inset|top|right|bottom|left|outline-offset)(?:-[\w-]+)?\s*:\s*([^;]+)/giu,
    /\b(?:animation|transition)-duration\s*:\s*([^;]+)/giu,
  ];

  for (const { name, source } of await componentSources()) {
    assert.doesNotMatch(source, literalColor, `${name} has a literal colour`);
    for (const propertyPattern of tokenizedProperties) {
      for (const match of source.matchAll(propertyPattern)) {
        assert.match(
          match[1].trim(),
          /^(?:var\(|inherit\b|currentColor\b|transparent\b)/u,
          `${name} has a literal value in "${match[0]}"`,
        );
      }
    }
  }
});

test('native controls follow keyboard order and show contrasting focus indicators', async () => {
  const focusCases = [
    ['button', 'body'],
    ['input', '.card'],
    ['select', '.card'],
    ['summary', '.accordion'],
  ];

  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto(browserOrigin);
    await page.locator('button').evaluate((button) => {
      globalThis.__primitiveButtonActivations = 0;
      button.addEventListener('click', () => {
        globalThis.__primitiveButtonActivations += 1;
      });
    });

    for (const [selector, backgroundSelector] of focusCases) {
      await page.keyboard.press('Tab');
      assert.equal(
        await page
          .locator(selector)
          .evaluate((element) => element.matches(':focus-visible')),
        true,
        `${selector} in ${colorScheme}`,
      );
      const colors = await page
        .locator(selector)
        .evaluate((element, containingSelector) => {
          const focusStyle = globalThis.getComputedStyle(element);
          const background = element.closest(containingSelector);
          return {
            background: globalThis.getComputedStyle(background).backgroundColor,
            boxShadow: focusStyle.boxShadow,
            outline: focusStyle.outlineColor,
            outlineStyle: focusStyle.outlineStyle,
            outlineWidth: focusStyle.outlineWidth,
          };
        }, backgroundSelector);
      assert.notEqual(colors.outlineStyle, 'none', selector);
      assert.notEqual(colors.outlineWidth, '0px', selector);
      if (selector === 'input') {
        // The ring eases in over --duration-fast; read it once it settles.
        await page
          .locator(selector)
          .evaluate((element) =>
            Promise.all(
              element.getAnimations().map((animation) => animation.finished),
            ),
          );
        colors.boxShadow = await page
          .locator(selector)
          .evaluate(
            (element) => globalThis.getComputedStyle(element).boxShadow,
          );
        // E11.5-11a (founder-authorised rewrite, 2026-10-26): the input's
        // focus indicator is the drawn ring, a 2px surface gap inside a 2px
        // coral band. Its outline is transparent, kept for forced colours.
        assert.equal(colors.outline, 'rgba(0, 0, 0, 0)', colorScheme);
        assert.equal(colors.outlineWidth, '2px', colorScheme);
        const [gap, ring] = shadowColors(colors.boxShadow);
        assert.match(
          colors.boxShadow,
          /^rgb\([^)]*\) 0px 0px 0px 2px, rgb\([^)]*\) 0px 0px 0px 4px$/u,
        );
        assert.equal(gap, colors.background, colorScheme);
        assert.ok(
          contrastRatio(ring, colors.background) >= 3,
          `input ring in ${colorScheme}`,
        );
      } else {
        assert.ok(
          contrastRatio(colors.outline, colors.background) >= 3,
          `${selector} in ${colorScheme}`,
        );
      }

      if (selector === 'button') {
        await page.keyboard.press('Enter');
        assert.equal(
          await page.evaluate(() => globalThis.__primitiveButtonActivations),
          1,
        );
      }

      if (selector === 'input') {
        await page.keyboard.type('keyboard@example.com');
        assert.equal(
          await page.locator(selector).inputValue(),
          'keyboard@example.com',
          `input accepts keyboard entry in ${colorScheme}`,
        );
      }
    }

    await context.close();
  }
});

test('field errors are invalid, associated and exposed as alerts', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(browserOrigin);

  const input = page.locator('#email');
  assert.equal(await input.getAttribute('aria-invalid'), 'true');
  assert.deepEqual((await input.getAttribute('aria-describedby')).split(' '), [
    'email-description',
    'email-error',
  ]);
  assert.equal(
    await page.locator('#email-error').getAttribute('role'),
    'alert',
  );
  assert.equal(
    await page.getByRole('alert').textContent(),
    'Enter a valid email address.',
  );

  await context.close();
});

test('the accordion opens natively and remains readable without JavaScript', async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(browserOrigin);

  assert.equal(await page.locator('script').count(), 0);
  const details = page.locator('details');
  assert.equal(await details.getAttribute('open'), null);
  await page.locator('summary').press('Enter');
  assert.equal(await details.getAttribute('open'), '');
  assert.match(await details.textContent(), /We send one verification link\./u);

  await context.close();
});

test('all primitives resolve theme tokens in light and dark modes', async () => {
  const renderedThemes = [];

  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto(browserOrigin);
    renderedThemes.push(
      await page.evaluate(() => {
        const computedTheme = (selector) => {
          const element = globalThis.document.querySelector(selector);
          const style = globalThis.getComputedStyle(element);
          return {
            background: style.backgroundColor,
            color: style.color,
            visible:
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              element.getBoundingClientRect().width > 0 &&
              element.getBoundingClientRect().height > 0,
          };
        };

        return {
          accordion: computedTheme('.accordion'),
          button: computedTheme('.button'),
          card: computedTheme('.card'),
          field: computedTheme('.field'),
          input: computedTheme('.input'),
          page: computedTheme('body'),
          pill: computedTheme('.pill'),
          select: computedTheme('.select'),
        };
      }),
    );
    await context.close();
  }

  // E11.5-11a (founder-authorised rewrite, 2026-10-26): the button label is
  // --on-coral (#101014) in both themes, the pill label is ink, the dark pill
  // is the dark coral-tint, and the FAQ item is unboxed (no background).
  assert.deepEqual(renderedThemes, [
    {
      accordion: {
        background: 'rgba(0, 0, 0, 0)',
        color: 'rgb(16, 16, 20)',
        visible: true,
      },
      button: {
        background: 'rgb(232, 101, 74)',
        color: 'rgb(16, 16, 20)',
        visible: true,
      },
      card: {
        background: 'rgb(255, 255, 255)',
        color: 'rgb(16, 16, 20)',
        visible: true,
      },
      field: {
        background: 'rgba(0, 0, 0, 0)',
        color: 'rgb(16, 16, 20)',
        visible: true,
      },
      input: {
        background: 'rgb(255, 255, 255)',
        color: 'rgb(16, 16, 20)',
        visible: true,
      },
      page: {
        background: 'rgb(250, 250, 250)',
        color: 'rgb(16, 16, 20)',
        visible: true,
      },
      pill: {
        background: 'rgb(253, 238, 233)',
        color: 'rgb(16, 16, 20)',
        visible: true,
      },
      select: {
        background: 'rgb(255, 255, 255)',
        color: 'rgb(16, 16, 20)',
        visible: true,
      },
    },
    {
      accordion: {
        background: 'rgba(0, 0, 0, 0)',
        color: 'rgb(240, 240, 238)',
        visible: true,
      },
      button: {
        background: 'rgb(255, 138, 102)',
        color: 'rgb(16, 16, 20)',
        visible: true,
      },
      card: {
        background: 'rgb(23, 23, 51)',
        color: 'rgb(240, 240, 238)',
        visible: true,
      },
      field: {
        background: 'rgba(0, 0, 0, 0)',
        color: 'rgb(240, 240, 238)',
        visible: true,
      },
      input: {
        background: 'rgb(23, 23, 51)',
        color: 'rgb(240, 240, 238)',
        visible: true,
      },
      page: {
        background: 'rgb(15, 15, 26)',
        color: 'rgb(240, 240, 238)',
        visible: true,
      },
      pill: {
        background: 'rgba(255, 138, 102, 0.16)',
        color: 'rgb(240, 240, 238)',
        visible: true,
      },
      select: {
        background: 'rgb(23, 23, 51)',
        color: 'rgb(240, 240, 238)',
        visible: true,
      },
    },
  ]);
});

// E11.5-03 primitive states, rendered on their own fixture page so the E2-04
// fixture and its exact assertions above stay as they are.
// Reduced motion stops the state transitions, so a computed style read right
// after hover or press is the settled state rather than a frame mid-change.
async function statesPage(options = {}) {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    ...options,
  });
  const page = await context.newPage();
  await page.goto(`${browserOrigin}/states`);
  return { context, page };
}

function computed(page, selector, properties) {
  return page.locator(selector).evaluate((element, names) => {
    const style = globalThis.getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style[name]]));
  }, properties);
}

// Any token expression, such as a two-token shadow list, as computed.
function resolvedValue(page, property, value) {
  return page.evaluate(
    ([name, expression]) => {
      const probe = globalThis.document.createElement('div');
      // A border width computes to 0 unless the border has a style.
      probe.style.borderStyle = 'solid';
      probe.style[name] = expression;
      globalThis.document.body.append(probe);
      const resolved = globalThis.getComputedStyle(probe)[name];
      probe.remove();
      return resolved;
    },
    [property, value],
  );
}

function resolvedToken(page, property, token) {
  return page.evaluate(
    ([name, value]) => {
      const probe = globalThis.document.createElement('div');
      probe.style[name] = `var(${value})`;
      globalThis.document.body.append(probe);
      const resolved = globalThis.getComputedStyle(probe)[name];
      probe.remove();
      return resolved;
    },
    [property, token],
  );
}

test('buttons show distinct hover, active, focus-visible and disabled states at least the tap minimum', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { context, page } = await statesPage({ colorScheme });
    try {
      const properties = ['backgroundColor', 'boxShadow', 'cursor'];
      const coral = await resolvedToken(page, 'backgroundColor', '--coral');
      // E11.5-11a (founder-authorised rewrite, 2026-10-26): primary rests on
      // its own shadow, and hover and active darken through an inset overlay
      // over the unchanged coral fill.
      const restShadow = await resolvedToken(
        page,
        'boxShadow',
        '--shadow-button',
      );
      const hoverShadow = await resolvedValue(
        page,
        'boxShadow',
        'var(--overlay-hover), var(--shadow-1)',
      );
      const activeShadow = await resolvedToken(
        page,
        'boxShadow',
        '--overlay-active',
      );
      assert.equal(restShadow, 'rgba(16, 16, 20, 0.14) 0px 1px 2px 0px');
      assert.match(
        hoverShadow,
        /^rgba\(16, 16, 20, 0\.08\) 0px 0px 0px 100px inset, /u,
      );
      assert.equal(
        activeShadow,
        'rgba(16, 16, 20, 0.16) 0px 0px 0px 100px inset',
      );

      const rest = await computed(page, '#primary', properties);
      assert.equal(rest.backgroundColor, coral, colorScheme);
      assert.equal(rest.boxShadow, restShadow);

      await page.locator('#primary').hover();
      const hover = await computed(page, '#primary', properties);
      assert.equal(hover.backgroundColor, coral, colorScheme);
      assert.equal(hover.boxShadow, hoverShadow);

      await page.mouse.down();
      const active = await computed(page, '#primary', properties);
      assert.equal(active.backgroundColor, coral);
      assert.equal(active.boxShadow, activeShadow);
      await page.mouse.up();

      // A fresh load, so the first Tab is keyboard focus with no prior click.
      await page.reload();
      await page.keyboard.press('Tab');
      assert.equal(
        await page
          .locator('#primary')
          .evaluate((element) => element.matches(':focus-visible')),
        true,
      );
      const focus = await computed(page, '#primary', [
        'outlineStyle',
        'outlineColor',
      ]);
      assert.equal(focus.outlineStyle, 'solid');
      assert.equal(
        focus.outlineColor,
        await resolvedToken(page, 'color', '--coral'),
      );

      const disabled = await computed(page, '#disabled', properties);
      assert.equal(
        disabled.backgroundColor,
        await resolvedToken(page, 'backgroundColor', '--coral-tint'),
      );
      assert.equal(disabled.boxShadow, 'none');
      assert.equal(disabled.cursor, 'not-allowed');
      assert.equal(await page.locator('#disabled').isDisabled(), true);

      for (const selector of [
        '#primary',
        '#secondary',
        '#disabled',
        '#link-button',
        '#on-midnight',
      ]) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.height >= 44 && box.width >= 44, selector);
      }
    } finally {
      await context.close();
    }
  }
});

test('a button with an href is a native link, and on-midnight reads on the band', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { context, page } = await statesPage({ colorScheme });
    try {
      const link = page.locator('#link-button');
      assert.equal(await link.evaluate((element) => element.tagName), 'A');
      assert.equal(await link.getAttribute('href'), '/states#target');
      assert.equal(await link.getAttribute('type'), null);

      const band = await computed(page, '#midnight-section', [
        'backgroundColor',
        'color',
      ]);
      assert.equal(
        band.backgroundColor,
        await resolvedToken(page, 'backgroundColor', '--midnight'),
      );
      const onMidnight = await computed(page, '#on-midnight', [
        'backgroundColor',
        'color',
      ]);
      assert.ok(
        contrastRatio(onMidnight.color, band.backgroundColor) >= 4.5,
        colorScheme,
      );
      await page.locator('#on-midnight').hover();
      const hovered = await computed(page, '#on-midnight', [
        'backgroundColor',
        'color',
      ]);
      assert.notEqual(hovered.backgroundColor, onMidnight.backgroundColor);
      // E11.5-11a (founder-authorised rewrite, 2026-10-26): the hover fill is
      // translucent, so its contrast is read on the fill composited over the
      // midnight band it sits on.
      assert.equal(
        hovered.backgroundColor,
        await resolvedToken(page, 'backgroundColor', '--on-midnight-hover'),
      );
      assert.ok(
        contrastRatio(
          hovered.color,
          composite(hovered.backgroundColor, band.backgroundColor),
        ) >= 4.5,
        colorScheme,
      );
    } finally {
      await context.close();
    }
  }
});

test('a button renders exactly one type attribute, defaulting to button', async () => {
  // The parsed DOM drops duplicate attributes, so read the server's markup.
  const html = await (await globalThis.fetch(`${fixtureOrigin}/states`)).text();
  for (const [id, type] of [
    ['primary', 'button'],
    ['submit-button', 'submit'],
  ]) {
    const tag = new RegExp(`<button[^>]*\\sid="${id}"[^>]*>`, 'u').exec(
      html,
    )?.[0];
    assert.deepEqual(
      [...(tag ?? '').matchAll(/\stype="([^"]*)"/gu)].map((match) => match[1]),
      [type],
      id,
    );
  }
});

test('input and select error states are distinguishable without colour', async () => {
  const { context, page } = await statesPage();
  try {
    for (const [valid, invalid] of [
      ['#valid-email', '#invalid-email'],
      ['#valid-select', '#invalid-select'],
    ]) {
      const width = (selector) =>
        page
          .locator(selector)
          .evaluate((element) =>
            Number.parseFloat(
              globalThis.getComputedStyle(element).borderTopWidth,
            ),
          );
      assert.ok(
        (await width(invalid)) > (await width(valid)),
        `${invalid} has a heavier border, not only a different colour`,
      );
      assert.equal(
        await page.locator(invalid).getAttribute('aria-invalid'),
        'true',
      );
      assert.equal(
        await page.locator(valid).getAttribute('aria-invalid'),
        null,
      );
    }

    // The error message carries an icon beside its text.
    const row = page.locator('.field__error-row');
    assert.equal(await row.locator('svg.icon').count(), 1);
    assert.equal(
      await row.locator('svg.icon').getAttribute('aria-hidden'),
      'true',
    );
    assert.ok((await row.locator('svg.icon').boundingBox()).width > 0);
    assert.equal(
      await row.locator('[role="alert"]').textContent(),
      'Enter a valid email address.',
    );
    assert.equal(await page.locator('.field__error-row').count(), 1);

    for (const selector of ['#valid-email', '#valid-select']) {
      assert.ok((await page.locator(selector).boundingBox()).height >= 44);
    }
  } finally {
    await context.close();
  }
});

test('cards rest on shadow-1 and only an interactive card rises to shadow-2 on hover', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { context, page } = await statesPage({ colorScheme });
    try {
      // E11.5-11a (founder-authorised rewrite, 2026-10-26): every elevated
      // surface adds --edge, transparent in light and a 1px edge in dark.
      const shadow1 = await resolvedValue(
        page,
        'boxShadow',
        'var(--shadow-1), var(--edge)',
      );
      const shadow2 = await resolvedValue(
        page,
        'boxShadow',
        'var(--shadow-2), var(--edge)',
      );
      assert.notEqual(shadow1, shadow2);
      assert.equal(
        shadowColors(shadow1).at(-1),
        colorScheme === 'dark'
          ? 'rgba(240, 240, 238, 0.1)'
          : 'rgba(0, 0, 0, 0)',
      );
      for (const selector of ['#static-card', '#interactive-card']) {
        assert.equal(
          (await computed(page, selector, ['boxShadow'])).boxShadow,
          shadow1,
          `${selector} at rest in ${colorScheme}`,
        );
      }
      await page.locator('#static-card').hover();
      assert.equal(
        (await computed(page, '#static-card', ['boxShadow'])).boxShadow,
        shadow1,
      );
      await page.locator('#interactive-card').hover();
      assert.equal(
        (await computed(page, '#interactive-card', ['boxShadow'])).boxShadow,
        shadow2,
      );
    } finally {
      await context.close();
    }
  }
});

test('the pill is coral-tint, the badge is coral, and both set figures tabular', async () => {
  const { context, page } = await statesPage();
  try {
    const pill = await computed(page, '#pill', [
      'backgroundColor',
      'fontVariantNumeric',
    ]);
    const badge = await computed(page, '#badge', [
      'backgroundColor',
      'fontFamily',
      'fontVariantNumeric',
    ]);
    assert.equal(
      pill.backgroundColor,
      await resolvedToken(page, 'backgroundColor', '--coral-tint'),
    );
    assert.equal(
      badge.backgroundColor,
      await resolvedToken(page, 'backgroundColor', '--coral'),
    );
    assert.equal(pill.fontVariantNumeric, 'tabular-nums');
    assert.equal(badge.fontVariantNumeric, 'tabular-nums');
    assert.match(badge.fontFamily, /^"JetBrains Mono"/u);
  } finally {
    await context.close();
  }
});

test('the accordion summary meets the tap minimum and its chevron turns when open', async () => {
  const { context, page } = await statesPage();
  try {
    const summary = page.locator('#accordion summary');
    assert.ok((await summary.boundingBox()).height >= 44);
    const chevron = page.locator('#accordion svg.icon');
    assert.equal(await chevron.getAttribute('aria-hidden'), 'true');
    const transform = () =>
      chevron.evaluate(
        (element) => globalThis.getComputedStyle(element).transform,
      );
    assert.equal(await transform(), 'none');
    await summary.press('Enter');
    assert.equal(await page.locator('#accordion').getAttribute('open'), '');
    assert.notEqual(await transform(), 'none');
  } finally {
    await context.close();
  }
});

test('Container caps content at --container-max with gutters, and Section headings sit left', async () => {
  for (const [width, gutter, expected] of [
    [320, 16, 288],
    [768, 32, 704],
    [1920, null, 1200],
  ]) {
    const { context, page } = await statesPage({
      viewport: { width, height: 900 },
    });
    try {
      const box = await page
        .locator('#default-section [data-design-container]')
        .boundingBox();
      assert.equal(Math.round(box.width), expected, `${width}px`);
      if (gutter !== null) assert.equal(Math.round(box.x), gutter);
      else assert.equal(Math.round(box.x), (width - expected) / 2);
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth,
        ),
        width,
      );
      const heading = await computed(
        page,
        '#default-section .section__heading',
        ['textAlign'],
      );
      assert.equal(heading.textAlign, 'start');
      const headingBox = await page.locator('#default-heading').boundingBox();
      assert.equal(Math.round(headingBox.x), Math.round(box.x));
    } finally {
      await context.close();
    }
  }
});

// E11.5-11a: the wireframe component sheet. Each primitive is measured in
// the states a visitor can put it in, at the large and small widths, in both
// themes, against the sheet's stated dimensions (1px tolerance).
async function sheetPage(options = {}) {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 2400 },
    ...options,
  });
  const page = await context.newPage();
  await page.goto(`${browserOrigin}/sheet`);
  return { context, page };
}

function box(page, selector) {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  });
}

function near(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) <= 1,
    `${message}: ${actual} is not ${expected}`,
  );
}

async function keyboardFocus(page, selector) {
  // Tab from the start until the element holds keyboard focus, so the
  // :focus-visible state is the one a keyboard user sees.
  await page.locator('body').evaluate((body) => body.focus());
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press('Tab');
    if (
      await page
        .locator(selector)
        .evaluate(
          (element) =>
            element === globalThis.document.activeElement &&
            element.matches(':focus-visible'),
        )
    )
      return;
  }
  throw new Error(`${selector} never took keyboard focus`);
}

const themes = ['light', 'dark'];

test('the primary button matches the sheet in every state and size, with the ink label in both themes', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await sheetPage({ colorScheme });
    try {
      const coral = await resolvedToken(page, 'backgroundColor', '--coral');
      const rest = await computed(page, '#primary', [
        'backgroundColor',
        'color',
        'fontSize',
        'fontWeight',
        'lineHeight',
        'paddingLeft',
        'paddingRight',
        'borderTopLeftRadius',
        'boxShadow',
      ]);
      assert.deepEqual(
        { ...rest, backgroundColor: rest.backgroundColor === coral },
        {
          backgroundColor: true,
          color: 'rgb(16, 16, 20)',
          fontSize: '16px',
          fontWeight: '600',
          lineHeight: '24px',
          paddingLeft: '24px',
          paddingRight: '24px',
          borderTopLeftRadius: '8px',
          boxShadow: 'rgba(16, 16, 20, 0.14) 0px 1px 2px 0px',
        },
        colorScheme,
      );
      near((await box(page, '#primary')).height, 48, 'primary height');

      await page.locator('#primary').hover();
      assert.equal(
        (await computed(page, '#primary', ['boxShadow'])).boxShadow,
        await resolvedValue(
          page,
          'boxShadow',
          'var(--overlay-hover), var(--shadow-1)',
        ),
      );
      await page.mouse.down();
      const active = await computed(page, '#primary', [
        'backgroundColor',
        'boxShadow',
      ]);
      assert.equal(active.backgroundColor, coral);
      assert.equal(
        active.boxShadow,
        'rgba(16, 16, 20, 0.16) 0px 0px 0px 100px inset',
      );
      await page.mouse.up();
      await page.mouse.move(0, 0);

      await keyboardFocus(page, '#primary');
      assert.deepEqual(
        await computed(page, '#primary', [
          'outlineStyle',
          'outlineWidth',
          'outlineOffset',
          'outlineColor',
        ]),
        {
          outlineStyle: 'solid',
          outlineWidth: '2px',
          outlineOffset: '2px',
          outlineColor: coral,
        },
      );

      const disabled = await computed(page, '#primary-disabled', [
        'backgroundColor',
        'color',
        'boxShadow',
      ]);
      assert.deepEqual(disabled, {
        backgroundColor: await resolvedToken(
          page,
          'backgroundColor',
          '--coral-tint',
        ),
        color: await resolvedToken(page, 'color', '--ink-600'),
        boxShadow: 'none',
      });

      for (const [selector, height, padding, size] of [
        ['#primary-h44', 44, '20px', ['16px', '24px']],
        ['#primary-xs', 44, '12px', ['14px', '20px']],
      ]) {
        near((await box(page, selector)).height, height, selector);
        const style = await computed(page, selector, [
          'paddingLeft',
          'fontSize',
          'lineHeight',
          'color',
        ]);
        assert.equal(style.paddingLeft, padding, selector);
        assert.deepEqual([style.fontSize, style.lineHeight], size, selector);
        assert.equal(style.color, 'rgb(16, 16, 20)', selector);
      }
      near(
        (await box(page, '#primary-full')).width,
        (await box(page, '#full-parent')).width,
        'full width',
      );
    } finally {
      await context.close();
    }
  }
});

test('the secondary button matches the sheet in every state, and is 44px with 14/20 text below 48rem', async () => {
  for (const colorScheme of themes) {
    for (const [width, height, padding, font] of [
      [1440, 48, '20px', ['16px', '24px']],
      [767, 44, '16px', ['14px', '20px']],
      [390, 44, '16px', ['14px', '20px']],
    ]) {
      const { context, page } = await sheetPage({
        colorScheme,
        viewport: { width, height: 2400 },
      });
      try {
        near((await box(page, '#secondary')).height, height, `${width}`);
        const rest = await computed(page, '#secondary', [
          'backgroundColor',
          'color',
          'paddingLeft',
          'fontSize',
          'lineHeight',
          'boxShadow',
        ]);
        assert.equal(rest.paddingLeft, padding);
        assert.deepEqual([rest.fontSize, rest.lineHeight], font);
        assert.equal(
          rest.backgroundColor,
          await resolvedToken(page, 'backgroundColor', '--surface'),
        );
        assert.equal(rest.color, await resolvedToken(page, 'color', '--ink'));
        assert.equal(
          rest.boxShadow,
          await resolvedValue(
            page,
            'boxShadow',
            'var(--inset-line), var(--shadow-1)',
          ),
        );
        assert.match(rest.boxShadow, /0px 0px 0px 1px inset/u);

        await page.locator('#secondary').hover();
        assert.equal(
          (await computed(page, '#secondary', ['boxShadow'])).boxShadow,
          await resolvedValue(
            page,
            'boxShadow',
            'var(--inset-strong), var(--shadow-2)',
          ),
        );
        await page.mouse.down();
        assert.equal(
          (await computed(page, '#secondary', ['boxShadow'])).boxShadow,
          await resolvedToken(page, 'boxShadow', '--inset-strong'),
        );
        await page.mouse.up();
        await page.mouse.move(0, 0);

        await keyboardFocus(page, '#secondary');
        const focus = await computed(page, '#secondary', [
          'outlineWidth',
          'outlineOffset',
          'outlineColor',
        ]);
        assert.deepEqual(focus, {
          outlineWidth: '2px',
          outlineOffset: '2px',
          outlineColor: await resolvedToken(page, 'color', '--coral'),
        });

        const disabled = await computed(page, '#secondary-disabled', [
          'color',
          'boxShadow',
        ]);
        assert.equal(
          disabled.color,
          await resolvedToken(page, 'color', '--ink-300'),
        );
        assert.equal(
          disabled.boxShadow,
          await resolvedToken(page, 'boxShadow', '--inset-line'),
        );
      } finally {
        await context.close();
      }
    }
  }
});

test('the on-midnight button and the text links match the sheet, on paper and on midnight', async () => {
  for (const colorScheme of themes) {
    for (const width of [1440, 390]) {
      const { context, page } = await sheetPage({
        colorScheme,
        viewport: { width, height: 2400 },
      });
      try {
        const midnight = await resolvedToken(
          page,
          'backgroundColor',
          '--midnight',
        );
        near((await box(page, '#sheet-on-midnight')).height, 48, 'height');
        const rest = await computed(page, '#sheet-on-midnight', [
          'backgroundColor',
          'color',
          'paddingLeft',
          'boxShadow',
        ]);
        assert.deepEqual(rest, {
          backgroundColor: 'rgba(0, 0, 0, 0)',
          color: await resolvedToken(page, 'color', '--on-midnight'),
          paddingLeft: '20px',
          boxShadow: 'rgba(250, 250, 250, 0.45) 0px 0px 0px 1px inset',
        });
        await page.locator('#sheet-on-midnight').hover();
        const hover = await computed(page, '#sheet-on-midnight', [
          'backgroundColor',
          'color',
        ]);
        assert.equal(hover.backgroundColor, 'rgba(250, 250, 250, 0.08)');
        assert.ok(
          contrastRatio(
            hover.color,
            composite(hover.backgroundColor, midnight),
          ) >= 4.5,
        );
        await page.mouse.down();
        assert.equal(
          (await computed(page, '#sheet-on-midnight', ['backgroundColor']))
            .backgroundColor,
          'rgba(250, 250, 250, 0.14)',
        );
        await page.mouse.up();
        await page.mouse.move(0, 0);
        await keyboardFocus(page, '#sheet-on-midnight');
        const coralLift = await resolvedToken(page, 'color', '--coral-lift');
        assert.equal(
          (await computed(page, '#sheet-on-midnight', ['outlineColor']))
            .outlineColor,
          coralLift,
        );
        assert.ok(contrastRatio(coralLift, midnight) >= 3);
        assert.deepEqual(
          await computed(page, '#sheet-on-midnight-disabled', [
            'color',
            'boxShadow',
          ]),
          {
            color: 'rgba(250, 250, 250, 0.45)',
            boxShadow: 'rgba(250, 250, 250, 0.2) 0px 0px 0px 1px inset',
          },
        );

        const link = await computed(page, '#text-link', [
          'color',
          'fontWeight',
          'textDecorationLine',
          'textDecorationColor',
          'textDecorationThickness',
          'textUnderlineOffset',
          'paddingTop',
          'paddingBottom',
        ]);
        assert.deepEqual(link, {
          color: await resolvedToken(page, 'color', '--ink'),
          fontWeight: '500',
          textDecorationLine: 'underline',
          textDecorationColor: await resolvedToken(page, 'color', '--coral'),
          textDecorationThickness: '2px',
          textUnderlineOffset: '3px',
          paddingTop: width < 768 ? '12px' : '0px',
          paddingBottom: width < 768 ? '12px' : '0px',
        });
        // Below 48rem the 12px vertical padding gives a 44px hit area.
        if (width < 768)
          assert.ok(
            (await box(page, '#text-link')).height >= 44,
            'link hit area',
          );
        const midnightLink = await computed(page, '#text-link-midnight', [
          'color',
          'textDecorationColor',
        ]);
        assert.deepEqual(midnightLink, {
          color: await resolvedToken(page, 'color', '--on-midnight'),
          textDecorationColor: coralLift,
        });
        await keyboardFocus(page, '#text-link');
        assert.deepEqual(
          await computed(page, '#text-link', ['outlineWidth', 'outlineColor']),
          {
            outlineWidth: '2px',
            outlineColor: await resolvedToken(page, 'color', '--coral'),
          },
        );
      } finally {
        await context.close();
      }
    }
  }
});

test('the input, label, hint and error match the sheet in every state', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await sheetPage({ colorScheme });
    try {
      const field = await resolvedToken(page, 'color', '--ink-600');
      const input = await computed(page, '#sheet-email', [
        'borderTopWidth',
        'borderTopColor',
        'borderTopLeftRadius',
        'paddingLeft',
        'fontSize',
        'lineHeight',
      ]);
      assert.deepEqual(input, {
        borderTopWidth: '1px',
        borderTopColor: field,
        borderTopLeftRadius: '8px',
        paddingLeft: '16px',
        fontSize: '16px',
        lineHeight: '24px',
      });
      near((await box(page, '#sheet-email')).height, 48, 'field height');
      // The placeholder is ink-600 in both themes (founder-authorised
      // 2026-10-26); in dark that is the drawn #A0A0A8.
      const placeholder = await page
        .locator('#sheet-email')
        .evaluate(
          (element) =>
            globalThis.getComputedStyle(element, '::placeholder').color,
        );
      assert.equal(placeholder, field);
      if (colorScheme === 'dark') assert.equal(field, 'rgb(160, 160, 168)');
      const surface = await resolvedToken(page, 'backgroundColor', '--surface');
      assert.ok(contrastRatio(placeholder, surface) >= 4.5, 'placeholder');
      assert.ok(contrastRatio(field, surface) >= 3, 'field boundary');

      const label = await computed(page, '#field .field__label', [
        'fontSize',
        'lineHeight',
        'fontWeight',
      ]);
      assert.deepEqual(label, {
        fontSize: '14px',
        lineHeight: '20px',
        fontWeight: '600',
      });
      const hint = await computed(page, '#sheet-email-hint', [
        'fontSize',
        'lineHeight',
        'color',
      ]);
      assert.deepEqual(hint, {
        fontSize: '14px',
        lineHeight: '20px',
        color: field,
      });
      const labelBox = await box(page, '#field .field__label');
      const hintBox = await box(page, '#sheet-email-hint');
      const inputBox = await box(page, '#sheet-email');
      near(hintBox.top - labelBox.bottom, 4, 'hint 4px below the label');
      near(inputBox.top - hintBox.bottom, 8, 'field 8px below the hint');

      await page.locator('#sheet-email').hover();
      assert.equal(
        (await computed(page, '#sheet-email', ['borderTopColor']))
          .borderTopColor,
        await resolvedToken(page, 'color', '--ink'),
      );
      await page.mouse.move(0, 0);
      await keyboardFocus(page, '#sheet-email');
      const focus = await computed(page, '#sheet-email', [
        'borderTopColor',
        'boxShadow',
        'outlineStyle',
        'outlineWidth',
        'outlineColor',
      ]);
      assert.deepEqual(focus, {
        borderTopColor: await resolvedToken(page, 'color', '--coral'),
        boxShadow: await resolvedToken(page, 'boxShadow', '--ring-focus'),
        outlineStyle: 'solid',
        outlineWidth: '2px',
        outlineColor: 'rgba(0, 0, 0, 0)',
      });
      assert.match(
        focus.boxShadow,
        /^rgb\([^)]*\) 0px 0px 0px 2px, rgb\([^)]*\) 0px 0px 0px 4px$/u,
      );

      const error = await computed(page, '#sheet-error', [
        'borderTopWidth',
        'borderTopColor',
        'paddingLeft',
      ]);
      assert.deepEqual(error, {
        borderTopWidth: '2px',
        borderTopColor: await resolvedToken(page, 'color', '--error'),
        paddingLeft: '15px',
      });
      const errorBox = await box(page, '#field-error .field__error-row');
      near(
        errorBox.top - (await box(page, '#sheet-error')).bottom,
        8,
        'message 8px below the field',
      );
      const icon = await computed(page, '#field-error .field__error-row svg', [
        'width',
        'height',
        'color',
      ]);
      assert.deepEqual(icon, {
        width: '20px',
        height: '20px',
        color: await resolvedToken(page, 'color', '--error'),
      });
      assert.equal(
        await page.locator('#field-error .field__error-row svg circle').count(),
        1,
        'the alert-circle icon',
      );
      const message = await computed(page, '#sheet-error-message', [
        'fontSize',
        'lineHeight',
        'fontWeight',
        'color',
      ]);
      assert.deepEqual(message, {
        fontSize: '14px',
        lineHeight: '20px',
        fontWeight: '600',
        color: await resolvedToken(page, 'color', '--error-text'),
      });
      assert.equal(
        message.color,
        colorScheme === 'dark' ? 'rgb(240, 240, 238)' : 'rgb(192, 57, 43)',
      );
      assert.ok(contrastRatio(message.color, surface) >= 4.5, 'error text');
      assert.deepEqual(
        (await page.locator('#sheet-error').getAttribute('aria-describedby'))
          .split(' ')
          .sort(),
        ['sheet-error-hint', 'sheet-error-message'],
      );

      const disabled = await computed(page, '#sheet-input-disabled', [
        'backgroundColor',
        'borderTopColor',
      ]);
      assert.deepEqual(disabled, {
        backgroundColor: await resolvedToken(
          page,
          'backgroundColor',
          '--paper',
        ),
        borderTopColor: await resolvedToken(page, 'color', '--line'),
      });
      assert.equal(
        await page.locator('#sheet-input-disabled').isDisabled(),
        true,
      );
    } finally {
      await context.close();
    }
  }
});

test('the checkbox is 20px, never pre-ticked, ticks to ink with a paper check, and has a 44px target', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await sheetPage({ colorScheme });
    try {
      const checkbox = page.locator('#sheet-check');
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(await checkbox.getAttribute('checked'), null);
      const drawn = '.checkbox:has(#sheet-check) .checkbox__box';
      const boxBox = await box(page, drawn);
      near(boxBox.width, 20, 'box width');
      near(boxBox.height, 20, 'box height');
      const rest = await computed(page, drawn, [
        'borderTopWidth',
        'borderTopColor',
        'borderTopLeftRadius',
        'backgroundColor',
      ]);
      // Chromium snaps a 1.5px border to whole pixels, so the box is checked
      // against the token as declared and as the engine renders it.
      assert.equal(
        await page.evaluate(() =>
          globalThis
            .getComputedStyle(globalThis.document.documentElement)
            .getPropertyValue('--border-check')
            .trim(),
        ),
        '1.5px',
      );
      assert.deepEqual(rest, {
        borderTopWidth: await resolvedValue(
          page,
          'borderTopWidth',
          'var(--border-check)',
        ),
        borderTopColor: await resolvedToken(page, 'color', '--field'),
        borderTopLeftRadius: '4px',
        backgroundColor: await resolvedToken(
          page,
          'backgroundColor',
          '--surface',
        ),
      });
      // The native input is a 44px target centred on the drawn box.
      const target = await box(page, '#sheet-check');
      near(target.width, 44, 'target width');
      near(target.height, 44, 'target height');
      near(target.left + 22, boxBox.left + 10, 'target centred across');
      near(target.top + 22, boxBox.top + 10, 'target centred down');

      const text = await box(
        page,
        '.checkbox:has(#sheet-check) .checkbox__text',
      );
      near(text.left - boxBox.right, 12, 'label 12px from the box');
      assert.deepEqual(
        await computed(page, '.checkbox:has(#sheet-check)', [
          'fontSize',
          'lineHeight',
          'color',
        ]),
        {
          fontSize: '14px',
          lineHeight: '20px',
          color: await resolvedToken(page, 'color', '--ink-600'),
        },
      );
      const optional = '.checkbox:has(#sheet-check) .checkbox__optional';
      assert.equal(
        (await page.locator(optional).textContent()).trim(),
        primitivesCopy.optional,
      );
      assert.deepEqual(
        await computed(page, optional, [
          'paddingLeft',
          'paddingRight',
          'marginRight',
          'borderTopLeftRadius',
          'boxShadow',
          'fontSize',
          'lineHeight',
          'fontWeight',
        ]),
        {
          paddingLeft: '8px',
          paddingRight: '8px',
          marginRight: '6px',
          borderTopLeftRadius: '999px',
          boxShadow: await resolvedToken(page, 'boxShadow', '--inset-line'),
          fontSize: '13px',
          lineHeight: '18px',
          fontWeight: '600',
        },
      );

      await checkbox.hover();
      assert.equal(
        (await computed(page, drawn, ['borderTopColor'])).borderTopColor,
        await resolvedToken(page, 'color', '--ink'),
      );
      await checkbox.click();
      assert.equal(await checkbox.isChecked(), true);
      const ink = await resolvedToken(page, 'backgroundColor', '--ink');
      const ticked = await computed(page, drawn, [
        'backgroundColor',
        'borderTopColor',
        'color',
      ]);
      assert.deepEqual(ticked, {
        backgroundColor: ink,
        borderTopColor: ink,
        color: await resolvedToken(page, 'color', '--paper'),
      });
      assert.ok(contrastRatio(ticked.color, ink) >= 3, 'check mark');
      await page.mouse.move(0, 0);
      await keyboardFocus(page, '#sheet-check');
      assert.deepEqual(
        await computed(page, drawn, [
          'outlineWidth',
          'outlineOffset',
          'outlineColor',
        ]),
        {
          outlineWidth: '2px',
          outlineOffset: '2px',
          outlineColor: await resolvedToken(page, 'color', '--coral'),
        },
      );
      await page.keyboard.press('Space');
      assert.equal(await checkbox.isChecked(), false, 'keyboard unticks');
      assert.equal(
        (
          await computed(
            page,
            '.checkbox:has(#sheet-check-disabled) .checkbox__box',
            ['borderTopColor'],
          )
        ).borderTopColor,
        await resolvedToken(page, 'color', '--ink-300'),
      );
      assert.equal(
        await page.locator('#sheet-check-disabled').isDisabled(),
        true,
      );
    } finally {
      await context.close();
    }
  }
});

test('the pills, step badge, card and icon tile match the sheet in both themes', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await sheetPage({ colorScheme });
    try {
      const reward = await computed(page, '#reward-pill', [
        'paddingTop',
        'paddingLeft',
        'borderTopLeftRadius',
        'backgroundColor',
        'color',
        'fontSize',
        'lineHeight',
        'fontWeight',
        'columnGap',
      ]);
      assert.deepEqual(reward, {
        paddingTop: '4px',
        paddingLeft: '12px',
        borderTopLeftRadius: '999px',
        backgroundColor: await resolvedToken(
          page,
          'backgroundColor',
          '--coral-tint',
        ),
        color: await resolvedToken(page, 'color', '--ink'),
        fontSize: '13px',
        lineHeight: '18px',
        fontWeight: '600',
        columnGap: '6px',
      });
      const surface = await resolvedToken(page, 'backgroundColor', '--surface');
      assert.ok(
        contrastRatio(
          reward.color,
          composite(reward.backgroundColor, surface),
        ) >= 4.5,
        'reward pill text',
      );
      near((await box(page, '#reward-pill svg')).width, 16, 'pill icon');

      const coral = await computed(page, '#coral-pill', [
        'backgroundColor',
        'color',
        'fontFamily',
      ]);
      assert.equal(
        coral.backgroundColor,
        await resolvedToken(page, 'backgroundColor', '--coral'),
      );
      assert.equal(coral.color, 'rgb(16, 16, 20)');
      assert.doesNotMatch(coral.fontFamily, /Mono/u);
      assert.ok(contrastRatio(coral.color, coral.backgroundColor) >= 4.5);
      const figure = await computed(page, '#coral-pill .tabular-figure', [
        'fontFamily',
        'fontVariantNumeric',
      ]);
      assert.match(figure.fontFamily, /^"JetBrains Mono"/u);
      assert.equal(figure.fontVariantNumeric, 'tabular-nums');

      const step = await box(page, '#step-badge');
      near(step.width, 24, 'step width');
      near(step.height, 24, 'step height');
      const stepStyle = await computed(page, '#step-badge', [
        'backgroundColor',
        'color',
        'fontFamily',
        'fontSize',
        'lineHeight',
        'fontWeight',
      ]);
      assert.equal(
        stepStyle.backgroundColor,
        await resolvedToken(page, 'backgroundColor', '--ink'),
      );
      assert.equal(
        stepStyle.color,
        await resolvedToken(page, 'color', '--paper'),
      );
      assert.match(stepStyle.fontFamily, /^"JetBrains Mono"/u);
      assert.deepEqual(
        [stepStyle.fontSize, stepStyle.lineHeight, stepStyle.fontWeight],
        ['13px', '18px', '600'],
      );
      assert.ok(
        contrastRatio(stepStyle.color, stepStyle.backgroundColor) >= 4.5,
      );

      const card = await computed(page, '#sheet-card', [
        'backgroundColor',
        'borderTopLeftRadius',
        'paddingTop',
        'paddingLeft',
        'boxShadow',
      ]);
      assert.deepEqual(card, {
        backgroundColor: surface,
        borderTopLeftRadius: '12px',
        paddingTop: '24px',
        paddingLeft: '24px',
        boxShadow: await resolvedValue(
          page,
          'boxShadow',
          'var(--shadow-1), var(--edge)',
        ),
      });
      await page.locator('#sheet-card-link').hover();
      assert.equal(
        (await computed(page, '#sheet-card-link', ['boxShadow'])).boxShadow,
        await resolvedValue(page, 'boxShadow', 'var(--shadow-2), var(--edge)'),
      );
      await page.mouse.move(0, 0);

      const tile = await box(page, '#sheet-tile');
      near(tile.width, 40, 'tile width');
      near(tile.height, 40, 'tile height');
      assert.deepEqual(
        await computed(page, '#sheet-tile', [
          'backgroundColor',
          'borderTopLeftRadius',
        ]),
        {
          backgroundColor: await resolvedToken(
            page,
            'backgroundColor',
            '--paper',
          ),
          borderTopLeftRadius: '8px',
        },
      );
      assert.equal(
        await page.locator('#sheet-tile').getAttribute('aria-hidden'),
        'true',
      );
      near((await box(page, '#sheet-tile svg')).width, 20, 'tile icon');
    } finally {
      await context.close();
    }
  }
});

test('the FAQ item is an unboxed native disclosure with dividers, a 64px summary and a turning 20px chevron', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await sheetPage({ colorScheme });
    try {
      const summary = '#faq-closed summary';
      near((await box(page, summary)).height, 64, 'summary height');
      assert.deepEqual(
        await computed(page, summary, [
          'paddingTop',
          'paddingBottom',
          'fontSize',
          'lineHeight',
          'fontWeight',
        ]),
        {
          paddingTop: '20px',
          paddingBottom: '20px',
          fontSize: '16px',
          lineHeight: '24px',
          fontWeight: '600',
        },
      );
      const chevron = await computed(page, '#faq-closed svg', [
        'width',
        'color',
        'transform',
        'transitionProperty',
      ]);
      assert.deepEqual(chevron, {
        width: '20px',
        color: await resolvedToken(page, 'color', '--ink-600'),
        transform: 'none',
        transitionProperty: 'none',
      });
      assert.equal(
        (await computed(page, '#faq-open svg', ['transform'])).transform,
        'matrix(-1, 0, 0, -1, 0, 0)',
      );
      await page.locator(summary).click();
      assert.equal(await page.locator('#faq-closed').getAttribute('open'), '');
      await page.locator(summary).click();
      assert.equal(
        await page.locator('#faq-closed').getAttribute('open'),
        null,
      );

      const answer = await page
        .locator('#faq-open .accordion__content')
        .evaluate((element) => {
          const style = globalThis.getComputedStyle(element);
          const probe = globalThis.document.createElement('div');
          probe.style.maxWidth = '68ch';
          element.append(probe);
          const measure = globalThis.getComputedStyle(probe).maxWidth;
          probe.remove();
          return {
            color: style.color,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            maxWidth: style.maxWidth,
            measure,
            paddingBottom: style.paddingBottom,
          };
        });
      assert.equal(
        answer.color,
        await resolvedToken(page, 'color', '--ink-600'),
      );
      assert.deepEqual(
        [answer.fontSize, answer.lineHeight, answer.paddingBottom],
        ['16px', '24px', '24px'],
      );
      assert.equal(answer.maxWidth, answer.measure);

      for (const selector of ['#faq-closed', '#faq-open']) {
        assert.equal(
          (await computed(page, selector, ['backgroundColor', 'boxShadow']))
            .backgroundColor,
          'rgba(0, 0, 0, 0)',
        );
      }
      assert.equal(
        (await computed(page, '#faq-closed', ['borderTopWidth']))
          .borderTopWidth,
        '0px',
      );
      assert.deepEqual(
        await computed(page, '#faq-open', ['borderTopWidth', 'borderTopColor']),
        {
          borderTopWidth: '1px',
          borderTopColor: await resolvedToken(page, 'color', '--line'),
        },
      );
      await keyboardFocus(page, summary);
      assert.equal(
        (await computed(page, summary, ['outlineColor'])).outlineColor,
        await resolvedToken(page, 'color', '--coral'),
      );
    } finally {
      await context.close();
    }
  }
});

test('the theme toggle is a 44px bordered icon button offering the other theme, and the stars render at 12 × 18 and 16 × 24', async () => {
  for (const colorScheme of themes) {
    const { context, page } = await sheetPage({ colorScheme });
    try {
      const button = 'valstara-theme-toggle button';
      await page.waitForFunction(
        (selector) =>
          globalThis.document.querySelector(selector)?.disabled === false,
        button,
      );
      const toggle = await box(page, button);
      near(toggle.width, 44, 'toggle width');
      near(toggle.height, 44, 'toggle height');
      assert.deepEqual(
        await computed(page, button, [
          'borderTopWidth',
          'borderTopColor',
          'borderTopLeftRadius',
          'backgroundColor',
        ]),
        {
          borderTopWidth: '1px',
          borderTopColor: await resolvedToken(page, 'color', '--line'),
          borderTopLeftRadius: '8px',
          backgroundColor: await resolvedToken(
            page,
            'backgroundColor',
            '--surface',
          ),
        },
      );
      const visibleIcon = await page
        .locator(`${button} svg`)
        .evaluateAll((icons) =>
          icons
            .filter((icon) => icon.getClientRects().length > 0)
            .map((icon) => ({
              name: [...icon.classList].find((name) =>
                /^icon--(?:moon|sun)$/u.test(name),
              ),
              width: icon.getBoundingClientRect().width,
            })),
        );
      assert.deepEqual(visibleIcon, [
        {
          name: colorScheme === 'dark' ? 'icon--sun' : 'icon--moon',
          width: 20,
        },
      ]);
      assert.equal(
        await page
          .getByRole('button', {
            name:
              colorScheme === 'dark'
                ? themeToggleCopy.useLight
                : themeToggleCopy.useDark,
          })
          .count(),
        1,
      );
      await keyboardFocus(page, button);
      assert.deepEqual(
        await computed(page, button, [
          'outlineWidth',
          'outlineOffset',
          'outlineColor',
        ]),
        {
          outlineWidth: '2px',
          outlineOffset: '2px',
          outlineColor: await resolvedToken(page, 'color', '--coral'),
        },
      );

      for (const [selector, width, height, token] of [
        ['#star-sm svg', 12, 18, '--coral'],
        ['#star-md svg', 16, 24, '--coral-lift'],
      ]) {
        const star = await box(page, selector);
        near(star.width, width, `${selector} width`);
        near(star.height, height, `${selector} height`);
        assert.equal(
          (await computed(page, selector, ['color'])).color,
          await resolvedToken(page, 'color', token),
        );
        assert.equal(
          await page.locator(selector).getAttribute('aria-hidden'),
          'true',
        );
        assert.equal(
          await page.locator(`${selector} path`).getAttribute('fill'),
          'currentColor',
        );
      }
    } finally {
      await context.close();
    }
  }
});
