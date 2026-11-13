import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';

import {
  largestContentfulPaintBudgetMilliseconds,
  measureLandingPerformance,
} from '../scripts/design/landing-performance.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';

// E11.5-12 item 3: the landing page at 390px with the CPU slowed four times
// in the local harness. Layout shift is zero and the largest contentful
// paint is within 2.5s; the first-party JavaScript and the logo bytes are
// recorded (docs/testing/e11-5-design-qa.md). Turnstile's loader is answered
// with an empty script, so the figures are the site's own, not Cloudflare's.

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const browserContainer = `valstara-performance-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';

let app;
let browser;
let browserServer;

async function startBrowserServer() {
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
  browserServer.stdout.setEncoding('utf8');
  browserServer.stderr.setEncoding('utf8');
  browserServer.stdout.on('data', (chunk) => (output += chunk));
  browserServer.stderr.on('data', (chunk) => (output += chunk));
  for (let attempt = 0; attempt < 720; attempt += 1) {
    if (output.includes('Listening on'))
      return `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`;
    if (browserServer.exitCode !== null)
      throw new Error(`The Playwright server exited.\n${output}`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error(`The Playwright server did not start.\n${output}`);
}

before(async () => {
  await ensureAppBuild();
  app = await startAppServer({
    label: 'Landing performance test',
    env: () => ({
      ADMIN_CREDENTIAL: 'landing-performance-admin-credential-32',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-perf',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'landing-performance-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'landing-performance-referral-secret',
      RESEND_API_KEY: 'landing-performance-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'landing-performance-turnstile-secret',
    }),
  });
  browser = await chromium.connect(await startBrowserServer());
});

after(async () => {
  await browser?.close();
  await execFileAsync('docker', ['rm', '--force', browserContainer]).catch(
    (error) => {
      if (!String(error.stderr).includes('No such container')) throw error;
    },
  );
  if (browserServer !== undefined && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
  await app?.stop();
});

test('E11.5-12: the landing page at 390px with 4x CPU throttling has zero layout shift and LCP within 2.5s', async () => {
  const figures = await measureLandingPerformance(
    browser,
    `http://host.docker.internal:${app.port}`,
    {
      prepareContext: (context) =>
        context.route('https://challenges.cloudflare.com/**', (route) =>
          route.fulfill({ contentType: 'text/javascript', body: '' }),
        ),
    },
  );
  process.stdout.write(`# ${JSON.stringify(figures)}\n`);
  assert.equal(figures.cumulativeLayoutShift, 0, 'layout shift at load');
  assert.equal(
    figures.cumulativeLayoutShiftAfterScroll,
    0,
    'layout shift through the whole page, every lazy logo loaded',
  );
  assert.ok(
    figures.largestContentfulPaintMilliseconds !== null &&
      figures.largestContentfulPaintMilliseconds <=
        largestContentfulPaintBudgetMilliseconds,
    `largest contentful paint ${figures.largestContentfulPaintMilliseconds}ms`,
  );
  // Every provider logo the page loads is a shipped file, read in full.
  const shipped = new Map();
  for (const name of await readdir(`${root}/public/images/providers`))
    shipped.set(
      `/images/providers/${name}`,
      (await stat(`${root}/public/images/providers/${name}`)).size,
    );
  assert.equal(figures.logos.count, shipped.size, 'every logo loads');
  for (const { path, bytes } of figures.logos.files)
    assert.equal(bytes, shipped.get(path), `${path} bytes`);
  assert.ok(figures.firstPartyJavaScript.totalBytes > 0);
});
