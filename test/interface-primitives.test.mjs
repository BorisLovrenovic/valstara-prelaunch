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
  // E11.5-03 adds the zero-JS Container and Section layout primitives.
  assert.deepEqual(components.map(({ name }) => name).sort(), [
    'accordion.astro',
    'button.astro',
    'card.astro',
    'container.astro',
    'field.astro',
    'icon.astro',
    'input.astro',
    'pill.astro',
    'section.astro',
    'select.astro',
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
        colors: [...element.querySelectorAll('path')].map((path) => [
          path.getAttribute('fill'),
          path.getAttribute('stroke'),
        ]),
      })),
    );
    // E11.5-03: the field error state adds the small alert icon and the
    // accordion its chevron, after the five registry icons.
    assert.equal(icons.length, 7);
    assert.deepEqual(
      icons.map((icon) => icon.width),
      ['16px', '24px', '40px', '24px', '24px', '16px', '24px'],
    );
    assert.deepEqual(
      icons.map((icon) => icon.height),
      icons.map((icon) => icon.width),
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
  const source = await readFile(
    join(componentsDirectory, 'icon.astro'),
    'utf8',
  );
  const path = /name === 'star'[\s\S]*?<path\s+d="([^"]+)"/u.exec(source)?.[1];
  assert.ok(path);
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) =>
    Number(match[0]),
  );
  assert.deepEqual(
    numbers,
    [
      12, 1.5, 12, 8, 13, 12, 19, 12, 13, 12, 12, 16, 12, 22.5, 12, 16, 11, 12,
      5, 12, 11, 12, 12, 8, 12, 1.5,
    ],
  );
  assert.equal((22.5 - 1.5) / (19 - 5), 1.5);
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
            outline: focusStyle.outlineColor,
            outlineStyle: focusStyle.outlineStyle,
            outlineWidth: focusStyle.outlineWidth,
          };
        }, backgroundSelector);
      assert.notEqual(colors.outlineStyle, 'none', selector);
      assert.notEqual(colors.outlineWidth, '0px', selector);
      assert.ok(
        contrastRatio(colors.outline, colors.background) >= 3,
        `${selector} in ${colorScheme}`,
      );

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

  assert.deepEqual(renderedThemes, [
    {
      accordion: {
        background: 'rgb(255, 255, 255)',
        color: 'rgb(16, 16, 20)',
        visible: true,
      },
      button: {
        background: 'rgb(232, 101, 74)',
        color: 'rgb(23, 23, 51)',
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
        color: 'rgb(23, 23, 51)',
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
        background: 'rgb(23, 23, 51)',
        color: 'rgb(240, 240, 238)',
        visible: true,
      },
      button: {
        background: 'rgb(255, 138, 102)',
        color: 'rgb(23, 23, 51)',
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
        background: 'rgb(253, 238, 233)',
        color: 'rgb(23, 23, 51)',
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
      const coralLift = await resolvedToken(
        page,
        'backgroundColor',
        '--coral-lift',
      );
      const shadow1 = await resolvedToken(page, 'boxShadow', '--shadow-1');

      const rest = await computed(page, '#primary', properties);
      assert.equal(rest.backgroundColor, coral, colorScheme);
      assert.equal(rest.boxShadow, 'none');

      await page.locator('#primary').hover();
      const hover = await computed(page, '#primary', properties);
      assert.equal(hover.backgroundColor, coralLift, colorScheme);
      assert.equal(hover.boxShadow, shadow1);

      await page.mouse.down();
      const active = await computed(page, '#primary', properties);
      assert.equal(active.backgroundColor, coral);
      assert.equal(active.boxShadow, 'none');
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
        await resolvedToken(page, 'backgroundColor', '--line'),
      );
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
      assert.ok(
        contrastRatio(hovered.color, hovered.backgroundColor) >= 4.5,
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
      const shadow1 = await resolvedToken(page, 'boxShadow', '--shadow-1');
      const shadow2 = await resolvedToken(page, 'boxShadow', '--shadow-2');
      assert.notEqual(shadow1, shadow2);
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
