import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';

import {
  checkPageLayout,
  checkShellLayout,
  shellRegions,
  designThemes,
  designWidths,
  enforcedPages,
  settlePage,
} from '../scripts/design/layout-checks.mjs';
import { runContactSheetActions } from '../scripts/design/contact-sheet.mjs';
import { publishedPort } from './helpers/listen-port.mjs';

const execFileAsync = promisify(execFile);
const container = `valstara-design-layout-${process.pid}`;
const image =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
let server;
let browser;

before(async () => {
  server = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      container,
      '--publish',
      '127.0.0.1::3000',
      '--volume',
      `${projectRoot}:/work:ro`,
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
  let output = '';
  server.stdout.on('data', (chunk) => {
    output += chunk;
  });
  server.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (
    let attempt = 0;
    attempt < 240 && !output.includes('Listening on');
    attempt += 1
  ) {
    if (server.exitCode !== null)
      throw new Error(`Playwright server exited: ${output}`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  assert.match(output, /Listening on/u);
  browser = await chromium.connect(
    `ws://127.0.0.1:${await publishedPort(container, 3000)}/`,
  );
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    await execFileAsync('docker', ['stop', container]);
    await once(server, 'exit');
  }
});

const good =
  '<!doctype html><html><head><style>body{margin:0}.container{margin:0 16px}.target{display:block;width:44px;height:44px}</style></head><body><main class="container" data-design-container><button class="target" data-grid-align="start">Go</button></main></body></html>';

test('closed widths and themes, with the redesigned pages enforced', () => {
  assert.deepEqual(designWidths, [320, 360, 390, 768, 1024, 1280, 1440, 1920]);
  assert.deepEqual(designThemes, ['light', 'dark']);
  assert.deepEqual(enforcedPages, [
    '/',
    '/verify',
    '/me',
    '/leaderboard',
    '/legit',
    '/guarantee',
    '/about',
    '/terms',
    '/privacy',
    '/privacy/storage',
    '/giveaway/rules',
    '/giveaway/rules/VAL-GW-LAUNCH-20260925-r1',
    '/giveaway/rules/VAL-GW-LAUNCH-20261001-r1',
    '/giveaway/rules/VAL-GW-LAUNCH-20261009-r1',
    '/unsubscribe',
    '/dsr',
    '/giveaway/award',
    '/404',
    '/500',
  ]);
});

test('a sound fixture passes every layout rule', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 600 } });
  try {
    await page.setContent(good);
    assert.deepEqual(await checkPageLayout(page), []);
  } finally {
    await page.close();
  }
});

test('planted overflow, 30px target and obscured focus fail the same harness', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 300 } });
  try {
    await page.setContent(
      good.replace('</main>', '<p style="width:400px">overflow</p></main>'),
    );
    assert.ok(
      (await checkPageLayout(page)).some((issue) =>
        issue.includes('horizontal overflow'),
      ),
    );
    await page.setContent(
      good.replace('width:44px;height:44px', 'width:30px;height:30px'),
    );
    assert.ok(
      (await checkPageLayout(page)).some((issue) =>
        issue.includes('small target'),
      ),
    );
    await page.setContent(
      good.replace(
        '</main>',
        '<div style="height:500px"></div><button class="target">Focus</button></main><div style="position:fixed;bottom:0;left:0;width:100%;height:80px;background:black"></div>',
      ),
    );
    assert.ok(
      (await checkPageLayout(page)).some((issue) =>
        issue.includes('focus obscured'),
      ),
    );
  } finally {
    await page.close();
  }
});

test('clipped text, missing image dimensions and a misaligned grid item fail', async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 600 } });
  try {
    await page.setContent(
      good.replace(
        '</main>',
        '<p style="width:40px;height:20px;overflow:hidden;white-space:nowrap">This text is clipped</p><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="fixture"><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="bad width" width="100%" height="1"><span data-grid-align="start" style="margin-left:8px">Offset</span></main>',
      ),
    );
    const issues = await checkPageLayout(page);
    assert.ok(issues.some((issue) => issue.includes('clipped text')));
    assert.equal(
      issues.filter((issue) =>
        issue.includes('image without intrinsic dimensions'),
      ).length,
      2,
    );
    assert.ok(issues.some((issue) => issue.includes('grid misalignment')));
  } finally {
    await page.close();
  }
});

