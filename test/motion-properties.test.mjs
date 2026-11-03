import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  animatableProperties,
  scanMotionCss,
  scanMotionProperties,
  scanMotionTree,
} from '../scripts/ci/motion-properties.mjs';

// E11.5-11i, design rule 12: a keyframe animates only opacity, transforms and
// stroke drawing, and a transition never names a layout property, except on
// `::details-content`.
const fixture = (name) =>
  readFile(
    new URL(`fixtures/motion-properties/${name}.astro`, import.meta.url),
    'utf8',
  );

test('the animatable set is exactly opacity, the transforms and stroke drawing', () => {
  assert.deepEqual(animatableProperties, [
    'opacity',
    'transform',
    'translate',
    'scale',
    'rotate',
    'stroke-dashoffset',
  ]);
});

test('a planted keyframe that animates a layout property fails', async () => {
  assert.deepEqual(
    scanMotionProperties(
      'src/components/planted.astro',
      await fixture('keyframe'),
    ),
    ['keyframe animates height'],
  );
});

test('a planted transition on a layout property fails', async () => {
  assert.deepEqual(
    scanMotionProperties(
      'src/components/planted.astro',
      await fixture('transition'),
    ),
    ['transition on layout property margin-top'],
  );
});

test('a disclosure may transition its size on ::details-content, and transforms and stroke drawing pass', async () => {
  assert.deepEqual(
    scanMotionProperties(
      'src/components/sound.astro',
      await fixture('details-content'),
    ),
    [],
  );
});

test('every layout property fails, in the longhand and the shorthand, in a component and a stylesheet', () => {
  for (const name of [
    'width',
    'height',
    'min-height',
    'max-width',
    'inline-size',
    'block-size',
    'inset',
    'inset-block-start',
    'top',
    'right',
    'bottom',
    'left',
    'margin',
    'margin-inline-start',
    'padding',
    'padding-top',
    'all',
  ]) {
    assert.deepEqual(
      scanMotionCss(`a { transition-property: opacity, ${name}; }`),
      [`transition on layout property ${name}`],
      name,
    );
    assert.deepEqual(
      scanMotionCss(
        `a { transition: opacity var(--duration-fast), ${name} var(--duration-base) var(--ease-out); }`,
      ),
      [`transition on layout property ${name}`],
      `${name} in the shorthand`,
    );
  }
  for (const name of ['width', 'top', 'padding-block', 'color', 'filter']) {
    assert.deepEqual(
      scanMotionProperties(
        'src/styles/planted.css',
        `@media (prefers-reduced-motion: no-preference) { @keyframes planted { to { ${name}: inherit; } } }`,
      ),
      [`keyframe animates ${name}`],
      name,
    );
  }
  // The exemption is the disclosure's content only, not its summary.
  assert.deepEqual(
    scanMotionCss('details summary { transition-property: height; }'),
    ['transition on layout property height'],
  );
  assert.deepEqual(
    scanMotionCss(
      'a { transition: none; transition-property: border-color, box-shadow, background-color, color; }',
    ),
    [],
  );
});

test('the disclosure exemption covers only the selectors that are ::details-content', () => {
  for (const selector of [
    'a, b::details-content',
    'b::details-content, a',
    ':is(a, b)::details-content, c',
    'b::details-content a',
    'a:has(b::details-content)',
  ]) {
    assert.deepEqual(
      scanMotionCss(
        `${selector} { transition: height var(--duration-base) var(--ease-out); }`,
      ),
      ['transition on layout property height'],
      selector,
    );
  }
  for (const css of [
    'details::details-content { transition: height var(--duration-base) var(--ease-out); }',
    'a::details-content, b[open]::details-content { transition-property: height; }',
    ':is(a, b)::details-content { transition-property: block-size; }',
    'details { &::details-content { transition-property: height; } }',
    '@media (prefers-reduced-motion: no-preference) { details::details-content { transition-property: height; } }',
  ]) {
    assert.deepEqual(scanMotionCss(css), [], css);
  }
});

test('a transition shorthand that names no property is an implicit all and fails', () => {
  for (const value of [
    'var(--duration-fast)',
    'var(--duration-fast) var(--ease-out)',
    'var(--duration-fast), opacity var(--duration-fast)',
    'opacity var(--duration-fast), var(--duration-base)',
    '0s',
    'calc(2 * var(--duration-fast))',
    'allow-discrete var(--duration-fast)',
  ]) {
    assert.deepEqual(
      scanMotionCss(`a { transition: ${value}; }`),
      ['transition on layout property all'],
      value,
    );
  }
  for (const value of [
    'none',
    'inherit',
    'initial',
    'unset',
    'revert',
    'revert-layer',
    'opacity var(--duration-fast)',
    'var(--duration-fast) opacity',
  ]) {
    assert.deepEqual(scanMotionCss(`a { transition: ${value}; }`), [], value);
  }
});

test('every shipping component and stylesheet passes the motion-property scan', async () => {
  assert.deepEqual(
    await scanMotionTree(fileURLToPath(new URL('..', import.meta.url))),
    [],
  );
});
