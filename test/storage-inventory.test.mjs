import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(root, path), 'utf8');

async function sourceFiles(directory = 'src') {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(path);
      if (!entry.isFile() || !/\.(?:astro|[cm]?[jt]sx?)$/u.test(path)) {
        return [];
      }
      return [{ path, content: await read(path) }];
    }),
  );
  return nested.flat();
}

function tableEntries(markdown) {
  const lines = markdown
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  return lines.slice(2);
}

function reconcileInventory(inventory, allowlist, files) {
  const entries = tableEntries(inventory);
  const writes = files.flatMap(({ path, content }) =>
    [
      ...content.matchAll(/\b(?:localStorage|sessionStorage)\.setItem\s*\(/gu),
    ].map((match) => ({
      path,
      key:
        content
          .slice(match.index + match[0].length)
          .match(/^\s*(['"])([^'"]+)\1/u)?.[2] ?? null,
    })),
  );
  assert.deepEqual(
    Object.keys(allowlist).filter((key) =>
      /storage|themePreference/iu.test(key),
    ),
    ['themePreference'],
  );
  assert.equal(
    entries.length,
    1,
    'the published inventory must have one entry',
  );
  assert.deepEqual(entries[0], [
    `\`${allowlist.themePreference.storageKey}\``,
    'Local storage',
    'Remembers your light or dark theme choice',
  ]);
  assert.deepEqual(writes, [
    {
      path: 'src/islands/theme-toggle.ts',
      key: allowlist.themePreference.storageKey,
    },
  ]);
}

test('the published inventory reconciles with the allowlist and the single source write', async () => {
  const inventory = await read('src/content/privacy-storage.md');
  const privacy = await read('src/content/privacy.md');
  const allowlist = JSON.parse(await read('scripts/ci/privacy-allowlist.json'));
  reconcileInventory(inventory, allowlist, await sourceFiles());
  assert.deepEqual(
    tableEntries(privacy.split('## Cookie and storage inventory\n')[1]),
    tableEntries(inventory),
  );
  assert.match(
    privacy,
    /\[full cookie and storage inventory\]\(\/privacy\/storage\)/u,
  );
});

test('a planted second storage write fails the inventory reconciliation and the security-gate fixture', async () => {
  const fixtures = JSON.parse(await read('test/fixtures/security/gates.json'));
  const fixture = fixtures['inventory-second-write'];
  const inventory = await read('src/content/privacy-storage.md');
  const allowlist = JSON.parse(await read('scripts/ci/privacy-allowlist.json'));
  const files = await sourceFiles();
  assert.match(fixture.diagnostic, /cookie-storage/u);
  assert.throws(
    () =>
      reconcileInventory(
        inventory,
        allowlist,
        files.map((file) =>
          file.path === fixture.path
            ? { ...file, content: fixture.content }
            : file,
        ),
      ),
    /Expected values to be strictly deep-equal/u,
  );
});

test(
  'the inventory page renders at its permanent route with plain no-banner reasoning',
  { timeout: 120_000 },
  async () => {
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 110_000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ADMIN_CREDENTIAL: 'inventory-test-admin-credential-32-chars',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        DATABASE_URL:
          'postgresql://valstara:valstara-local-only@127.0.0.1:5434/valstara_waitlist',
        EMAIL_BASE_URL: 'http://localhost:4321',
        EMAIL_TOKEN_SECRET: 'inventory-test-email-token-secret-32-chars',
        RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
        BREVO_WEBHOOK_TOKEN: 'inventory-test-brevo-webhook-token-32-chars',
        IP_PREFIX_PEPPER: 'inventory-test-ip-prefix-pepper',
        REFERRAL_SIGNING_SECRET: 'inventory-test-referral-secret',
        RESEND_API_KEY: 'inventory-test-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        TURNSTILE_SECRET_KEY: 'inventory-test-turnstile-secret',
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const html = await read('dist/client/privacy/storage/index.html');
    const privacyHtml = await read('dist/client/privacy/index.html');
    assert.match(
      html,
      /No non-essential information is stored on or accessed from your device/u,
    );
    assert.match(html, /three automated checks guard this/iu);
    assert.match(html, /href="\/privacy"/u);
    assert.match(privacyHtml, /href="\/privacy\/storage"/u);
    assert.doesNotMatch(html, /<script\b|\.js(?:["?]|$)/iu);
  },
);
