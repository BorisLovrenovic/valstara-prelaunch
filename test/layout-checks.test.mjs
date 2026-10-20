import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';

import {
  assertEnforcedPages,
  checkPageLayout,
  checkShellLayout,
  shellRegions,
  designThemes,
  designWidths,
  enforcedPages,
} from '../scripts/design/layout-checks.mjs';
import { runContactSheetActions } from '../scripts/design/contact-sheet.mjs';

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
  const { stdout } = await execFileAsync('docker', [
    'port',
    container,
    '3000/tcp',
  ]);
  const port = /127\.0\.0\.1:(\d+)/u.exec(stdout)?.[1];
  assert.ok(port);
  browser = await chromium.connect(`ws://127.0.0.1:${port}/`);
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

test('closed widths and themes, with no enforced pages until the first redesign', async () => {
  assert.deepEqual(designWidths, [320, 360, 390, 768, 1024, 1280, 1440, 1920]);
  assert.deepEqual(designThemes, ['light', 'dark']);
  assert.deepEqual(enforcedPages, []);
  await assertEnforcedPages(browser, 'http://localhost:4321');
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
