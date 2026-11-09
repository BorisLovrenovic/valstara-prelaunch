// E11.5-11n: measures the final-design canvas's #catalogue and #how, so the
// rendered-page suite can compare the built page with the canvas box by box.
//
// The canvas runtime (support.js) is not in the snapshot, so this rebuilds
// the markup Main.dc.html's template produces — its providers() table, its
// catalogue and steps markup — on the snapshot's own valstara.css, with the
// site's self-hosted fonts, and measures it in the pinned Playwright browser
// at every final-design width in both themes. The annotation layer is not
// rendered. Boxes are [x, y, width, height] in CSS px, relative to the
// section's heading block (#catalogue) or the "How it works" heading block.
//
//   node test/fixtures/final-ui/measure-catalogue-geometry.mjs
//
// writes test/fixtures/final-ui/catalogue-geometry.json. The snapshot is
// pinned (docs/design/final-ui/SHA256SUMS), so the output only changes when
// the founder re-pins the canvas.
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { chromium } from 'playwright';
import { format, resolveConfig } from 'prettier';

import { publishedPort } from '../../helpers/listen-port.mjs';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const project = `${root}docs/design/final-ui/project`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
export const canvasWidths = [1440, 1024, 768, 390, 320];

function luminance(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  const [red, green, blue] = [value >> 16, (value >> 8) & 255, value & 255].map(
    (channel) => {
      const scaled = channel / 255;
      return scaled <= 0.03928
        ? scaled / 12.92
        : ((scaled + 0.055) / 1.055) ** 2.4;
    },
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

// The canvas's own table and its markup, as Main.dc.html renders them.
async function canvasMarkup(dark) {
  const main = await readFile(`${project}/Main.dc.html`, 'utf8');
  const table = /var P = (\[[\s\S]*?\]);\n/u.exec(main)[1];
  const groups = JSON.parse(table.replaceAll("'", '"'));
  const shapes = ['t1', 't2', 't3', 't4', 't5', 't6'];
  let position = 0;
  const catalogue = groups
    .map(([category, providers]) => {
      const banners = providers
        .map(([name, file, colour, kind, ratio, height]) => {
          const light = luminance(colour);
          const white = 1.05 / (light + 0.05) >= (light + 0.05) / 0.055;
          const tone = light < 0.03 ? 'dark' : white ? 'light' : 'ink';
          const chip =
            kind === 'w'
              ? `<img class="banner__logo banner__logo--word" src="/logos/${file}" width="${Math.round(ratio * height)}" height="${height}" alt="${name}" style="--lh: ${height}px">`
              : `<img class="banner__logo" src="/logos/${file}" width="${Math.round(ratio * height)}" height="${height}" alt=""><span class="banner__name">${name}</span>`;
          return `<li class="banner banner--${shapes[position++ % 6]}" data-name="${name}" style="background: ${colour}; color: var(--banner-${white ? 'white' : 'ink'}); --tone: var(--banner-tone-${tone}); --ring: var(--banner-ring-${white ? 'dark' : 'ink'})"><i class="banner__shape"></i><i class="banner__ring"></i><span class="banner__chip${name === 'CyberGhost' ? ' banner__chip--dark' : ''}">${chip}</span><span class="banner__cat">${category}</span></li>`;
        })
        .join('');
      return `<div class="catalogue__group"><h3 class="catalogue__label">${category}</h3><ul class="rail">${banners}</ul></div>`;
    })
    .join('');
  const step = (index, title, connector, optional) =>
    `<li class="step${optional ? ' step--optional' : ''}"><span class="step__tile"><span class="badge-step">${index}</span><svg class="icon"></svg></span>${connector}<p class="step__title">${title}</p></li>`;
  const how = [
    step(1, 'Join with your email', '<span class="step__connector"></span>'),
    step(
      2,
      'Confirm the link we send',
      '<span class="step__connector step__connector--dashed"></span>',
    ),
    step(3, 'Share your link, if you like', '', true),
  ].join('');
  return `<!doctype html><html><head><style>
@font-face { font-family: 'Instrument Sans'; font-weight: 400 700; src: url('/fonts/instrument-sans-latin-wght-normal.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-weight: 100 800; src: url('/fonts/jetbrains-mono-latin-wght-normal.woff2') format('woff2'); }
body { margin: 0; }
</style><link rel="stylesheet" href="/valstara.css"></head><body><div class="page${dark ? ' dark' : ''}"><main>
<section class="section" id="catalogue"><div class="wrap"><div class="section-head"><h2 class="t-h2">What you'll find</h2><p class="t-body">AI tools, subscriptions, software and in-game currency from confirmed launch providers.</p></div>${catalogue}</div></section>
<section class="section" id="how"><div class="wrap"><div class="section-head"><h2 class="t-h2">How it works</h2></div><div class="steps-panel"><ol class="steps">${how}</ol></div></div></section>
</main></div></body></html>`;
}

function measureCanvas() {
  const { document } = globalThis;
  const origin = (head) => head.getBoundingClientRect();
  const relative = (element, from) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return [
      rect.left - from.left,
      rect.top - from.top,
      rect.width,
      rect.height,
    ].map((value) => Math.round(value * 100) / 100);
  };
  const catalogueHead = origin(
    document.querySelector('#catalogue .section-head'),
  );
  const howHead = origin(document.querySelector('#how .section-head'));
  return {
    catalogue: {
      head: relative(
        document.querySelector('#catalogue .section-head'),
        catalogueHead,
      ),
      heading: relative(document.querySelector('#catalogue h2'), catalogueHead),
      line: relative(
        document.querySelector('#catalogue .section-head p'),
        catalogueHead,
      ),
      sectionEnd:
        document.querySelector('#catalogue').getBoundingClientRect().bottom -
        catalogueHead.top,
      groups: [...document.querySelectorAll('.catalogue__group')].map(
        (group) => ({
          box: relative(group, catalogueHead),
          label: relative(group.querySelector('h3'), catalogueHead),
          rail: relative(group.querySelector('.rail'), catalogueHead),
          banners: [...group.querySelectorAll('.banner')].map((banner) => {
            const own = banner.getBoundingClientRect();
            return {
              name: banner.dataset.name,
              box: relative(banner, catalogueHead),
              chip: relative(banner.querySelector('.banner__chip'), own),
              logo: relative(banner.querySelector('img'), own),
              label: relative(banner.querySelector('.banner__name'), own),
              category: relative(banner.querySelector('.banner__cat'), own),
              shape: relative(banner.querySelector('.banner__shape'), own),
              ring: relative(banner.querySelector('.banner__ring'), own),
            };
          }),
        }),
      ),
    },
    how: {
      head: relative(document.querySelector('#how .section-head'), howHead),
      panel: relative(document.querySelector('.steps-panel'), howHead),
      list: relative(document.querySelector('.steps'), howHead),
      steps: [...document.querySelectorAll('.step')].map((step) => ({
        box: relative(step, howHead),
        tile: relative(step.querySelector('.step__tile'), howHead),
        badge: relative(step.querySelector('.badge-step'), howHead),
        title: relative(step.querySelector('.step__title'), howHead),
        connector: relative(step.querySelector('.step__connector'), howHead),
      })),
    },
  };
}

async function main() {
  const container = `valstara-canvas-geometry-${process.pid}`;
  const server = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      container,
      '--publish',
      '127.0.0.1::3000',
      '--volume',
      `${root}:/work:ro`,
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
  server.stdout.on('data', (chunk) => (output += chunk));
  server.stderr.on('data', (chunk) => (output += chunk));
  const result = {
    source:
      'docs/design/final-ui/project/Main.dc.html (pin 1793367843-fe69) on valstara.css, measured by test/fixtures/final-ui/measure-catalogue-geometry.mjs',
    widths: {},
  };
  // The container is removed however the run ends, and the browser is only
  // reached once the published port accepts connections.
  let browser;
  try {
    while (!output.includes('Listening on')) {
      if (server.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
    browser = await chromium.connect(
      `ws://127.0.0.1:${await publishedPort(container, 3000)}/`,
    );
    for (const width of canvasWidths) {
      const themes = {};
      for (const dark of [false, true]) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        const html = await canvasMarkup(dark);
        await page.route('http://canvas.invalid/**', async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path === '/')
            return route.fulfill({ body: html, contentType: 'text/html' });
          const file = path.startsWith('/fonts/')
            ? `${root}public${path}`
            : `${project}${path}`;
          const type = path.endsWith('.css')
            ? 'text/css'
            : path.endsWith('.svg')
              ? 'image/svg+xml'
              : path.endsWith('.woff2')
                ? 'font/woff2'
                : 'image/webp';
          return route.fulfill({
            body: await readFile(file),
            contentType: type,
          });
        });
        await page.goto('http://canvas.invalid/');
        await page.evaluate(() => globalThis.document.fonts.ready);
        await page.evaluate(() =>
          Promise.all(
            [...globalThis.document.images].map((image) =>
              image.decode().catch(() => {}),
            ),
          ),
        );
        themes[dark ? 'dark' : 'light'] = await page.evaluate(measureCanvas);
        await page.close();
      }
      if (JSON.stringify(themes.light) !== JSON.stringify(themes.dark))
        throw new Error(
          `The canvas's ${width} geometry differs between themes`,
        );
      result.widths[width] = themes.light;
    }
  } finally {
    await browser?.close();
    await execFileAsync('docker', ['rm', '--force', container]).catch(() => {});
  }
  // Written in the repository's format, so a re-measure of the same pin
  // leaves the committed fixture byte-identical.
  const target = `${root}test/fixtures/final-ui/catalogue-geometry.json`;
  await writeFile(
    target,
    await format(JSON.stringify(result), {
      ...(await resolveConfig(target)),
      filepath: target,
    }),
  );
}

// The test runner discovers every .mjs under test/, this file included, and
// starts it with NODE_TEST_CONTEXT set. It is a measuring tool, not a test:
// under the runner it does nothing, so a test run never starts its browser
// container or rewrites the fixture.
if (process.env.NODE_TEST_CONTEXT === undefined) await main();
