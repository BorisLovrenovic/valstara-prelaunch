import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { Pool } from 'pg';

const executeFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const localOrigin = 'http://127.0.0.1:8080';
const browserOrigin = 'http://caddy:8080';
const websiteId = 'a4041033-3269-4a73-8772-c16f9bdf1a33';
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const databaseUrl = 'postgresql://umami:umami-local-only@127.0.0.1:5434/umami';

let database;
let insertedWebsite = false;
let composeNetwork;

async function compose(args) {
  return executeFile(
    'docker',
    ['compose', '-f', 'infra/compose/docker-compose.yml', ...args],
    { timeout: 60_000 },
  );
}

async function browserProbe(mode) {
  const name = `valstara-pageview-${mode}-${process.pid}`;
  try {
    const { stdout } = await executeFile(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        name,
        '--network',
        composeNetwork,
        '--volume',
        `${projectRoot}:/work:ro`,
        '--workdir',
        '/work',
        playwrightImage,
        'node',
        '/work/scripts/fixtures/page-view-browser.mjs',
        mode,
      ],
      { timeout: 90_000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } finally {
    await executeFile('docker', ['rm', '--force', name], {
      timeout: 10_000,
    }).catch(() => {
      // --rm also removes the container when docker run exits or is timed out.
    });
  }
}

before(async () => {
  const response = await globalThis.fetch(`${localOrigin}/privacy`, {
    signal: globalThis.AbortSignal.timeout(5_000),
  });
  assert.equal(
    response.ok,
    true,
    'the local first-party proxy must be running',
  );
  const { stdout } = await compose(['config', '--format', 'json']);
  composeNetwork = JSON.parse(stdout).networks.default.name;
  assert.ok(composeNetwork, 'the browser must join the proxy network');
  await compose(['up', '-d', '--wait', 'umami']);
  database = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
  const inserted = await database.query(
    `INSERT INTO website (website_id, name, domain)
     VALUES ($1, 'Valstara', 'valstara.com')
     ON CONFLICT (website_id) DO NOTHING
     RETURNING website_id`,
    [websiteId],
  );
  insertedWebsite = inserted.rowCount === 1;
});

after(async () => {
  if (database) {
    if (insertedWebsite) {
      await database.query('DELETE FROM website WHERE website_id = $1', [
        websiteId,
      ]);
    }
    await database.end();
  }
});

test('the live page emits one private-field-free view through the first-party proxy and Umami records it', async () => {
  const beforeCount = await database.query(
    `SELECT COUNT(*)::integer AS count FROM website_event
     WHERE website_id = $1 AND url_path = '/privacy'`,
    [websiteId],
  );
  const result = await browserProbe('live');
  assert.equal(result.pageStatus, 200);
  assert.equal(result.emitterScripts, 1);
  assert.equal(result.collectorRequests.length, 1);
  assert.equal(result.collectorReferer, null);
  assert.equal(result.collectorStatus, 200);
  assert.deepEqual(result.storageTouches, []);
  assert.deepEqual(result.cookies, []);
  assert.equal(result.pageSetCookie, null);
  assert.ok(
    result.requestUrls.every((url) => new URL(url).origin === browserOrigin),
    `off-origin request: ${result.requestUrls.join(', ')}`,
  );
  const posted = result.collectorRequests[0];
  assert.deepEqual(posted, {
    type: 'event',
    payload: {
      website: websiteId,
      hostname: 'caddy',
      url: '/privacy',
      referrer: 'https://partner.example',
      title: result.pageTitle,
      language: 'en',
    },
  });
  let afterCount;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    afterCount = await database.query(
      `SELECT COUNT(*)::integer AS count FROM website_event
       WHERE website_id = $1 AND url_path = '/privacy'`,
      [websiteId],
    );
    if (afterCount.rows[0].count > beforeCount.rows[0].count) break;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  assert.equal(afterCount.rows[0].count, beforeCount.rows[0].count + 1);
  const recorded = await database.query(
    `SELECT url_path, url_query, referrer_domain, referrer_path, page_title
     FROM website_event WHERE website_id = $1 AND url_path = '/privacy'
     ORDER BY created_at DESC LIMIT 1`,
    [websiteId],
  );
  assert.equal(recorded.rows[0]?.url_path, '/privacy');
  assert.equal(recorded.rows[0]?.url_query, '');
  assert.equal(recorded.rows[0]?.referrer_domain, 'partner.example');
  assert.equal(recorded.rows[0]?.referrer_path, '/');
  assert.equal(recorded.rows[0]?.page_title, posted.payload.title);
});

test('personal-context pages and admin routes do not emit', async () => {
  const result = await browserProbe('excluded');
  assert.deepEqual(result, [
    {
      path: '/me?token=private-token',
      emitterScripts: 0,
      collectorRequests: 0,
    },
    {
      path: '/verify?token=private-token',
      emitterScripts: 0,
      collectorRequests: 0,
    },
    {
      path: '/unsubscribe?token=private-token',
      emitterScripts: 0,
      collectorRequests: 0,
    },
    { path: '/api/admin/draw', emitterScripts: 0, collectorRequests: 0 },
  ]);
});

test('collector outage does not affect the rendered response', async () => {
  const { stdout } = await compose(['config', '--format', 'json']);
  const config = JSON.parse(stdout);
  assert.equal(config.services.caddy.depends_on.umami, undefined);
  await compose(['stop', 'caddy', 'umami']);
  try {
    await compose(['up', '-d', 'caddy']);
    const { stdout: runningServices } = await compose([
      'ps',
      '--status',
      'running',
      '--services',
    ]);
    assert.equal(runningServices.split(/\s+/u).includes('umami'), false);
    const result = await browserProbe('down');
    assert.equal(result.pageStatus, 200);
    assert.ok(result.pageTitle.length > 0);
    assert.equal(result.collectorRequests, 1);
    assert.ok(result.collectorStatus === null || result.collectorStatus >= 500);
  } finally {
    await compose(['up', '-d', '--wait', 'umami', 'caddy']);
  }
});

test('the proxy does not expose Umami tracker or dashboard paths', async () => {
  for (const path of [
    '/analytics/script.js',
    '/analytics/',
    '/analytics/api/websites',
  ]) {
    const response = await globalThis.fetch(`${localOrigin}${path}`);
    assert.equal(response.status, 404, path);
  }
});
