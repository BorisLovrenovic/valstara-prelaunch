import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from 'pg';

import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { checkRenderedHead } from '../scripts/ci/seo-build-check.ts';
import { trustLedgerCopy } from '../src/copy/trust-ledger.ts';
import { flagCacheTtlMilliseconds } from '../src/server/flags/service.ts';
import { createTrustLedger } from '../src/server/trust-ledger/ledger.ts';
import { trustLedgerView } from '../src/server/trust-ledger/presentation.ts';
import { startAppServer } from './helpers/listen-port.mjs';
import { sourcePagePaths } from './helpers/page-inventory.mjs';
import {
  trustLedgerFixtureEntries,
  trustLedgerFixtureSite,
} from './helpers/trust-ledger-fixture-site.mjs';

// E11.8-01: `/trust-ledger`, `/sitemaps/trust-ledger.xml` and the three links,
// served by the real built app (D-076 Q1 and Q2). The repository's own build
// commits no entry; the fixture site commits P11 Part 2 word for word and a
// synthetic later month. The amended flag-off criterion: with the flag off the
// page answers 404 and the child sitemap lists nothing; with no entry
// committed no link renders anywhere; links render only with an entry
// committed; and with an entry committed and the flag off the page still
// answers 404. The view model's cases are in test/trust-ledger.test.ts.

const executeFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const emptyUrlset =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n';
const listedUrlset =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://valstara.com/trust-ledger</loc></url>\n</urlset>\n';

let fixtureRoot;
let databaseName;
let databaseUrl;
let database;
let admin;
let repository;
let fixture;

function serverEnvironment(label) {
  return {
    label,
    env: (port) => ({
      ADMIN_CREDENTIAL: 'trust-ledger-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: databaseUrl,
      EMAIL_BASE_URL: `http://127.0.0.1:${port}`,
      IP_PREFIX_PEPPER: 'trust-ledger-rendered-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'trust-ledger-rendered-referral-secret',
      RESEND_API_KEY: 'trust-ledger-rendered-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'trust-ledger-rendered-turnstile-secret',
      HOST: '127.0.0.1',
    }),
  };
}

