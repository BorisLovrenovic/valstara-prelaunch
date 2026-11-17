# P9 — Capturing the source pages for E11.6-01

**Who:** the founder, with one click. **When:** before E11.6-01 starts. **Time:** one click, then about 20 minutes of waiting.

## How it works

`https://www.youfundceo.com` sits behind Vercel's bot protection. On 2026-11-17 a plain capture script got `robots.txt` and `sitemap.xml`, but every page answered with a "Vercel Security Checkpoint" (HTTP 429); those responses are kept in `raw/` as evidence. **By founder decision (2026-11-17, recorded on E11.6-04), the capture runs in a headless browser that presents itself as an ordinary browser**, the same way the monthly fetcher will. It never solves a CAPTCHA and never rotates proxies.

The capture script is `/home/ccbl3/youfundceo-capture/capture.mjs`, outside the repository; its text is at the end of this file. It runs inside the repository's pinned Playwright container (`mcr.microsoft.com/playwright:v1.62.1-noble`), which carries Chromium and the system libraries it needs, so nothing has to be installed. **The founder starts it. No AI agent session runs it**, because the source's `robots.txt` blocks AI agents (epic rule 2).

It visits, one page at a time with a 10–20 second pause:

- the home page, where it finds the "Price moves" and terms-of-use links and adds them;
- `/countries`, `/services`, `/services/netflix` and `/services/spotify`;
- the 38 country pages of E11.6-01;
- twelve service-by-country pages: Adobe, Apple Music, ChatGPT, Netflix, Spotify and YouTube Premium, each in Sweden and the United States.

For each page it saves:

- the page as the browser shows it (`pages/<name>.html`);
- the page as the server sent it (`pages/<name>.server.html`);
- full-page screenshots of five page types (`browser/*.png`);
- two network recordings with cookies removed (`browser/countries__sweden.har`, `browser/services__netflix__sweden.har`).

Every file gets a line in `manifest.tsv` with its URL, status, time and SHA-256. A page that doesn't exist is recorded as `404` and skipped. **Three refused pages in a row stop the run**, and nothing is retried.

## Run it

Click **Run** on this command. Docker Desktop must be running.

```bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v /home/ccbl3/projects/valstara-prelaunch:/home/ccbl3/projects/valstara-prelaunch -v /home/ccbl3/youfundceo-capture:/home/ccbl3/youfundceo-capture:ro -w /home/ccbl3/projects/valstara-prelaunch mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e node /home/ccbl3/youfundceo-capture/capture.mjs packages/price-index/test/fixtures/youfundceo
```

Each page prints its status. `200` is good, and `404` means that page doesn't exist on the source. **If it prints "Stopped after three refused pages in a row", don't retry.** Tell the E11.6-01 session what happened; it is a finding for the founder.

**Do not commit anything.** The E11.6-01 session checks the files and commits them on its own branch.

## The script