test('visibly overflowing text fails the layout harness', async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 600 } });
  try {
    await page.setContent(
      good.replace(
        '</main>',
        '<p style="height:18px;overflow:visible">First line<br>Second line<br>Third line</p></main>',
      ),
    );
    assert.ok(
      (await checkPageLayout(page)).some((issue) =>
        issue.includes('overflowing text'),
      ),
    );
  } finally {
    await page.close();
  }
});

// A disclosure chevron turning 180° is wider than its box mid-turn. The
// checks measure the state the page comes to rest in, not a frame of a
// transition, so a check started mid-turn waits for it to end.
test('the layout checks measure the page at rest, after running transitions end', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 600 } });
  try {
    await page.setContent(
      good.replace(
        '</main>',
        '<p style="width:20px"><span data-turn style="display:inline-block;width:20px;height:20px;transition:transform 600ms linear">x</span></p></main>',
      ),
    );
    const at = await page.evaluate(() => {
      const turn = globalThis.document.querySelector('[data-turn]');
      turn.getBoundingClientRect();
      turn.style.transform = 'rotate(180deg)';
      return globalThis.performance.now();
    });
    // 150ms into the linear 600ms turn: 45°, its widest.
    await page.waitForTimeout(150);
    assert.deepEqual(await checkPageLayout(page), []);
    assert.ok(
      (await page.evaluate(() => globalThis.performance.now())) - at >= 550,
      'the check waited for the turn to end',
    );
    // A box that still overflows at rest still fails.
    await page.evaluate(() => {
      globalThis.document.querySelector('[data-turn]').style.width = '80px';
    });
    assert.ok(
      (await checkPageLayout(page)).some((issue) =>
        issue.includes('overflowing text'),
      ),
    );
  } finally {
    await page.close();
  }
});

// A contact-sheet state reached by posting a form is a new document. Its
// content can show while a subresource is still loading, so the screenshot
// and the checks wait for its load event, not just for the content.
test('a state reached by an action that loads a new document settles once that document has loaded', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 600 } });
  try {
    await page.route('http://sheet.test/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/slow.png') {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1_500));
        return route.fulfill({ contentType: 'image/png', body: '' });
      }
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body:
          pathname === '/done'
            ? '<!doctype html><main class="done"><p>Done</p><img src="/slow.png" width="1" height="1" alt=""></main>'
            : '<!doctype html><form method="post" action="/done"><button>Confirm</button></form>',
      });
    });
    await page.goto('http://sheet.test/');
    await runContactSheetActions(page, [
      { action: 'click', selector: 'button' },
      { action: 'waitFor', selector: '.done' },
    ]);
    await settlePage(page);
    assert.equal(
      await page.evaluate(() => globalThis.document.readyState),
      'complete',
    );
  } finally {
    await page.close();
  }
});

test('the layout checks do not wait on infinite or paused animations', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 600 } });
  try {
    await page.setContent(
      good.replace(
        '</main>',
        '<style>@keyframes spin{to{transform:rotate(1turn)}}</style><span data-spin style="display:inline-block;width:16px;height:16px;animation:spin 1s linear infinite"></span><span data-held style="display:inline-block;width:16px;height:16px;animation:spin 60s linear 1"></span></main>',
      ),
    );
    await page.evaluate(() => {
      for (const animation of globalThis.document
        .querySelector('[data-held]')
        .getAnimations())
        animation.pause();
    });
    const started = Date.now();
    assert.deepEqual(await checkPageLayout(page), []);
    assert.ok(Date.now() - started < 5_000, 'the check did not wait');
  } finally {
    await page.close();
  }
});

