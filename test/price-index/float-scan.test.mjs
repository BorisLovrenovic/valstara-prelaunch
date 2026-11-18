import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanPriceIndexFloats } from '../../scripts/ci/price-index-float-scan.mjs';
import { runSecurityGates } from '../../scripts/ci/security-gates.mjs';

// E11.6-03: no float holds a price. The scan finds no `parseFloat` and no
// `Number(` anywhere in packages/price-index/src. Each red path plants one
// conversion; each green path plants the nearest permitted shape, so the scan
// cannot pass by flagging everything.

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

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

test('the price-index source, as it stands on disk, has no float conversion', async () => {
  // Read from disk, not from git, so files not yet committed are scanned too.
  const paths = await walk(join(projectRoot, 'packages/price-index/src'));
  const files = await Promise.all(
    paths.map(async (path) => ({
      path: relative(projectRoot, path).split('\\').join('/'),
      content: await readFile(path, 'utf8'),
    })),
  );
  assert.ok(
    files.some(
      (file) => file.path === 'packages/price-index/src/money/parse.ts',
    ),
  );
  assert.deepEqual(scanPriceIndexFloats(files), []);
});

const red = [
  'const price = parseFloat(text);',
  'const price = Number.parseFloat(text);',
  'const price = Number(text);',
  'const price = Number (text);',
  'const price = new Number(text);',
  'const prices = texts.map((text) => Number(text));',
  '// a comment that suggests parseFloat is also refused',
];

for (const content of red) {
  test(`the scan flags: ${content}`, () => {
    const issues = scanPriceIndexFloats([
      { path: 'packages/price-index/src/money/planted.ts', content },
    ]);
    assert.equal(issues.length, 1, JSON.stringify(issues));
    assert.equal(issues[0].scan, 'price-index-floats');
    assert.equal(issues[0].path, 'packages/price-index/src/money/planted.ts');
    assert.match(issues[0].message, /^line 1: (parseFloat|Number\()/);
  });
}

test('the scan reports the line of each conversion', () => {
  const issues = scanPriceIndexFloats([
    {
      path: 'packages/price-index/src/sources/planted.ts',
      content:
        'const a = 1n;\nconst b = Number(a);\n\nconst c = parseFloat("1");\n',
    },
  ]);
  assert.deepEqual(issues.map((issue) => issue.message.split(':')[0]).sort(), [
    'line 2',
    'line 4',
  ]);
});

test('the scan passes the nearest permitted shapes', () => {
  const green = [
    'const count = Number.parseInt(text, 10);',
    'const whole = Number.isInteger(value);',
    'const ok = isNumber(value);',
    'const amount = BigInt(text);',
    'type Amount = number;',
    'const label = "a Number";',
  ];
  for (const content of green) {
    assert.deepEqual(
      scanPriceIndexFloats([
        { path: 'packages/price-index/src/money/planted.ts', content },
      ]),
      [],
      content,
    );
  }
});

test('the scan covers the package source only', () => {
  const content = 'const price = parseFloat(text);';
  for (const path of [
    'packages/price-index/test/planted.ts',
    'src/server/prices/planted.ts',
    'packages/price-index/src/money/README.md',
  ]) {
    assert.deepEqual(scanPriceIndexFloats([{ path, content }]), [], path);
  }
  for (const path of [
    'packages/price-index/src/cli/planted.mjs',
    'packages/price-index/src/planted.js',
    'packages/price-index/src/publish/planted.tsx',
  ]) {
    assert.equal(scanPriceIndexFloats([{ path, content }]).length, 1, path);
  }
});

test('npm run security runs the float scan', async () => {
  const source = await readFile(
    join(projectRoot, 'scripts/ci/security-gates.mjs'),
    'utf8',
  );
  assert.match(source, /scanPriceIndexFloats\(files\)/);
  const issues = await runSecurityGates({ audit: false, base: undefined });
  assert.deepEqual(
    issues.filter((issue) => issue.scan === 'price-index-floats'),
    [],
  );
});
