import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  scanAstroLiteralValues,
  scanAstroTree,
} from '../scripts/ci/literal-values.mjs';

for (const [fixture, expected] of [
  ['page', 'literal colour'],
  ['island', 'literal min-width'],
  ['media', 'unregistered media-query length 48rem'],
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
  assert.deepEqual(
    scanAstroLiteralValues(
      '<style>@media (min-width: 40rem) { main { margin-block: 0 var(--space-2); width: calc(100% - var(--gutter)); } } @media (min-width: 64rem) {} @media (min-width: 80rem) {}</style>',
    ),
    [],
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
