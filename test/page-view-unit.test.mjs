import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(
  new URL('../public/page-view.js', import.meta.url),
  'utf8',
);
const websiteId = 'a4041033-3269-4a73-8772-c16f9bdf1a33';

function runEmitter({ path = '/privacy', fetchImpl, referrer = '' } = {}) {
  const requests = [];
  const storageTouches = [];
  const sandbox = {
    location: {
      pathname: path,
      search: '?ref=private-code&token=private-token',
      hash: '#private-fragment',
      hostname: 'valstara.com',
    },
    document: {
      currentScript: { dataset: { websiteId } },
      referrer,
      title: 'Valstara',
      documentElement: { lang: 'en' },
    },
    URL,
    fetch(url, options) {
      requests.push({ url, options });
      return fetchImpl?.() ?? Promise.resolve({ ok: true });
    },
  };
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) {
    Object.defineProperty(sandbox, name, {
      get() {
        storageTouches.push(name);
        throw new Error(`${name} was accessed`);
      },
    });
  }
  Object.defineProperty(sandbox.document, 'cookie', {
    get() {
      storageTouches.push('cookie');
      throw new Error('cookie was accessed');
    },
    set() {
      storageTouches.push('cookie');
      throw new Error('cookie was written');
    },
  });
  runInNewContext(source, sandbox);
  return { requests, storageTouches };
}

test('one page load sends only the approved fields with no URL query or fragment', () => {
  const { requests, storageTouches } = runEmitter({
    path: '/privacy',
    referrer: 'https://partner.example/private?token=secret#fragment',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/analytics/api/send');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
  assert.equal(requests[0].options.keepalive, true);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    type: 'event',
    payload: {
      website: websiteId,
      hostname: 'valstara.com',
      url: '/privacy',
      referrer: 'https://partner.example',
      title: 'Valstara',
      language: 'en',
    },
  });
  assert.deepEqual(storageTouches, []);
});

test('personal-context and admin paths emit nothing', () => {
  for (const path of [
    '/me',
    '/me/',
    '/verify',
    '/unsubscribe',
    '/admin',
    '/admin/fraud',
    '/api/admin/health',
  ]) {
    const { requests, storageTouches } = runEmitter({ path });
    assert.equal(requests.length, 0, path);
    assert.deepEqual(storageTouches, [], path);
  }
});

test('an unavailable collector cannot throw into page execution', async () => {
  assert.doesNotThrow(() =>
    runEmitter({
      fetchImpl() {
        throw new Error('collector is down');
      },
    }),
  );
  const { requests } = runEmitter({
    fetchImpl() {
      return Promise.reject(new Error('collector is down'));
    },
  });
  assert.equal(requests.length, 1);
  await Promise.resolve();
});
