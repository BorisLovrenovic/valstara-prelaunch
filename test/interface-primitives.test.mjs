import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { chromium } from 'playwright';

const executeFile = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const componentsDirectory = join(projectRoot, 'src/components');
const fixtureRoot = join(projectRoot, 'test/fixtures/interface-primitives');
const fixtureConfig =
  '../../../scripts/fixtures/interface-primitives.astro.config.mjs';
const browserOrigin = 'http://host.docker.internal:43222';
const browserPort = 43_223;
const browserServerEndpoint = `ws://127.0.0.1:${browserPort}/`;
const browserContainer = `valstara-primitives-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';

let browser;
let browserServer;
let browserServerError;
let server;

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
      `127.0.0.1:${browserPort}:3000`,
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
      return;
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await globalThis.fetch('http://127.0.0.1:43222');
      if (response.ok) {
        return;
      }
    } catch {
      // The standalone fixture server has not started yet.
    }
    await new Promise((resolvePromise) =>
      globalThis.setTimeout(resolvePromise, 25),
    );
  }
  throw new Error('Interface primitive fixture server did not start.');
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
      env: { ...process.env, HOST: '0.0.0.0', PORT: '43222' },
      stdio: 'ignore',
    },
  );
  await waitForFixtureServer();
  await startBrowserServer();
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

test('all seven primitives are zero-JavaScript Astro components', async () => {
  const components = await componentSources();
  assert.deepEqual(components.map(({ name }) => name).sort(), [
    'accordion.astro',
    'button.astro',
    'card.astro',
    'field.astro',
    'input.astro',
    'pill.astro',
    'select.astro',
  ]);

  for (const { name, source } of components) {
    assert.doesNotMatch(source, /<script\b|client:/u, name);
    assert.match(source, /var\(--/u, name);
  }
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
