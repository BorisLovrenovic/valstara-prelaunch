import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';

import { checkCutover, type CutoverRules } from '../scripts/cutover-check.ts';

const destinations = {
  accountPath: '/account',
  privacyRightsPath: '/privacy/rights',
  emailPreferencesPath: '/email-preferences',
};

async function fixture(
  run: (
    url: string,
    state: { applications: number; attempts: number },
    rules: CutoverRules,
  ) => Promise<void>,
  broken?: string,
) {
  const token = 'local-fixture-unsubscribe-token';
  const expiredToken = 'local-fixture-expired-unsubscribe-token';
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const revisionNames = (
    await readdir(new URL('../src/content/giveaway-rules/', import.meta.url))
  )
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -3))
    .sort();
  const articles = new Map(
    revisionNames.map((version) => [version, `<h1>${version}</h1>`] as const),
  );
  const revisions = revisionNames.map((version) => ({
    version,
    sha256: createHash('sha256')
      .update(articles.get(version)!, 'utf8')
      .digest('hex'),
  }));
  const revisionHashes = new Map(
    revisions.map(({ version, sha256 }) => [version, sha256]),
  );
  const currentVersion = revisionNames.at(-1);
  assert.ok(currentVersion);
  const rules = { currentVersion, revisions };
  const state = { applications: 0, attempts: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === broken) {
      response.writeHead(404).end();
    } else if (['/waitlist', '/leaderboard', '/me', '/dsr'].includes(path)) {
      response
        .writeHead(301, {
          Location:
            path === '/dsr' && broken === 'wrong-dsr-target'
              ? '/'
              : path === '/dsr'
                ? '/privacy/rights'
                : path === '/me'
                  ? '/account'
                  : '/',
        })
        .end();
    } else if (
      path === '/giveaway/award' ||
      path === '/verify' ||
      (path.startsWith('/api/') && path !== '/api/unsubscribe')
    ) {
      response.writeHead(410).end();
    } else if (
      (path === '/unsubscribe' && url.searchParams.get('t') === expiredToken) ||
      (path === '/api/unsubscribe' &&
        url.searchParams.get('token') === expiredToken)
    ) {
      response.writeHead(301, { Location: '/email-preferences' }).end();
    } else if (path === '/api/unsubscribe' && request.method === 'POST') {
      state.attempts += 1;
      const presentedHash = createHash('sha256')
        .update(url.searchParams.get('token') ?? '')
        .digest('hex');
      let form = '';
      for await (const chunk of request) form += String(chunk);
      if (
        presentedHash !== tokenHash ||
        new URLSearchParams(form).get('List-Unsubscribe') !== 'One-Click'
      ) {
        response.writeHead(400).end();
      } else {
        if (state.applications === 0) state.applications += 1;
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ status: 'accepted' }));
      }
    } else if (path === '/sitemap.xml') {
      response
        .writeHead(200, { 'Content-Type': 'application/xml' })
        .end(
          `<urlset><url><loc>https://valstara.com/giveaway/rules/${currentVersion}</loc></url></urlset>`,
        );
    } else if (
      path === '/giveaway/rules' ||
      path.startsWith('/giveaway/rules/')
    ) {
      const version =
        path === '/giveaway/rules' ? currentVersion : path.split('/').at(-1)!;
      const sha256 = revisionHashes.get(version);
      if (!sha256) response.writeHead(404).end();
      else
        response
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end(
            `<html><head>${version !== currentVersion ? '<meta name="robots" content="noindex">' : ''}</head><body>${version !== currentVersion ? '<aside data-archived-rules-notice></aside>' : ''}<article data-rules-version="${version}" data-rules-sha256="${sha256}">${broken === 'changed-rules-article' && version === currentVersion ? 'Changed article' : articles.get(version)}</article></body></html>`,
          );
    } else if (path === '/unsubscribe' && url.searchParams.get('t') !== token) {
      response.writeHead(404).end();
    } else {
      response.writeHead(200).end('fixture content');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No fixture address.');
    await run(`http://127.0.0.1:${address.port}`, state, rules);
  } finally {
    server.close();
    await new Promise<void>((resolve) => server.once('close', resolve));
  }
}

test('local cutover fixture proves retained, redirect, 410 and one-click routes', async () => {
  await fixture(async (url, state, rules) => {
    const result = await checkCutover(
      url,
      'local-fixture-unsubscribe-token',
      'local-fixture-expired-unsubscribe-token',
      destinations,
      fetch,
      rules,
    );
    assert.ok(
      result.checked.includes('/giveaway/rules/VAL-GW-LAUNCH-20261009-r1'),
    );
    assert.equal(state.applications, 1);
    assert.equal(state.attempts, 2);
  });
});

test('a missing retained route aborts cutover', async () => {
  await fixture(async (url, _state, rules) => {
    await assert.rejects(
      checkCutover(
        url,
        'local-fixture-unsubscribe-token',
        'local-fixture-expired-unsubscribe-token',
        destinations,
        fetch,
        rules,
      ),
      /\/privacy returned 404/u,
    );
  }, '/privacy');
});

test('a redirect to the wrong 200 page aborts cutover', async () => {
  await fixture(async (url, _state, rules) => {
    await assert.rejects(
      checkCutover(
        url,
        'local-fixture-unsubscribe-token',
        'local-fixture-expired-unsubscribe-token',
        destinations,
        fetch,
        rules,
      ),
      /\/dsr redirects to \/, expected \/privacy\/rights/u,
    );
  }, 'wrong-dsr-target');
});

test('changed rules article content aborts cutover despite the advertised hash', async () => {
  await fixture(async (url, _state, rules) => {
    await assert.rejects(
      checkCutover(
        url,
        'local-fixture-unsubscribe-token',
        'local-fixture-expired-unsubscribe-token',
        destinations,
        fetch,
        rules,
      ),
      /\/giveaway\/rules article content has a SHA-256 mismatch/u,
    );
  }, 'changed-rules-article');
});
