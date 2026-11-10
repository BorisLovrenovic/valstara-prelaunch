// E11.5-11p: measures the final-design canvas's four closing landing
// sections — the guarantee band (#guarantee), "Get to know Valstara", the FAQ
// (#faq) and the final call to action — so the rendered-page suite can
// compare the built page with the canvas box by box.
//
// The canvas runtime (support.js) is not in the snapshot, so this renders
// Main.dc.html's own markup for the four sections — as committed, with its
// {{uid}} and {{faqFocus}} values resolved the way its renderVals() resolves
// them by default — on the snapshot's own valstara.css, with the site's
// self-hosted fonts, in the pinned Playwright browser, at every final-design
// width in both themes. The 1024, 768, 390, 320 and dark landing boards all
// import Main at their width, so this is every landing frame. The annotation
// layer is not rendered (valstara.css hides .ann). A footer slot follows the
// sections, as on the board, so the gap above the footer is measured too.
// Boxes are [x, y, width, height] in CSS px: the sections relative to the
// band's top-left corner, and every element relative to its own section's.
//
//   node test/fixtures/final-ui/measure-closing-geometry.mjs
//
// writes test/fixtures/final-ui/closing-geometry.json. The snapshot is
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

// Main.dc.html's four closing sections, resolved as its renderVals()
// resolves them by default (uid "m", no focus demonstration).
async function canvasMarkup(dark) {
  const board = await readFile(`${project}/Main.dc.html`, 'utf8');
  const start = board.indexOf('<section class="band" id="guarantee"');
  const end = board.indexOf('</main>', start);
  const sections = board
    .slice(start, end)
    .replaceAll('{{uid}}', 'm')
    .replaceAll('{{faqFocus}}', '')
    .replaceAll('./icons.svg', '/icons.svg')
    .replaceAll('./logos/', '/logos/');
  if (start < 0 || end < 0) throw new Error('the closing sections moved');
  if (/\{\{/u.test(sections)) throw new Error('an unresolved canvas value');
  return `<!doctype html><html><head><style>
@font-face { font-family: 'Instrument Sans'; font-weight: 400 700; src: url('/fonts/instrument-sans-latin-wght-normal.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-weight: 100 800; src: url('/fonts/jetbrains-mono-latin-wght-normal.woff2') format('woff2'); }
body { margin: 0; }
</style><link rel="stylesheet" href="/valstara.css"></head><body><div class="page page--fit${dark ? ' dark' : ''}"><main>
${sections}
</main><div class="footer-slot"><footer class="site-footer-probe"></footer></div></div></body></html>`;
}

function measureCanvas() {
  const { document } = globalThis;
  const relative = (element, from) => {
    if (!element || element.getClientRects().length === 0) return null;
    const rect = element.getBoundingClientRect();
    return [
      rect.left - from.left,
      rect.top - from.top,
      rect.width,
      rect.height,
    ].map((value) => Math.round(value * 100) / 100);
  };
  const all = (selector, scope, from) =>
    [...scope.querySelectorAll(selector)]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => relative(element, from));
  const band = document.querySelector('#guarantee');
  const trust = document.querySelector('[aria-labelledby="trust-title-m"]');
  const faq = document.querySelector('#faq');
  const cta = document.querySelector('[aria-labelledby="cta-title-m"]');
  const origin = band.getBoundingClientRect();
  const own = (section) => section.getBoundingClientRect();
  const bandBox = own(band);
  const trustBox = own(trust);
  const faqBox = own(faq);
  const ctaBox = own(cta);
  const ctaCard = cta.querySelector('.cta');
  return {
    sections: {
      band: relative(band, origin),
      trust: relative(trust, origin),
      faq: relative(faq, origin),
      cta: relative(cta, origin),
      footerGap:
        document.querySelector('.footer-slot footer').getBoundingClientRect()
          .top - ctaCard.getBoundingClientRect().bottom,
    },
    band: {
      head: relative(band.querySelector('.band__head'), bandBox),
      heading: relative(band.querySelector('h2'), bandBox),
      intro: relative(band.querySelector('.band__head p'), bandBox),
      list: relative(band.querySelector('.promises'), bandBox),
      promises: all('.promise', band, bandBox),
      numerals: all('.promise__numeral', band, bandBox),
      titles: all('.promise__title', band, bandBox),
      lines: all('.promise__text', band, bandBox),
      link: relative(band.querySelector('.band__link'), bandBox),
      linkIcon: relative(band.querySelector('.band__link .icon'), bandBox),
      star: relative(band.querySelector('.band__star'), bandBox),
    },
    trust: {
      heading: relative(trust.querySelector('h2'), trustBox),
      grid: relative(trust.querySelector('.trust-cards'), trustBox),
      cards: all('.trust-card', trust, trustBox),
      tiles: all('.trust-card .tile', trust, trustBox),
      titles: all('.trust-card__title', trust, trustBox),
      arrows: all('.trust-card__title .icon', trust, trustBox),
      lines: all('.trust-card p', trust, trustBox),
    },
    faq: {
      heading: relative(faq.querySelector('h2'), faqBox),
      card: relative(faq.querySelector('.faq__list'), faqBox),
      items: all('details', faq, faqBox),
      summaries: all('summary', faq, faqBox),
      discs: all('.qa__chev', faq, faqBox),
      answers: all('details[open] .qa__answer', faq, faqBox),
    },
    cta: {
      card: relative(ctaCard, ctaBox),
      text: relative(cta.querySelector('.cta__text'), ctaBox),
      heading: relative(cta.querySelector('h2'), ctaBox),
      button: relative(cta.querySelector('.btn'), ctaBox),
      visual: relative(cta.querySelector('.cta__visual'), ctaBox),
      banners: all('.banner', cta, ctaBox),
      chips: all('.banner__chip', cta, ctaBox),
      logos: all('.banner__logo', cta, ctaBox),
    },
  };
}

async function main() {
  const container = `valstara-canvas-closing-${process.pid}`;
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
      'docs/design/final-ui/project/Main.dc.html (pin 1793367843-fe69): #guarantee, the trust row, #faq and the final call to action, on valstara.css, measured by test/fixtures/final-ui/measure-closing-geometry.mjs',
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
  const target = `${root}test/fixtures/final-ui/closing-geometry.json`;
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
