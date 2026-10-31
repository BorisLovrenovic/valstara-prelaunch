import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  designBreakpoints,
  scanAstroLiteralValues,
  scanAstroTree,
  scannedStylesheet,
  scanStylesheetLiteralValues,
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

// E11.5-11i: motion values come from tokens too. Each planted motion literal
// fails, in a component and in a global stylesheet.
for (const [fixture, expected] of [
  ['transition', 'literal transition: opacity 300ms'],
  ['easing', 'literal transition-timing-function: cubic-bezier('],
  ['keyframe', 'literal keyframe transform: translateY(20px)'],
]) {
  test(`planted ${fixture} motion literal fails the CI scanner`, async () => {
    const source = await readFile(
      new URL(`fixtures/literal-values/${fixture}.astro`, import.meta.url),
      'utf8',
    );
    const issues = scanAstroLiteralValues(source);
    assert.ok(
      issues.some((issue) => issue.includes(expected)),
      JSON.stringify(issues),
    );
  });
}

test('a planted literal in a global stylesheet fails, and tokens.css is the one stylesheet not scanned', async () => {
  const source = await readFile(
    new URL('fixtures/literal-values/stylesheet.css', import.meta.url),
    'utf8',
  );
  assert.deepEqual(scanStylesheetLiteralValues(source), [
    'literal animation-delay: 120ms',
  ]);
  assert.equal(scannedStylesheet('src/styles/motion.css'), true);
  assert.equal(scannedStylesheet('src/styles/planted.css'), true);
  assert.equal(scannedStylesheet('src/styles/tokens.css'), false);
  // tokens.css defines the values, so it would fail a scan it is exempt from.
  assert.ok(
    scanStylesheetLiteralValues(
      await readFile(
        new URL('../src/styles/tokens.css', import.meta.url),
        'utf8',
      ),
    ).length > 0,
  );
});

test('every motion literal the scan covers fails, and the tokenised forms pass', () => {
  for (const declaration of [
    'transition: transform 0.3s var(--ease-out)',
    'transition: opacity var(--duration-fast) ease-in-out',
    'animation: planted var(--duration-enter) steps(4)',
    'transition-delay: 50ms',
    'animation-delay: calc(2 * 60ms)',
    'animation-timing-function: ease',
    'animation-timing-function: linear(0, 1)',
    'animation-range: entry 10% cover 30%',
    'animation-range-start: entry 2rem',
    'translate: 0 8px',
    'scale: calc(1 + 4px)',
    'rotate: x 4px',
    'transform: translateX(3px)',
    'transform: translate3d(0, -2px, 0) rotate(45deg)',
  ]) {
    assert.ok(
      scanAstroLiteralValues(`<style>main { ${declaration}; }</style>`).length >
        0,
      declaration,
    );
  }
  for (const keyframe of [
    'from { translate: 0 1.5rem; }',
    'from { margin-top: 12px; }',
    'from { animation-timing-function: cubic-bezier(0, 0, 1, 1); }',
    '0% { opacity: 0; } 50% { transform: scale(0.9) translateY(4px); }',
  ]) {
    assert.ok(
      scanAstroLiteralValues(
        `<style>@media (prefers-reduced-motion: no-preference) { @keyframes planted { ${keyframe} } }</style>`,
      ).some((issue) => issue.startsWith('literal keyframe ')),
      keyframe,
    );
  }
  assert.deepEqual(
    scanAstroLiteralValues(
      `<style>
        main {
          transition: box-shadow var(--duration-fast) var(--ease-out), transform var(--duration-base) var(--ease-out);
          transition-delay: 0s;
          animation: none !important;
          animation-name: planted;
          animation-duration: auto;
          animation-delay: calc(min(var(--enter-index), 3) * var(--stagger));
          animation-timing-function: linear;
          animation-range: var(--reveal-range);
          animation-range-start: cover calc(var(--reveal-index) * var(--reveal-step));
          translate: 0 var(--lift);
          transform: translateY(calc(-100% - var(--space-2))) rotate(180deg);
        }
        @keyframes planted {
          from { opacity: 0; translate: 0 var(--reveal-distance); transform: rotate(1turn) translateY(100%); }
        }
      </style>`,
    ),
    [],
  );
});
