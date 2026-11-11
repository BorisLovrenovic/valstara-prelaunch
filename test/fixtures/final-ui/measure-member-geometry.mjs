// E11.5-11r: measures the final-design canvas's /me and /leaderboard boards
// in each of their full-page states, so the rendered-page suite can compare
// the built pages with the canvas box by box.
//
// The canvas runtime (support.js) is not in the snapshot, so this resolves
// each board's own template (Me.dc.html, Leaderboard.dc.html) the way its
// renderVals() resolves it for each state (its <sc-if> and <sc-for> blocks
// and {{values}}), and renders the <main> it produces on the snapshot's own
// valstara.css, with the site's self-hosted fonts, in the pinned Playwright
// browser, at the widths the boards draw, in both themes. The header import
// is not rendered (every box is relative to <main>), and a footer slot
// follows <main> as on the board. The annotation layer is not rendered
// (valstara.css hides .ann). Boxes come from member-measure.mjs.
//
//   node test/fixtures/final-ui/measure-member-geometry.mjs
//
// writes test/fixtures/final-ui/member-geometry.json. The snapshot is pinned
// (docs/design/final-ui/SHA256SUMS), so the output only changes when the
// founder re-pins the canvas.
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';

import { chromium } from 'playwright';
import { format, resolveConfig } from 'prettier';

import { publishedPort } from '../../helpers/listen-port.mjs';
import { canvasSelectors, measureMember } from './member-measure.mjs';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const project = `${root}docs/design/final-ui/project`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
// Each board's widths (Me1440, Me768 and Me390; Leaderboard1440 and
// Leaderboard390) and its full-page states. The two strip frames on the /me
// boards (marketing errors, copy states) draw single cards outside the page
// layout, so the suite checks those states by behaviour, not by geometry.
export const boards = {
  Me: {
    widths: [1440, 768, 390],
    states: [
      'dashboard',
      'zero',
      'prefs-saved',
      'recovery',
      'recovery-sent',
      'left',
      'unavailable',
    ],
  },
  Leaderboard: {
    widths: [1440, 390],
    states: ['full', 'short', 'empty', 'loading', 'paused', 'unavailable'],
  },
};

// The board's renderVals(), run as written for one state.
function boardValues(board, state, dark) {
  const script = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/u.exec(
    board,
  )[1];
  const context = { result: null };
  vm.runInNewContext(
    `class DCLogic {}\n${script}\nconst logic = new Component();\nlogic.props = { theme: ${JSON.stringify(dark ? 'dark' : 'light')}, state: ${JSON.stringify(state)}, uid: 'm', annotations: false };\nresult = logic.renderVals();`,
    context,
  );
  return context.result;
}

// <sc-for> repeats its body per item; <sc-if> keeps its body when its value
// is truthy, innermost first; then every {{value}} is substituted.
function resolveTemplate(template, values) {
  let markup = template.replace(
    /<sc-for list="\{\{(\w+)\}\}" as="(\w+)"[^>]*>([\s\S]*?)<\/sc-for>/gu,
    (_, list, name, body) =>
      values[list]
        .map((item) =>
          body.replace(
            new RegExp(`\\{\\{${name}\\.(\\w+)\\}\\}`, 'gu'),
            (__, key) => String(item[key]),
          ),
        )
        .join(''),
  );
  // Inside an <sc-for> body an item's flag is already its literal value.
  const innermost =
    /<sc-if value="(?:\{\{(\w+)\}\}|(true|false))"[^>]*>((?:(?!<sc-if)[\s\S])*?)<\/sc-if>/u;
  for (
    let match = innermost.exec(markup);
    match;
    match = innermost.exec(markup)
  ) {
    const kept =
      match[2] === undefined ? Boolean(values[match[1]]) : match[2] === 'true';
    markup =
      markup.slice(0, match.index) +
      (kept ? match[3] : '') +
      markup.slice(match.index + match[0].length);
  }
  // A null attribute value is no attribute, as the canvas runtime renders it
  // (the disclosure's open="{{discOpen}}").
  markup = markup.replace(/\s[\w-]+="\{\{(\w+)\}\}"/gu, (attribute, key) =>
    values[key] === null ? '' : attribute,
  );
  markup = markup.replace(/\{\{(\w+)\}\}/gu, (_, key) => String(values[key]));
  if (/\{\{|<sc-/u.test(markup)) throw new Error('an unresolved canvas value');
  return markup;
}

async function canvasMarkup(name, state, dark) {
  const board = await readFile(`${project}/${name}.dc.html`, 'utf8');
  const values = boardValues(board, state, dark);
  const start = board.indexOf('<main id="main"');
  const end = board.indexOf('</main>', start) + '</main>'.length;
  if (start < 0 || end < start) throw new Error(`the ${name} main moved`);
  const main = resolveTemplate(board.slice(start, end), values).replaceAll(
    './icons.svg',
    '/icons.svg',
  );
  return `<!doctype html><html><head><style>
@font-face { font-family: 'Instrument Sans'; font-weight: 400 700; src: url('/fonts/instrument-sans-latin-wght-normal.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-weight: 100 800; src: url('/fonts/jetbrains-mono-latin-wght-normal.woff2') format('woff2'); }
body { margin: 0; }
</style><link rel="stylesheet" href="/valstara.css"></head><body><div class="page page--fit${dark ? ' dark' : ''}">
${main}
<div class="footer-slot"><footer class="site-footer-probe"></footer></div></div></body></html>`;
}

async function main() {
  const container = `valstara-canvas-member-${process.pid}`;
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
      'docs/design/final-ui/project/Me.dc.html and Leaderboard.dc.html (pin 1793367843-fe69), every full-page state as Me1440, Me768, Me390, Leaderboard1440 and Leaderboard390 place it, on valstara.css, measured by test/fixtures/final-ui/measure-member-geometry.mjs',
    boards: {},
  };
  let browser;
  try {
    while (!output.includes('Listening on')) {
      if (server.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
    browser = await chromium.connect(
      `ws://127.0.0.1:${await publishedPort(container, 3000)}/`,
    );
    for (const [name, { widths, states }] of Object.entries(boards)) {
      result.boards[name] = {};
      for (const width of widths) {
        result.boards[name][width] = {};
        for (const state of states) {
          const themes = {};
          for (const dark of [false, true]) {
            const page = await browser.newPage({
              viewport: { width, height: 900 },
            });
            const html = await canvasMarkup(name, state, dark);
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
            themes[dark ? 'dark' : 'light'] = await page.evaluate(
              measureMember,
              canvasSelectors,
            );
            await page.close();
          }
          if (JSON.stringify(themes.light) !== JSON.stringify(themes.dark))
            throw new Error(
              `The canvas's ${name} ${state} geometry at ${width} differs between themes`,
            );
          result.boards[name][width][state] = themes.light;
        }
      }
    }
  } finally {
    await browser?.close();
    await execFileAsync('docker', ['rm', '--force', container]).catch(() => {});
  }
  const target = `${root}test/fixtures/final-ui/member-geometry.json`;
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
// under the runner it does nothing.
if (process.env.NODE_TEST_CONTEXT === undefined) await main();
