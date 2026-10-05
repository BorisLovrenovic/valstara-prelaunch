import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium } from 'playwright';
import { Pool } from 'pg';

const executeFile = promisify(execFile);
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const profileUrl = 'https://www.trustpilot.com/review/valstara.com';
const loaderUrl =
  'https://widget.trustpilot.com/bootstrap/v5/tp.widget.bootstrap.min.js';
const browserPort = 47_000 + (process.pid % 1_000);
const browserContainer = `valstara-trustpilot-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';

async function startBrowser() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const process = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      browserContainer,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--publish',
      `127.0.0.1:${browserPort}:3000`,
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
  process.stdout.setEncoding('utf8');
  process.stderr.setEncoding('utf8');
  process.stdout.on('data', (chunk) => {
    output += chunk;
  });
  process.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (output.includes('Listening on')) {
      return {
        browser: await chromium.connect(`ws://127.0.0.1:${browserPort}/`),
        process,
      };
    }
    if (process.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error(`Playwright container did not start: ${output}`);
}

async function withDatabase(run) {
  const name = `valstara_e908_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const database = new Pool({ connectionString: url.toString() });
  const appUrl = new URL(url);
  appUrl.username = 'valstara_app';
  appUrl.password = appRolePassword;
  await admin.query(`CREATE DATABASE "${name}"`);
  try {
    await executeFile(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'e9-08-trustpilot-test'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: url.toString(),
          VALSTARA_APP_DB_PASSWORD: appRolePassword,
        },
      },
    );
    await run(database, appUrl.toString());
  } finally {
    await database.end();
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
}

async function withServer(
  databaseUrl,
  reviewCount,
  run,
  ids = ['test-business-unit', 'test-template'],
) {
  const port = 46_000 + (process.pid % 1_000);
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: {
      ...process.env,
      ADMIN_CREDENTIAL: 'trustpilot-test-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseUrl,
      IP_PREFIX_PEPPER: 'trustpilot-test-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'trustpilot-test-referral-secret',
      RESEND_API_KEY: 'trustpilot-test-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'trustpilot-test-turnstile-secret',
      TRUSTPILOT_MIN_REVIEWS: '50',
      TRUSTPILOT_REVIEW_COUNT: String(reviewCount),
      TRUSTPILOT_BUSINESS_UNIT_ID: ids[0],
      TRUSTPILOT_TEMPLATE_ID: ids[1],
      HOST: '0.0.0.0',
      PORT: String(port),
    },
    stdio: 'ignore',
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await globalThis.fetch(`${origin}/legit`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // The process is still starting.
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
    }
    assert.ok(ready, 'the /legit server starts');
    await run(origin);
  } finally {
    server.kill();
    await once(server, 'exit');
  }
}

async function openInBrowser(page, origin) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'valstara.test') {
      await route.abort();
      return;
    }
    const response = await globalThis.fetch(
      `${origin}${url.pathname}${url.search}`,
    );
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'text/plain',
      body: globalThis.Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.goto('http://valstara.test/legit', {
    waitUntil: 'domcontentloaded',
  });
}

test('E9-08 gates the only Trustpilot request and preserves /legit when the host fails', async () => {
  await executeFile('npm', ['run', 'build']);
  const remote = await startBrowser();
  try {
    await withDatabase(async (database, databaseUrl) => {
      const setFlag = async (enabled) => {
        await database.query(
          `INSERT INTO campaign_flag (key, enabled, updated_by)
         VALUES ('trustpilot.widget', $1, 'test')
         ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled`,
          [enabled],
        );
      };
      const assertLink = (html) => {
        assert.match(
          html,
          /<a href="https:\/\/www\.trustpilot\.com\/review\/valstara\.com" rel="noopener">our Trustpilot page<\/a>/u,
        );
        assert.ok(html.includes('You can read and leave reviews on'));
      };
      const assertMetadata = (html) => {
        assert.match(html, /<title>Who runs Valstara<\/title>/u);
        assert.match(
          html,
          /<meta name="description" content="Valstara is a trading brand/u,
        );
        assert.match(
          html,
          /<link rel="canonical" href="https:\/\/valstara\.com\/legit"/u,
        );
        const jsonLd =
          /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(
            html,
          );
        assert.ok(jsonLd);
        assert.equal(JSON.parse(jsonLd[1])['@type'], 'Organization');
        assert.match(html, /<h1[^>]*>Who runs Valstara<\/h1>/u);
        assert.doesNotMatch(
          html,
          /Source notes|\b(?:TODO|TBD|lorem ipsum|placeholder|dummy copy)\b/iu,
        );
      };

      await withServer(databaseUrl, 50, async (origin) => {
        const html = await (await globalThis.fetch(`${origin}/legit`)).text();
        assertLink(html);
        assertMetadata(html);
        assert.ok(html.includes('We do not show a Trustpilot star rating'));
        assert.ok(!html.includes(loaderUrl));
        assert.ok(!html.includes('data-template-id='));
        assert.doesNotMatch(
          html.replace(
            /<script type="application\/ld\+json">[\s\S]*?<\/script>/u,
            '',
          ),
          /<script\b|\.js(?:["?]|$)/iu,
        );
        {
          const page = await remote.browser.newPage();
          const requests = [];
          page.on('request', (request) => requests.push(request.url()));
          await openInBrowser(page, origin);
          assert.ok(!requests.some((url) => url.includes('trustpilot.com')));
          await page.close();
        }
      });

      await setFlag(true);
      await withServer(databaseUrl, 49, async (origin) => {
        const html = await (await globalThis.fetch(`${origin}/legit`)).text();
        assertLink(html);
        assert.ok(html.includes('We do not show a Trustpilot star rating'));
        assert.ok(!html.includes(loaderUrl));
        assert.ok(!html.includes('data-template-id='));
        const page = await remote.browser.newPage();
        const requests = [];
        page.on('request', (request) => requests.push(request.url()));
        await openInBrowser(page, origin);
        assert.ok(!requests.some((url) => url.includes('trustpilot.com')));
        await page.close();
      });

      await withServer(
        databaseUrl,
        50,
        async (origin) => {
          const html = await (await globalThis.fetch(`${origin}/legit`)).text();
          assertLink(html);
          assert.ok(html.includes('We do not show a Trustpilot star rating'));
          assert.ok(!html.includes(loaderUrl));
          assert.ok(!html.includes('data-template-id='));
        },
        ['test-business-unit', ''],
      );

      await withServer(databaseUrl, 50, async (origin) => {
        const html = await (await globalThis.fetch(`${origin}/legit`)).text();
        assertLink(html);
        assertMetadata(html);
        assert.ok(html.includes(loaderUrl));
        assert.match(html, /tp\.widget\.bootstrap\.min\.js"\s+async/u);
        assert.match(html, /data-businessunit-id="test-business-unit"/u);
        assert.match(html, /data-template-id="test-template"/u);
        assert.ok(!html.includes('We do not show a Trustpilot star rating'));
        assert.ok(html.includes('We will never buy reviews.'));

        {
          const page = await remote.browser.newPage();
          const requests = [];
          page.on('request', (request) => requests.push(request.url()));
          await openInBrowser(page, origin);
          assert.ok(requests.includes(loaderUrl));
          assert.equal(await page.title(), 'Who runs Valstara');
          assert.ok(
            await page
              .getByRole('heading', { name: 'How to reach us' })
              .isVisible(),
          );
          assert.equal(
            await page
              .getByRole('link', { name: 'our Trustpilot page' })
              .getAttribute('href'),
            profileUrl,
          );
          assert.ok(
            (await page.locator('body').innerText()).includes(
              'We will never buy reviews.',
            ),
          );
          await page.close();
        }
      });
    });
  } finally {
    await remote.browser.close();
    await executeFile('docker', ['rm', '--force', browserContainer]).catch(
      () => {},
    );
    if (remote.process.exitCode === null) {
      const exited = once(remote.process, 'exit');
      remote.process.kill();
      await exited;
    }
  }
});
