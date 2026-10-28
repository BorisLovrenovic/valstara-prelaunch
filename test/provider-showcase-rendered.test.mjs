/* global getComputedStyle */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';
import axe from 'axe-core';
import providers from '../src/content/provider-showcase.json' with { type: 'json' };
import { bannerTone } from '../src/components/provider-banner.ts';
import { publishedPort } from './helpers/listen-port.mjs';
import {
  checkPageLayout,
  designWidths,
  designThemes,
} from '../scripts/design/layout-checks.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const execFileAsync = promisify(execFile);
const browserContainer = `valstara-provider-browser-${process.pid}`;
const image =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
let server;
let browserServer;
let browser;
let origin;

async function awaitOutput(processHandle, pattern, label) {
  let output = '';
  processHandle.stdout.on('data', (chunk) => {
    output += chunk;
  });
  processHandle.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const found = pattern.exec(output);
    if (found) return found;
    if (processHandle.exitCode !== null)
      throw new Error(`${label} exited: ${output}`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out: ${output}`);
}

before(async () => {
  await execFileAsync(
    process.execPath,
    [
      `${root}/node_modules/astro/bin/astro.mjs`,
      'build',
      '--root',
      'test/fixtures/provider-showcase',
      '--config',
      '../../../scripts/fixtures/provider-showcase.astro.config.mjs',
    ],
    { cwd: root },
  );
  server = spawn(
    process.execPath,
    [`${root}/scripts/fixtures/run-provider-showcase-server.mjs`],
    {
      cwd: root,
      env: { ...process.env, HOST: '0.0.0.0', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const port = (
    await awaitOutput(server, /local: http:\/\/localhost:(\d+)/u, 'fixture')
  )[1];
  origin = `http://host.docker.internal:${port}`;
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
      `${root}:/work:ro`,
      '--workdir',
      '/work',
      image,
      '/work/node_modules/.bin/playwright',
      'run-server',
      '--host',
      '0.0.0.0',
      '--port',
      '3000',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await awaitOutput(browserServer, /Listening on/u, 'browser');
  browser = await chromium.connect(
    `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`,
  );
});

after(async () => {
  await browser?.close();
  if (browserServer && browserServer.exitCode === null) {
    await execFileAsync('docker', ['stop', browserContainer]);
    await once(browserServer, 'exit');
  }
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
});

test('rail renders real logos, categories, alt text and only same-origin requests', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(origin);
  assert.equal(await page.locator('[data-provider-banner]').count(), 34);
  assert.deepEqual(
    // E11.5-11d (founder-authorised 2026-10-28): group labels are <h3>, under
    // the section's "What you'll find" <h2>.
    await page.locator('.provider-rail__category h3').allTextContents(),
    ['AI tools', 'Streaming and subscriptions', 'Software', 'In-game currency'],
  );
  assert.deepEqual(
    await page
      .locator('[data-provider-banner] img')
      .evaluateAll((images) => images.map((image) => image.alt)),
    providers.map((provider) => provider.name),
  );
  // E11.5-11d (founder-authorised 2026-10-28): the chip shows the provider's
  // name, and n8n, Microsoft 365 and AION2 have digits in theirs. Each
  // banner's own name is removed before checking that no figure remains.
  const figures = (banners) =>
    banners
      .map((banner) => ({
        name: banner.dataset.providerBanner,
        rest: banner.innerText.replaceAll(banner.dataset.providerBanner, ''),
      }))
      .filter(({ rest }) => /\d/u.test(rest))
      .map(({ name }) => name);
  // The rail ships no script; the check below is the test's own.
  assert.equal(await page.locator('script').count(), 0);
  await page.addScriptTag({
    content: `globalThis.bannerFigures = ${figures.toString()};`,
  });
  assert.deepEqual(
    await page
      .locator('[data-provider-banner]')
      .evaluateAll((banners) => globalThis.bannerFigures(banners)),
    [],
  );
  // A planted figure in a banner still fails the check.
  assert.deepEqual(
    await page.locator('[data-provider-banner]').evaluateAll((banners) => {
      const planted = banners[0].cloneNode(true);
      planted.append(
        Object.assign(globalThis.document.createElement('span'), {
          textContent: '€300',
        }),
      );
      banners[0].after(planted);
      const found = globalThis.bannerFigures([planted]);
      planted.remove();
      return found;
    }),
    [providers[0].name],
  );
  // E11.5-11d (founder-authorised 2026-10-28): each banner's tone is the
  // token its brand colour selects: white 13% on near-black, white 16% under
  // white text, else ink 10%.
  const tones = await page
    .locator('[data-provider-banner]')
    .evaluateAll((banners) => {
      const probe = globalThis.document.createElement('span');
      globalThis.document.body.append(probe);
      const token = (name) => {
        probe.style.backgroundColor = `var(--banner-tone-${name})`;
        return getComputedStyle(probe).backgroundColor;
      };
      const tokens = Object.fromEntries(
        ['dark', 'light', 'ink'].map((name) => [name, token(name)]),
      );
      probe.remove();
      return {
        tokens,
        banners: banners.map((banner) => ({
          name: banner.dataset.providerBanner,
          tone: getComputedStyle(banner.querySelector('.provider-banner__tone'))
            .backgroundColor,
        })),
      };
    });
  assert.equal(tones.banners.length, 34);
  assert.equal(new Set(Object.values(tones.tokens)).size, 3);
  for (const [index, banner] of tones.banners.entries()) {
    const provider = providers.find((entry) => entry.name === banner.name);
    assert.ok(provider, banner.name);
    assert.equal(
      banner.tone,
      tones.tokens[bannerTone(provider.brandColor)],
      `${index} ${banner.name}`,
    );
  }
  await page.addScriptTag({ content: axe.source });
  for (const theme of designThemes) {
    await page.emulateMedia({ colorScheme: theme });
    const contrast = await page.evaluate(() =>
      globalThis.axe.run('[data-provider-banner]', {
        runOnly: ['color-contrast'],
      }),
    );
    assert.deepEqual(contrast.violations, [], `${theme} banner contrast`);
  }
  assert.ok(
    requests.every((url) => new URL(url).origin === origin),
    requests.join('\n'),
  );
  await page.close();
});

test('mobile rail scrolls by keyboard, does not auto-advance, and fits every width and theme', async () => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await page.goto(origin);
  const track = page.locator('.provider-rail__track').first();
  await track.focus();
  const beforeScroll = await track.evaluate((element) => element.scrollLeft);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const afterScroll = await track.evaluate((element) => element.scrollLeft);
  assert.ok(afterScroll > beforeScroll);
  await page.waitForTimeout(350);
  assert.equal(
    await track.evaluate((element) => element.scrollLeft),
    afterScroll,
  );
  assert.equal(
    await track.evaluate((element) => getComputedStyle(element).overflowX),
    'auto',
  );
  await track.evaluate((element) => {
    element.scrollLeft = 0;
  });
  const box = await track.boundingBox();
  assert.ok(box);
  const cdp = await page.context().newCDPSession(page);
  const y = box.y + box.height / 2;
  const right = box.x + box.width * 0.8;
  const left = box.x + box.width * 0.2;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: right, y }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: left, y }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await page.waitForTimeout(350);
  assert.ok((await track.evaluate((element) => element.scrollLeft)) > 0);
  for (const width of designWidths) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of designThemes) {
      await page.emulateMedia({ colorScheme: theme });
      const issues = await checkPageLayout(page);
      assert.deepEqual(
        issues,
        [],
        `${width}px ${theme}: ${JSON.stringify(issues)}`,
      );
    }
  }
  await page.close();
});
