import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  astroStyles,
  cssDeclarations,
  inKeyframes,
} from './literal-values.mjs';

// E11.5-11i, design rule 12: motion animates opacity, transform and the
// stroke drawing of decorative SVG, and never a property that moves layout,
// except a disclosure the visitor opens (`::details-content`).
export const animatableProperties = Object.freeze([
  'opacity',
  'transform',
  'translate',
  'scale',
  'rotate',
  'stroke-dashoffset',
]);
const animatable = new Set(animatableProperties);
// A keyframe may set its own easing; that animates nothing.
const keyframeControls = new Set(['animation-timing-function']);
// `all` includes every layout property, so it fails with them.
const layoutProperty =
  /^(?:all|(?:min-|max-)?(?:width|height|inline-size|block-size)|inset(?:-[\w-]+)?|top|right|bottom|left|(?:margin|padding)(?:-[\w-]+)?)$/u;
const notAPropertyName =
  /^(?:none|initial|inherit|unset|revert|normal|allow-discrete|linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/u;

// The property each comma-separated item of a transition names: its first
// identifier that is not a duration, an easing or a keyword.
function transitionedProperties(property, value) {
  const items = value
    .replace(/var\(\s*--[\w-]+\s*\)/gu, ' ')
    .replace(/[\w-]+\([^()]*\)/gu, ' ')
    .split(',');
  if (property === 'transition-property')
    return items.map((item) => item.trim().toLowerCase()).filter(Boolean);
  return items.flatMap((item) => {
    const name = item
      .trim()
      .toLowerCase()
      .split(/\s+/u)
      .find(
        (word) =>
          /^-?[a-z][a-z-]*$/u.test(word) && !notAPropertyName.test(word),
      );
    return name === undefined ? [] : [name];
  });
}

export function scanMotionCss(css) {
  const issues = [];
  for (const declaration of cssDeclarations(css)) {
    const { property, value, preludes } = declaration;
    if (inKeyframes(declaration)) {
      if (!animatable.has(property) && !keyframeControls.has(property))
        issues.push(`keyframe animates ${property}`);
      continue;
    }
    if (property !== 'transition' && property !== 'transition-property')
      continue;
    if (preludes.some((prelude) => prelude.includes('::details-content')))
      continue;
    for (const name of transitionedProperties(property, value)) {
      if (layoutProperty.test(name))
        issues.push(`transition on layout property ${name}`);
    }
  }
  return [...new Set(issues)];
}

export function scanMotionProperties(path, source) {
  return path.endsWith('.astro')
    ? astroStyles(source).flatMap((css) => scanMotionCss(css))
    : scanMotionCss(source);
}

// Every .astro file and stylesheet under src/.
export async function scanMotionTree(root) {
  const issues = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:astro|css)$/u.test(entry.name)) {
        const file = relative(root, path).replaceAll('\\', '/');
        for (const message of scanMotionProperties(
          file,
          await readFile(path, 'utf8'),
        )) {
          issues.push({ path: file, message });
        }
      }
    }
  }
  await visit(join(root, 'src'));
  return issues;
}