before(async () => {
  await ensureAppBuild();
  ({ root: fixtureRoot } = await trustLedgerFixtureSite());
  databaseName = `valstara_ledger_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await executeFile(
    'npx',
    ['tsx', 'src/server/db/run-migrations.ts', 'trust-ledger-rendered-test'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: databaseUrl,
        VALSTARA_APP_DB_PASSWORD: appPassword,
      },
    },
  );
  database = new Pool({ connectionString: databaseUrl });
  repository = await startAppServer({
    ...serverEnvironment('Trust Ledger repository build'),
    cwd: projectRoot,
  });
  fixture = await startAppServer({
    ...serverEnvironment('Trust Ledger fixture build'),
    cwd: fixtureRoot,
  });
});

after(async () => {
  await repository?.stop();
  await fixture?.stop();
  await database?.end();
  if (admin !== undefined) {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});

async function get(server, path) {
  const response = await globalThis.fetch(
    `http://127.0.0.1:${server.port}${path}`,
    { redirect: 'manual', signal: globalThis.AbortSignal.timeout(15_000) },
  );
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

/** Sets the flag and waits out both servers' flag caches. */
async function setFlag(enabled) {
  await database.query(
    `INSERT INTO campaign_flag (key, enabled, updated_by)
     VALUES ('trust_ledger.page', $1, 'trust-ledger-test')
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [enabled],
  );
  await new Promise((resolve) =>
    globalThis.setTimeout(resolve, flagCacheTtlMilliseconds + 500),
  );
}

function decode(text) {
  return text
    .replace(/&#39;|’/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"');
}

/** The text of each element `tag` in `html`, tags stripped and decoded. */
function texts(html, tag) {
  return [
    ...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gu')),
  ].map((match) =>
    decode(match[1].replace(/<[^>]+>/gu, ''))
      .replace(/\s+/gu, ' ')
      .trim(),
  );
}

const ledgerLink = /href="\/trust-ledger"/gu;
const fixtureViews = trustLedgerView(
  createTrustLedger(await trustLedgerFixtureEntries()),
);
const { routes } = await sourcePagePaths();

/** The page's article, from the H1 to the article's end. */
function article(html) {
  const start = html.indexOf('<article class="document__prose');
  const end = html.indexOf('</article>', start);
  assert.ok(start > 0 && end > start, 'the article is present');
  return html.slice(start, end);
}

test('flag off: /trust-ledger answers 404 and its child sitemap lists nothing, with or without an entry committed', async () => {
  await setFlag(false);
  for (const server of [repository, fixture]) {
    const page = await get(server, '/trust-ledger');
    assert.equal(page.status, 404);
    assert.doesNotMatch(page.body, /data-trust-ledger-entry/u);
    const sitemap = await get(server, '/sitemaps/trust-ledger.xml');
    assert.equal(sitemap.status, 200);
    assert.equal(
      sitemap.headers.get('content-type'),
      'application/xml; charset=utf-8',
    );
    assert.equal(sitemap.headers.get('cache-control'), 'private, no-store');
    assert.equal(sitemap.body, emptyUrlset);
  }
});

test('with no entry committed, no link to the Trust Ledger renders anywhere, and the page answers 404 even with the flag on', async () => {
  // Every page of the inventory, plus the branded 404, on the repository's
  // build, which commits no entry (D-076 Q2).
  for (const path of [...routes, '/not-a-page']) {
    const page = await get(repository, path);
    assert.doesNotMatch(page.body, ledgerLink, `${path} links the Ledger`);
    assert.doesNotMatch(page.body, /data-trust-ledger-link/u, path);
  }
  await setFlag(true);
  try {
    assert.equal((await get(repository, '/trust-ledger')).status, 404);
    assert.equal(
      (await get(repository, '/sitemaps/trust-ledger.xml')).body,
      emptyUrlset,
    );
    // The flag does not bring a link: the links follow committed entries.
    for (const path of ['/', '/guarantee', '/partners', '/about'])
      assert.doesNotMatch((await get(repository, path)).body, ledgerLink);
  } finally {
    await setFlag(false);
  }
});

test('with an entry committed, the footer, /guarantee and /partners link the Ledger whatever the flag, and the page answers 404 while the flag is off', async () => {
  const line = `${trustLedgerCopy.link.lead}${trustLedgerCopy.link.label}${trustLedgerCopy.link.end}`;
  for (const enabled of [false, true]) {
    await setFlag(enabled);
    // The P11 Part 3 line, beside the content in the side card, never in the
    // page's own content.
    for (const path of ['/guarantee', '/partners']) {
      const page = await get(fixture, path);
      assert.equal(page.status, 200, path);
      const cardLines = [
        ...page.body.matchAll(
          /<p class="document__card-body"[^>]*data-trust-ledger-link[^>]*>([\s\S]*?)<\/p>/gu,
        ),
      ].map((match) =>
        decode(match[1].replace(/<[^>]+>/gu, ''))
          .replace(/\s+/gu, ' ')
          .trim(),
      );
      assert.deepEqual(cardLines, [line], path);
      assert.doesNotMatch(article(page.body), ledgerLink, path);
    }
    // The footer link, after Guarantee, on static and server-rendered pages
    // and on the branded 404.
    for (const path of [
      '/',
      '/about',
      '/legit',
      '/guarantee',
      '/terms',
      '/privacy',
      '/giveaway/rules',
      '/leaderboard',
      '/not-a-page',
    ]) {
      const page = await get(fixture, path);
      const footer = page.body.slice(page.body.indexOf('<footer'));
      assert.deepEqual(
        [...footer.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/gu)]
          .map((match) => match[1])
          .filter((href) => ['/guarantee', '/trust-ledger'].includes(href)),
        ['/guarantee', '/trust-ledger'],
        `${path} footer`,
      );
    }
    assert.equal(
      (await get(fixture, '/trust-ledger')).status,
      enabled ? 200 : 404,
    );
  }
  await setFlag(false);
});

test('with the flag on and entries committed, /trust-ledger renders every entry newest first, P11 Part 2 word for word, and "How we count"', async () => {
  await setFlag(true);
  try {
    const page = await get(fixture, '/trust-ledger');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'private, no-store');
    checkRenderedHead(page.body, '/trust-ledger', {
      titles: new Set(),
      descriptions: new Set(),
    });
    assert.match(page.body, /<title>The Trust Ledger<\/title>/u);
    assert.match(
      page.body,
      /<meta property="og:image" content="https:\/\/valstara\.com\/images\/og\/fallback\/trust\.png"/u,
    );
    // No island and no script but the page-view emitter.
    const scripts = [...page.body.matchAll(/<script\b([^>]*)>/gu)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      scripts.filter(
        (attributes) => !/type="application\/ld\+json"/u.test(attributes),
      ),
      [scripts.find((attributes) => /src="\/page-view\.js"/u.test(attributes))],
    );
    assert.doesNotMatch(page.body, /<astro-island\b|data-theme-toggle/u);
    const body = article(page.body);
    // One H1, then every month newest first, then "How we count".
    assert.deepEqual(texts(page.body, 'h1'), ['The Trust Ledger']);
    assert.deepEqual(
      [...body.matchAll(/data-trust-ledger-entry="([^"]+)"/gu)].map(
        (match) => match[1],
      ),
      ['2027-01', '2026-12'],
    );
    assert.match(
      body,
      /data-trust-ledger-entry="2027-01"[^>]*data-trust-ledger-newest/u,
    );
    assert.deepEqual(texts(body, 'h2'), [
      'January 2027',
      'December 2026',
      'How we count',
    ]);
    // Every heading, paragraph and list item of each entry, in order.
    const rendered = [
      ...body.matchAll(/<(h2|h3|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gu),
    ].map((match) =>
      decode(match[2].replace(/<[^>]+>/gu, ''))
        .replace(/\s+/gu, ' ')
        .trim(),
    );
    const expected = fixtureViews.flatMap((view) => [
      view.heading,
      ...view.sections.flatMap((section) => [
        section.heading,
        ...section.blocks.flatMap((block) =>
          block.kind === 'paragraphs' ? block.paragraphs : block.items,
        ),
      ]),
    ]);
    assert.deepEqual(rendered.slice(0, expected.length), expected);
    // P11 Part 2, word for word, from the prerequisite itself.
    const p11 = await readFile(
      'docs/prerequisites/p11-trust-ledger-text.md',
      'utf8',
    );
    const partTwo = p11.slice(
      p11.indexOf('## Part 2'),
      p11.indexOf('\n---\n', p11.indexOf('## Part 2')),
    );
    const december = rendered.slice(rendered.indexOf('December 2026'));
    for (const raw of partTwo.split('\n').slice(1)) {
      const line = raw.trim().replace(/^### |^- /u, '');
      if (line === '' || line.startsWith('*Written by')) continue;
      assert.ok(december.includes(line), `renders: ${line}`);
    }
    // "How we count" is P11 Part 1, as written.
    const partOne = p11
      .slice(p11.indexOf('## Part 1'), p11.indexOf('## Part 2'))
      .split('\n')
      .slice(1)
      .map((raw) =>
        raw
          .trim()
          .replace(/^### |^- |^\d+\. /u, '')
          .replace(/\*\*/gu, ''),
      )
      .filter((line) => line !== '' && line !== '---');
    // Its lists nest, so it is compared as text, every tag a space.
    const howWeCount = decode(
      body.slice(body.indexOf('id="how-we-count"')).replace(/<[^>]+>/gu, ' '),
    ).replace(/\s+/gu, ' ');
    for (const line of partOne)
      assert.ok(howWeCount.includes(line), `How we count: ${line}`);
    // The child sitemap lists the page; the static index lists the child,
    // and the static pages sitemap never lists the page.
    assert.equal(
      (await get(fixture, '/sitemaps/trust-ledger.xml')).body,
      listedUrlset,
    );
    const index = await get(fixture, '/sitemap.xml');
    assert.match(
      index.body,
      /<loc>https:\/\/valstara\.com\/sitemaps\/trust-ledger\.xml<\/loc>/u,
    );
    const pages = await get(fixture, '/sitemaps/pages.xml');
    assert.equal(pages.status, 200);
    assert.doesNotMatch(pages.body, /trust-ledger/u);
  } finally {
    await setFlag(false);
  }
});

test(
  'an entry that fails its schema fails the Astro build',
  { timeout: 300_000 },
  async () => {
    // The bundled ledger is validated when the prerendered pages render, so
    // `astro build` alone fails, even without the prebuild check.
    const root = await mkdtemp(join(tmpdir(), 'valstara-ledger-invalid-'));
    try {
      for (const input of [
        'src',
        'public',
        'astro.config.mjs',
        'config',
        'data/price-index',
        'packages/price-index/src/publish',
        'packages/price-index/src/schema',
      ])
        await cp(join(projectRoot, input), join(root, input), {
          recursive: true,
        });
      await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
      await symlink(
        join(projectRoot, 'node_modules'),
        join(root, 'node_modules'),
      );
      const entry = JSON.parse(
        await readFile('test/fixtures/trust-ledger/2026-12.json', 'utf8'),
      );
      entry.supplyReadiness.total.rejected = 181;
      await writeFile(
        join(root, 'src/content/trust-ledger/2026-12.json'),
        JSON.stringify(entry),
      );
      const result = spawnSync(
        join(projectRoot, 'node_modules/.bin/astro'),
        ['build'],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
          timeout: 240_000,
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.status, 0, output);
      assert.match(output, /The Trust Ledger is invalid/u);
      assert.match(output, /verified \+ rejected must equal evaluated/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