```js
// One-off fixture capture for E11.6-01 (founder decision 2026-11-17: headless
// browser presenting as an ordinary browser; no CAPTCHA solving, no proxies).
// Run by the founder, never by an AI agent session.
//
// It runs inside the repository's pinned Playwright container, which carries
// Chromium and its system libraries; the command is in
// docs/prerequisites/p9-source-capture.md.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const { chromium } = require('playwright');

const out = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Give the output folder as the first argument.');
const base = (process.env.BASE_URL ?? 'https://www.youfundceo.com').replace(/\/$/u, '');
const delayMin = Number(process.env.DELAY_MIN ?? 10);
const delayMax = Number(process.env.DELAY_MAX ?? 20);
const checkpointWait = Number(process.env.CHECKPOINT_WAIT ?? 30);
const failWait = Number(process.env.FAIL_WAIT ?? 60);

const countries = ['sweden', 'germany', 'united-kingdom', 'poland', 'romania', 'norway', 'denmark',
  'switzerland', 'canada', 'australia', 'austria', 'belgium', 'bosnia-and-herzegovina', 'croatia',
  'cyprus', 'czech-republic', 'estonia', 'finland', 'france', 'greece', 'hungary', 'iceland', 'ireland',
  'italy', 'latvia', 'liechtenstein', 'lithuania', 'luxembourg', 'malta', 'netherlands', 'new-zealand',
  'north-macedonia', 'portugal', 'serbia', 'slovakia', 'slovenia', 'spain', 'united-states'];
const pairServices = ['adobe', 'apple-music', 'chatgpt', 'netflix', 'spotify', 'youtube-premium'];
const screenshotPaths = new Set(['/countries', '/countries/sweden', '/services/netflix', '/services/netflix/sweden']);
const harPaths = new Set(['/countries/sweden', '/services/netflix/sweden']);

const paths = ['/', '/countries', '/services', '/services/netflix', '/services/spotify',
  ...countries.map((c) => `/countries/${c}`),
  ...pairServices.flatMap((s) => [`/services/${s}/sweden`, `/services/${s}/united-states`])];

for (const dir of ['pages', 'browser']) mkdirSync(join(out, dir), { recursive: true });
const manifest = join(out, 'manifest.tsv');
if (!existsSync(manifest)) writeFileSync(manifest, 'url\tfile\tstatus\tcaptured_at\tsha256\n');
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const nameOf = (path) => (path === '/' ? 'home' : path.replace(/^\//u, '').replace(/\/$/u, '').replaceAll('/', '__'));
const sleep = (seconds) => new Promise((done) => setTimeout(done, seconds * 1000));
const pause = () => sleep(delayMin + Math.random() * (delayMax - delayMin));
const record = (url, file, status) => {
  const full = join(out, file);
  appendFileSync(manifest, `${url}\t${file}\t${status}\t${new Date().toISOString()}\t${existsSync(full) ? sha(full) : '-'}\n`);
};

const browser = await chromium.launch({
  channel: 'chromium',
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
});
const probe = await browser.newPage();
const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
await probe.close();
const contextOptions = { userAgent, locale: 'en-US', viewport: { width: 1366, height: 900 } };
const context = await browser.newContext(contextOptions);
await context.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });
});

// Bounds any step, so a page stuck in the checkpoint's reload loop never hangs the run.
const within = (promise, seconds) =>
  Promise.race([promise, sleep(seconds).then(() => { throw new Error(`timed out after ${seconds}s`); })]);
const isCheckpoint = async (page) => /security checkpoint/iu.test(await within(page.title(), 5).catch(() => ''));

async function load(page, url) {
  let last = null;
  page.on('response', (r) => {
    if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) last = r;
  });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  last ??= response;
  // Through the checkpoint once the latest page response is no longer a refusal
  // and the title is no longer the checkpoint's; a reload in progress counts as not yet.
  const refused = () => [403, 429].includes(last?.status() ?? 429);
  for (let waited = 0; waited < checkpointWait; waited += 1) {
    if (!refused() && !(await isCheckpoint(page))) break;
    await sleep(1);
  }
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  return { checkpoint: refused() || (await isCheckpoint(page)), status: last?.status() ?? 0, response: last };
}

function stripCookies(harFile) {
  const har = JSON.parse(readFileSync(harFile, 'utf8'));
  for (const entry of har.log.entries) {
    for (const part of [entry.request, entry.response]) {
      part.cookies = [];
      part.headers = part.headers.filter((h) => !/^(cookie|set-cookie)$/iu.test(h.name));
    }
  }
  writeFileSync(harFile, JSON.stringify(har, null, 2));
}

let failures = 0;
const queue = [...paths];
const extra = new Set();
for (let index = 0; index < queue.length; index += 1) {
  const path = queue[index];
  if (/^\/(api|go)\//u.test(path)) { console.log(`skip (disallowed by robots.txt): ${path}`); continue; }
  if (index > 0) await pause();
  const url = `${base}${path}`;
  const name = nameOf(path);
  const wantsHar = harPaths.has(path);
  const ctx = wantsHar
    ? await browser.newContext({ ...contextOptions, recordHar: { path: join(out, 'browser', `${name}.har`) } })
    : context;
  if (wantsHar) await ctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  try {
    const { checkpoint, status, response } = await load(page, url);
    if (checkpoint || status === 429 || status === 403 || status >= 500) {
      failures += 1;
      record(url, '-', checkpoint ? `${status}-checkpoint` : status);
      console.log(`${status}  ${url}  ${checkpoint ? '(still the security checkpoint)' : ''}`);
      if (failures >= 3) {
        console.log('Stopped after three refused pages in a row. Do not retry; tell Claude what happened.');
        break;
      }
      console.log('   waiting a minute before the next page');
      await sleep(failWait);
      continue;
    }
    failures = 0;
    if (status === 404) { record(url, '-', 404); console.log(`404  ${url}  (does not exist)`); continue; }
    writeFileSync(join(out, 'pages', `${name}.html`), await page.content());
    record(url, `pages/${name}.html`, status);
    const body = response ? await within(response.text(), 15).catch(() => null) : null;
    if (body) {
      writeFileSync(join(out, 'pages', `${name}.server.html`), body);
      record(url, `pages/${name}.server.html`, status);
    }
    if (screenshotPaths.has(path)) {
      await page.screenshot({ path: join(out, 'browser', `${name}.png`), fullPage: true });
      record(url, `browser/${name}.png`, status);
    }
    console.log(`${status}  ${url}`);
    if (path === '/') {
      const links = await page.$$eval('a[href]', (as) => as.map((a) => ({ href: a.getAttribute('href'), text: a.textContent ?? '' })));
      for (const { href, text } of links) {
        if (!href || !/price[\s-]*moves|terms/iu.test(`${text} ${href}`)) continue;
        const target = new URL(href, url);
        if (target.origin !== new URL(base).origin || extra.has(target.pathname)) continue;
        extra.add(target.pathname);
        queue.push(target.pathname);
        if (/price[\s-]*moves/iu.test(`${text} ${href}`)) screenshotPaths.add(target.pathname);
        console.log(`   found: ${target.pathname}`);
      }
    }
  } catch (error) {
    failures += 1;
    record(url, '-', 'error');
    console.log(`error  ${url}  ${error.message.split('\n')[0]}`);
    if (failures >= 3) { console.log('Stopped after three failed pages in a row. Tell Claude what happened.'); break; }
  } finally {
    await within(page.goto('about:blank'), 10).catch(() => {});
    await within(page.close(), 10).catch(() => {});
    if (wantsHar) {
      await within(ctx.close(), 30).catch(() => {});
      const harFile = join(out, 'browser', `${name}.har`);
      if (existsSync(harFile)) { stripCookies(harFile); record(url, `browser/${name}.har`, 'har'); }
    }
  }
}
await browser.close();
console.log(`Done. Manifest: ${manifest}`);
```
