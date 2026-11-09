// E11.5-11o: measures the final-design canvas's "What you get" (#rewards),
// so the rendered-page suite can compare the built section with the canvas
// box by box, in every feature-switch variant.
//
// The canvas runtime (support.js) is not in the snapshot, so this renders
// Rewards.dc.html's own template — the section markup as committed, with
// its {{…}} values and <sc-if> blocks resolved the way its renderVals()
// resolves them for each variant of Switches.dc.html — on the snapshot's own
// valstara.css, with the site's self-hosted fonts, in the pinned Playwright
// browser, at every final-design width in both themes. The annotation layer
// is not rendered. Boxes are [x, y, width, height] in CSS px, relative to the
// reward grid's top-left corner.
//
//   node test/fixtures/final-ui/measure-rewards-geometry.mjs
//
// writes test/fixtures/final-ui/rewards-geometry.json. The snapshot is
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

// Switches.dc.html's six variants of "What you get".
export const canvasVariants = {
  A: { referral: true, giveaway: true, leaderboard: true, tier2: false },
  B: { referral: true, giveaway: false, leaderboard: true, tier2: false },
  C: { referral: false, giveaway: true, leaderboard: true, tier2: false },
  D: { referral: true, giveaway: true, leaderboard: false, tier2: false },
  E: { referral: false, giveaway: false, leaderboard: false, tier2: false },
  F: { referral: true, giveaway: true, leaderboard: true, tier2: true },
};

// Rewards.dc.html's section, resolved as its renderVals() resolves it.
async function canvasMarkup(variant, dark) {
  const board = await readFile(`${project}/Rewards.dc.html`, 'utf8');
  let section = /<section\b[\s\S]*<\/section>/u.exec(board)[0];
  const { referral, giveaway, leaderboard } = variant;
  const values = {
    referral,
    giveaway,
    leaderboard,
    tier2: variant.tier2 && referral,
    footLine: referral || giveaway,
  };
  const count = 1 + Number(referral) + Number(giveaway);
  // Innermost <sc-if> first, so a nested block resolves before its parent.
  const block =
    /<sc-if value="\{\{(\w+)\}\}"[^>]*>((?:(?!<sc-if\b)[\s\S])*?)<\/sc-if>/u;
  for (let match = block.exec(section); match; match = block.exec(section)) {
    if (!(match[1] in values)) throw new Error(`unknown switch ${match[1]}`);
    section = section.replace(match[0], values[match[1]] ? match[2] : '');
  }
  section = section
    .replaceAll('{{gridCls}}', `rewards--${count}`)
    .replaceAll('{{uid}}', 'r')
    .replaceAll('{{padTop}}', '')
    .replaceAll('{{annGrid}}', '')
    .replaceAll('./icons.svg', '/icons.svg');
  if (/\{\{/u.test(section)) throw new Error('an unresolved canvas value');
  return `<!doctype html><html><head><style>
@font-face { font-family: 'Instrument Sans'; font-weight: 400 700; src: url('/fonts/instrument-sans-latin-wght-normal.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-weight: 100 800; src: url('/fonts/jetbrains-mono-latin-wght-normal.woff2') format('woff2'); }
body { margin: 0; }
</style><link rel="stylesheet" href="/valstara.css"></head><body><div class="page page--fit${dark ? ' dark' : ''}"><main>
${section}
</main></div></body></html>`;
}

function measureCanvas() {
  const { document, getComputedStyle } = globalThis;
  const grid = document.querySelector('.rewards');
  const origin = grid.getBoundingClientRect();
  const box = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return [
      rect.left - origin.left,
      rect.top - origin.top,
      rect.width,
      rect.height,
    ].map((value) => Math.round(value * 100) / 100);
  };
  const all = (selector, from = document) =>
    [...from.querySelectorAll(selector)].map(box);
  const one = (selector) => box(document.querySelector(selector));
  const kind = (card) =>
    card.classList.contains('reward--access')
      ? 'access'
      : card.querySelector('.equation')
        ? 'referral'
        : 'giveaway';
  const bar = document.querySelector('.waves__bar');
  const dot = getComputedStyle(bar, '::before');
  const footer = document.querySelector('.rewards-foot');
  return {
    grid: box(grid),
    cards: [...grid.querySelectorAll(':scope > article')].map((card) => ({
      kind: kind(card),
      box: box(card),
      head: box(card.querySelector('.reward__head')),
      tile: box(card.querySelector('.tile')),
      h3: box(card.querySelector('h3')),
      body: box(card.querySelector('.reward__body')),
      visual: box(card.querySelector('.reward__visual')),
      wells: all('.well', card),
    })),
    waveLabel: all('.waves__label'),
    waveTrack: all('.waves__track'),
    waveFill: all('.waves__bar'),
    waveDot: [Number.parseFloat(dot.width), Number.parseFloat(dot.height)],
    waveGrid: one('.waves__grid'),
    waveLines: all('.waves__grid i'),
    axis: one('.waves__axis-line'),
    tiers: [...document.querySelectorAll('.equation')].map((tier) => ({
      box: box(tier),
      count: box(tier.querySelector('.equation__count')),
      figure: box(tier.querySelector('.t-figure')),
      people: box(tier.querySelector('.equation__people')),
      label: box(tier.querySelector('.equation__meta .t-label')),
      arrow: box(tier.querySelector('.equation__op:not(.equation__op--plus)')),
      plus: box(tier.querySelector('.equation__op--plus')),
      pills: all('.pill', tier),
    })),
    held: one('.reward__held'),
    prize: one('.prize'),
    gifts: one('.prize__gifts'),
    note: box(
      [...document.querySelectorAll('.reward__visual > p')].find((p) =>
        p.classList.contains('t-small'),
      ),
    ),
    rulesLink: box(
      [...grid.querySelectorAll('a')].find(
        (link) => link.getAttribute('href') === '/giveaway/rules',
      ),
    ),
    footer: box(footer),
    verified: box(footer?.querySelector('.rewards-foot__fact')),
    leaderboardLink: box(footer?.querySelector('a')),
  };
}

async function main() {
  const container = `valstara-canvas-rewards-${process.pid}`;
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
      'docs/design/final-ui/project/Rewards.dc.html (pin 1793367843-fe69), as Switches.dc.html places it, on valstara.css, measured by test/fixtures/final-ui/measure-rewards-geometry.mjs',
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
      result.widths[width] = {};
      for (const [name, variant] of Object.entries(canvasVariants)) {
        const themes = {};
        for (const dark of [false, true]) {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
          });
          const html = await canvasMarkup(variant, dark);
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
                : 'font/woff2';
            return route.fulfill({
              body: await readFile(file),
              contentType: type,
            });
          });
          await page.goto('http://canvas.invalid/');
          await page.evaluate(() => globalThis.document.fonts.ready);
          themes[dark ? 'dark' : 'light'] = await page.evaluate(measureCanvas);
          await page.close();
        }
        if (JSON.stringify(themes.light) !== JSON.stringify(themes.dark))
          throw new Error(
            `The canvas's ${width} variant ${name} geometry differs between themes`,
          );
        result.widths[width][name] = themes.light;
      }
    }
  } finally {
    await browser?.close();
    await execFileAsync('docker', ['rm', '--force', container]).catch(() => {});
  }
  // Written in the repository's format, so a re-measure of the same pin
  // leaves the committed fixture byte-identical.
  const target = `${root}test/fixtures/final-ui/rewards-geometry.json`;
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
