// E11.5-11q: measures the final-design canvas's /verify board in each of its
// states, so the rendered-page suite can compare the built page with the
// canvas box by box.
//
// The canvas runtime (support.js) is not in the snapshot, so this resolves
// Verify.dc.html's own template the way its renderVals() resolves it for each
// state (its <sc-if> and <sc-for> blocks and {{values}}), and renders the
// <main> it produces on the snapshot's own valstara.css, with the site's
// self-hosted fonts, in the pinned Playwright browser, at the widths the
// /verify boards draw (Verify1440, Verify768 and Verify390), in both themes.
// The header import is not rendered (every box is relative to <main>), and a
// footer slot follows <main> as on the board. The annotation layer is not
// rendered (valstara.css hides .ann). Boxes come from verify-measure.mjs.
//
//   node test/fixtures/final-ui/measure-verify-geometry.mjs
//
// writes test/fixtures/final-ui/verify-geometry.json. The snapshot is pinned
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
import { canvasSelectors, measureVerify } from './verify-measure.mjs';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const project = `${root}docs/design/final-ui/project`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
export const verifyWidths = [1440, 768, 390];
export const verifyStates = [
  'confirm',
  'success',
  'referral-off',
  'survey-off',
  'both-off',
  'copied-saved',
  'failed-skipped',
  'survey-errors',
  'invalid',
  'invalid-sent',
  'invalid-nojs',
];

// The board's renderVals(), run as written for one state.
function boardValues(board, state, dark) {
  const script = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/u.exec(
    board,
  )[1];
  const context = { result: null };
  vm.runInNewContext(
    `class DCLogic {}\n${script}\nconst logic = new Component();\nlogic.props = { theme: ${JSON.stringify(dark ? 'dark' : 'light')}, state: ${JSON.stringify(state)}, uid: 'v', annotations: false };\nresult = logic.renderVals();`,
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
  const innermost =
    /<sc-if value="\{\{(\w+)\}\}"[^>]*>((?:(?!<sc-if)[\s\S])*?)<\/sc-if>/u;
  for (
    let match = innermost.exec(markup);
    match;
    match = innermost.exec(markup)
  )
    markup =
      markup.slice(0, match.index) +
      (values[match[1]] ? match[2] : '') +
      markup.slice(match.index + match[0].length);
  markup = markup.replace(/\{\{(\w+)\}\}/gu, (_, key) => String(values[key]));
  if (/\{\{|<sc-/u.test(markup)) throw new Error('an unresolved canvas value');
  return markup;
}

async function canvasMarkup(state, dark) {
  const board = await readFile(`${project}/Verify.dc.html`, 'utf8');
  const values = boardValues(board, state, dark);
  const start = board.indexOf('<main id="main"');
  const end = board.indexOf('</main>', start) + '</main>'.length;
  if (start < 0 || end < start) throw new Error('the /verify main moved');
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
  const container = `valstara-canvas-verify-${process.pid}`;
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
      'docs/design/final-ui/project/Verify.dc.html (pin 1793367843-fe69), every state as Verify1440, Verify768 and Verify390 place it, on valstara.css, measured by test/fixtures/final-ui/measure-verify-geometry.mjs',
    widths: {},
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
    for (const width of verifyWidths) {
      result.widths[width] = {};
      for (const state of verifyStates) {
        const themes = {};
        for (const dark of [false, true]) {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
          });
          const html = await canvasMarkup(state, dark);
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
            measureVerify,
            canvasSelectors,
          );
          await page.close();
        }
        if (JSON.stringify(themes.light) !== JSON.stringify(themes.dark))
          throw new Error(
            `The canvas's ${state} geometry at ${width} differs between themes`,
          );
        result.widths[width][state] = themes.light;
      }
    }
  } finally {
    await browser?.close();
    await execFileAsync('docker', ['rm', '--force', container]).catch(() => {});
  }
  const target = `${root}test/fixtures/final-ui/verify-geometry.json`;
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
