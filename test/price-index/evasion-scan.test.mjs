import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanPriceIndexEvasion } from '../../scripts/ci/price-index-evasion-scan.mjs';
import { runSecurityGates } from '../../scripts/ci/security-gates.mjs';

// E11.6-04: a scan finds no CAPTCHA-solving code or service, and no proxy or
// IP rotation, in the price-index package. Each red path plants one; each
// green path plants the nearest permitted shape.

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const planted = 'packages/price-index/src/http/planted.ts';

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return files.flat();
}

test('the price-index package, as it stands on disk, passes the scan', async () => {
  // Read from disk, not from git, so files not yet committed are scanned too.
  const paths = await walk(join(projectRoot, 'packages/price-index'));
  const files = await Promise.all(
    paths.map(async (path) => ({
      path: relative(projectRoot, path).split('\\').join('/'),
      content: await readFile(path, 'utf8'),
    })),
  );
  assert.ok(
    files.some(
      (file) =>
        file.path === 'packages/price-index/src/http/playwright-driver.ts',
    ),
  );
  const packageJson = JSON.parse(
    await readFile(join(projectRoot, 'package.json'), 'utf8'),
  );
  assert.deepEqual(scanPriceIndexEvasion(files, packageJson), []);
});

const red = [
  ["import { Solver } from '2captcha';", 'CAPTCHA'],
  ['await page.solveRecaptchas();', 'CAPTCHA'],
  ['const key = process.env.CAPSOLVER_KEY; // hCaptcha', 'CAPTCHA'],
  [
    "await chromium.launch({ proxy: { server: 'http://10.0.0.1:3128' } });",
    'proxy',
  ],
  ["const args = ['--proxy-server=http://10.0.0.1:3128'];", 'proxy'],
  ['const pool = loadProxies();', 'proxy'],
  ['const agent = process.env.HTTPS_PROXY;', 'proxy'],
  ["const upstream = 'socks5://127.0.0.1:9050';", 'SOCKS address'],
  ["headers['X-Forwarded-For'] = nextAddress();", 'client-address header'],
  [
    "const args = ['--host-resolver-rules=MAP * 10.0.0.1'];",
    'host mapped to an address',
  ],
  ['function rotateEgressIp() {} // rotate the ip', 'IP rotation'],
];

for (const [content, name] of red) {
  test(`the scan flags ${name}: ${content}`, () => {
    const issues = scanPriceIndexEvasion([{ path: planted, content }]);
    assert.ok(issues.length >= 1, JSON.stringify(issues));
    assert.ok(issues.every((issue) => issue.scan === 'price-index-evasion'));
    assert.ok(
      issues.some((issue) => issue.message.startsWith(`line 1: ${name}`)),
    );
    assert.equal(issues[0].path, planted);
  });
}

for (const name of [
  '2captcha',
  'puppeteer-extra-plugin-recaptcha',
  'proxy-chain',
  'https-proxy-agent',
  'socks-proxy-agent',
]) {
  test(`the scan flags the dependency ${name}`, () => {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ]) {
      const issues = scanPriceIndexEvasion([], {
        [field]: { [name]: '1.0.0' },
      });
      assert.equal(issues.length, 1, field);
      assert.equal(issues[0].path, 'package.json');
      assert.match(issues[0].message, new RegExp(`^${field} ${name}:`));
    }
  });
}

test('the scan passes the nearest permitted shapes', () => {
  for (const content of [
    "const args = ['--disable-blink-features=AutomationControlled'];",
    "userAgent.replace('HeadlessChrome', 'Chrome');",
    'await rotateRuns(rawRoot, keep, runId);',
    '// rotated to the last six runs; an approximate figure',
    "const header = response.headers()['retry-after'];",
    'const checkpointTitle = /vercel security checkpoint/iu;',
    '`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${hostname}`',
  ]) {
    assert.deepEqual(
      scanPriceIndexEvasion([{ path: planted, content }]),
      [],
      content,
    );
  }
  assert.deepEqual(
    scanPriceIndexEvasion([], {
      devDependencies: { playwright: '1.62.1', zod: '4.6.7' },
    }),
    [],
  );
});

test('the scan reads the package’s code files only', () => {
  const content = "await chromium.launch({ proxy: { server: 'http://x' } });";
  for (const path of [
    'packages/price-index/test/fixtures/youfundceo/pages/home.html',
    'src/server/prices/planted.ts',
    'packages/price-index/README.md',
  ]) {
    assert.deepEqual(scanPriceIndexEvasion([{ path, content }]), [], path);
  }
  for (const path of [
    'packages/price-index/src/cli/planted.mjs',
    'packages/price-index/copy/planted.ts',
    'packages/price-index/test/planted.js',
  ]) {
    assert.equal(scanPriceIndexEvasion([{ path, content }]).length, 1, path);
  }
});

test('npm run security runs the evasion scan, and the repository passes it', async () => {
  const source = await readFile(
    join(projectRoot, 'scripts/ci/security-gates.mjs'),
    'utf8',
  );
  assert.match(source, /scanPriceIndexEvasion\(files, packageJson\)/);
  const issues = await runSecurityGates({ audit: false, base: undefined });
  assert.deepEqual(
    issues.filter((issue) => issue.scan === 'price-index-evasion'),
    [],
  );
});