test('contact-sheet actions can reach a named interactive state without serialising input', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 300 } });
  try {
    await page.setContent(
      '<input id="entry"><button id="show" onclick="document.getElementById(\'result\').hidden=false">Show</button><p id="result" hidden>Done</p><div style="height:800px"></div>',
    );
    await runContactSheetActions(page, [
      { action: 'fill', selector: '#entry', value: 'fixture-only' },
      { action: 'press', selector: '#entry', key: 'Tab' },
      { action: 'click', selector: '#show' },
      { action: 'waitFor', selector: '#result' },
      { action: 'scroll', y: 500 },
    ]);
    assert.equal(await page.locator('#result').isVisible(), true);
    assert.equal(await page.locator('#entry').inputValue(), 'fixture-only');
    assert.ok(await page.evaluate(() => globalThis.scrollY > 0));
    await assert.rejects(
      runContactSheetActions(page, [{ action: 'evaluate', selector: '#show' }]),
    );
  } finally {
    await page.close();
  }
});

// E11.5-03: the shell check applies the same rules to the header and footer.
const shell = (header, main, footer) =>
  `<!doctype html><html><head><style>body{margin:0}.c{margin:0 16px}.t{display:block;width:44px;height:44px}</style></head><body><header><div class="c" data-design-container>${header}</div></header><main>${main}</main><footer><div class="c" data-design-container>${footer}</div></footer></body></html>`;
const target = '<a class="t" href="#">Go</a>';

test('the shell check covers exactly the header and footer landmarks', async () => {
  assert.deepEqual(shellRegions, ['body > header', 'body > footer']);
  const page = await browser.newPage({ viewport: { width: 320, height: 600 } });
  try {
    await page.setContent(shell(target, target, target));
    assert.deepEqual(await checkShellLayout(page), []);

    // A body defect is outside the shell, so the shell check leaves it to the
    // page's own enforcement, while the full-page check still sees it.
    await page.setContent(
      shell(
        target,
        '<a href="#" style="display:block;width:30px;height:30px">x</a><p style="width:400px">wide</p>',
        target,
      ),
    );
    assert.deepEqual(await checkShellLayout(page), []);
    const fullPage = await checkPageLayout(page);
    assert.ok(fullPage.some((issue) => issue.includes('small target')));
    assert.ok(fullPage.includes('horizontal overflow'));
  } finally {
    await page.close();
  }
});

test('planted shell defects fail the shell check in the header and in the footer', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 300 } });
  try {
    const small =
      '<a href="#" style="display:block;width:30px;height:30px">x</a>';
    await page.setContent(shell(small, '', target));
    assert.ok(
      (await checkShellLayout(page)).some((issue) =>
        issue.includes('small target'),
      ),
    );
    await page.setContent(shell(target, '', small));
    assert.ok(
      (await checkShellLayout(page)).some((issue) =>
        issue.includes('small target'),
      ),
    );
    await page.setContent(
      shell(`${target}<p style="width:400px">wide</p>`, '', target),
    );
    assert.ok(
      (await checkShellLayout(page)).includes('horizontal overflow: header'),
    );
    await page.setContent(
      shell(
        target,
        '<div style="height:900px"></div>',
        `${target}<div style="position:fixed;bottom:0;left:0;width:100%;height:120px;background:black"></div>`,
      ).replace(
        '</footer>',
        '<div style="height:600px"></div><a class="t" href="#">Late</a></footer>',
      ),
    );
    assert.ok(
      (await checkShellLayout(page)).some((issue) =>
        issue.includes('focus obscured'),
      ),
    );
    await page.setContent(
      shell(target, '', target).replace(' data-design-container', ''),
    );
    assert.ok(
      (await checkShellLayout(page)).includes(
        'missing design container: header',
      ),
    );
    await page.setContent(
      '<!doctype html><html><body><main><a class="t" href="#">Go</a></main></body></html>',
    );
    assert.deepEqual(await checkShellLayout(page), [
      'missing region: body > header',
      'missing region: body > footer',
    ]);
  } finally {
    await page.close();
  }
});
