import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import {
  checkPageLayout,
  designThemes,
  designWidths,
} from './layout-checks.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function safeName(value) {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-|-$/gu, '');
  if (!safe) throw new Error('Each route/state needs a filename-safe label.');
  return safe;
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/gu,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );
}

export async function runContactSheetActions(page, actions = []) {
  for (const step of actions) {
    if (typeof step !== 'object' || step === null)
      throw new Error('Invalid contact-sheet action.');
    if (step.action === 'scroll' && Number.isFinite(step.y) && step.y >= 0) {
      await page.evaluate((y) => globalThis.scrollTo(0, y), step.y);
    } else if (typeof step.selector === 'string' && step.selector.length > 0) {
      const target = page.locator(step.selector);
      if (step.action === 'click') await target.click();
      else if (step.action === 'focus') await target.focus();
      else if (step.action === 'fill' && typeof step.value === 'string')
        await target.fill(step.value);
      else if (step.action === 'press' && typeof step.key === 'string')
        await target.press(step.key);
      else if (step.action === 'waitFor')
        await target.waitFor({ state: 'visible' });
      else throw new Error(`Unsupported contact-sheet action: ${step.action}`);
    } else throw new Error(`Unsupported contact-sheet action: ${step.action}`);
  }
}

export async function captureContactSheet({
  origin,
  entries,
  output,
  browserEndpoint,
}) {
  const base = new URL(origin);
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  const browser = browserEndpoint
    ? await chromium.connect(browserEndpoint)
    : await chromium.launch();
  const captures = [];
  const labels = new Set();
  try {
    for (const entry of entries) {
      if (typeof entry.route !== 'string' || typeof entry.state !== 'string')
        throw new Error('Each manifest entry needs route and state strings.');
      const url = new URL(entry.route, base);
      if (url.origin !== base.origin)
        throw new Error('Contact-sheet routes must be same-origin.');
      const label = safeName(entry.state);
      if (labels.has(label))
        throw new Error(`Duplicate contact-sheet state label: ${label}`);
      labels.add(label);
      for (const width of designWidths) {
        for (const theme of designThemes) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme: theme,
          });
          try {
            const page = await context.newPage();
            const response = await page.goto(url.href, {
              // Protected forms keep Turnstile active after load; waiting for
              // network silence can hang a contact sheet on those states.
              waitUntil: 'load',
            });
            if (!response?.ok())
              throw new Error(
                `${entry.state} returned ${response?.status() ?? 'no response'}`,
              );
            await runContactSheetActions(page, entry.actions);
            const filename = `${label}-${width}-${theme}.png`;
            await page.screenshot({
              path: join(directory, filename),
              fullPage: true,
            });
            const layoutIssues = await checkPageLayout(page);
            captures.push({
              state: entry.state,
              width,
              theme,
              filename,
              layoutIssues,
            });
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  const cards = captures
    .map(
      ({ state, width, theme, filename }) =>
        `<figure><img src="${escapeHtml(filename)}" alt="${escapeHtml(state)} at ${width}px in ${theme} theme" loading="lazy"><figcaption>${escapeHtml(state)} · ${width}px · ${theme}</figcaption></figure>`,
    )
    .join('\n');
  await writeFile(
    join(directory, 'index.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Valstara design contact sheet</title><style>body{font:16px system-ui;margin:24px;background:#eee}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:24px}figure{margin:0}img{width:100%;height:auto}figcaption{padding:8px}</style><main>${cards}</main></html>`,
  );
  await writeFile(
    join(directory, 'index.json'),
    JSON.stringify(captures, null, 2),
  );
  return captures;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const origin = option('--origin') ?? 'http://127.0.0.1:4321';
  const output = option('--output') ?? '.design-contact-sheets/before';
  const manifest = option('--manifest');
  const entries = manifest
    ? JSON.parse(await readFile(manifest, 'utf8'))
    : [
        {
          route: option('--route') ?? '/',
          state: option('--state') ?? 'landing-before',
        },
      ];
  const captures = await captureContactSheet({
    origin,
    entries,
    output,
    browserEndpoint: option('--browser-ws'),
  });
  process.stdout.write(`Captured ${captures.length} views in ${output}\n`);
}
