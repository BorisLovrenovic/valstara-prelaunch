import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  designBreakpoints,
  scanAstroLiteralValues,
  scanAstroTree,
} from '../scripts/ci/literal-values.mjs';

for (const [fixture, expected] of [
  ['page', 'literal colour'],
  ['island', 'literal min-width'],
  // E11.5-11a: small is below 48rem, so a planted 40rem small-layout query
  // is outside the closed set and fails.
  ['media', 'unregistered media-query length 40rem'],
  ['expression', 'literal width: 20px'],
]) {
  test(`planted ${fixture} literal fails the CI scanner`, async () => {
    const source = await readFile(
      new URL(`fixtures/literal-values/${fixture}.astro`, import.meta.url),
      'utf8',
    );
    assert.ok(
      scanAstroLiteralValues(source).some((issue) => issue.includes(expected)),
    );
  });
}

test('the closed media set and tokenised compound values pass', () => {
  // E11.5-11a: the closed set is exactly the wireframe breakpoints. 40rem is
  // not retained, because no source query still uses it.
  assert.deepEqual(designBreakpoints, ['22.5rem', '48rem', '64rem', '80rem']);
  assert.deepEqual(
    scanAstroLiteralValues(
      '<style>@media (min-width: 22.5rem) {} @media (min-width: 48rem) { main { margin-block: 0 var(--space-2); width: calc(100% - var(--gutter)); box-shadow: var(--shadow-1), var(--edge); } } @media (min-width: 64rem) {} @media (min-width: 80rem) {}</style>',
    ),
    [],
  );
  for (const width of ['40rem', '47.9375rem', '768px']) {
    assert.ok(
      scanAstroLiteralValues(
        `<style>@media (min-width: ${width}) {}</style>`,
      ).some((issue) => issue.includes(width)),
      width,
    );
  }
  assert.ok(
    scanAstroLiteralValues(
      '<style>main { box-shadow: var(--shadow-1), 0 0 0 1px var(--line); }</style>',
    ).length > 0,
    'a token list with a literal layer still fails',
  );
  assert.ok(
    scanAstroLiteralValues('<style>main { width: calc(100% - 12px); }</style>')
      .length > 0,
  );
  for (const declaration of [
    'font-weight: normal',
    'font-size: medium',
    'letter-spacing: normal',
    'z-index: 5',
  ]) {
    assert.ok(
      scanAstroLiteralValues(`<style>main { ${declaration}; }</style>`).length >
        0,
      declaration,
    );
  }
});

test('every shipping Astro source passes the extended scan', async () => {
  assert.deepEqual(
    await scanAstroTree(fileURLToPath(new URL('..', import.meta.url))),
    [],
  );
});
