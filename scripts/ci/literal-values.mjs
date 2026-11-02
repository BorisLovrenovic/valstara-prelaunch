import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const designBreakpoints = Object.freeze([
  '22.5rem',
  '48rem',
  '64rem',
  '80rem',
]);
const allowedBreakpoints = new Set(designBreakpoints);
const length =
  /-?(?:\d*\.)?\d+(?:px|rem|em|ch|ex|vw|vh|vmin|vmax|cqw|cqh)\b/giu;
const colour = /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\s*\(/iu;
const checkedProperty =
  /^(?:color|background(?:-color)?|border(?:-[\w-]+)?-color|outline-color|fill|stroke|font(?:-family|-size|-weight)?|line-height|letter-spacing|border-radius|box-shadow|z-index|(?:margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|outline-offset)(?:-[\w-]+)?|(?:animation|transition)-duration|(?:min-|max-)?(?:width|height)|(?:inline|block)-size)$/u;

function allowedValue(property, value) {
  // A token list, such as a shadow layered from two tokens, is still tokens.
  if (/^(?:var\(--[\w-]+\)|0)(?:\s*,?\s*(?:var\(--[\w-]+\)|0))*$/u.test(value))
    return true;
  if (/^(?:inherit|initial|unset|revert)$/u.test(value)) return true;
  if (
    /^(?:min-|max-)?(?:width|height)$|^(?:inline|block)-size$/u.test(property)
  ) {
    if (
      /^(?:auto|fit-content|min-content|max-content|0|(?:\d*\.)?\d+%)$/u.test(
        value,
      )
    )
      return true;
  }
  if (
    /^(?:margin|inset|top|right|bottom|left)(?:-[\w-]+)?$/u.test(property) &&
    value === 'auto'
  )
    return true;
  if (
    /^(?:color|background(?:-color)?|border(?:-[\w-]+)?-color|outline-color|fill|stroke)$/u.test(
      property,
    ) &&
    /^(?:none|currentColor|transparent)$/u.test(value)
  )
    return true;
  if (property === 'box-shadow' && value === 'none') return true;
  if (property === 'z-index' && value === 'auto') return true;
  // A scroll-driven animation's duration is the length of its timeline.
  if (property === 'animation-duration' && value === 'auto') return true;
  if (property === 'font' && value === 'inherit') return true;
  if (
    /^(?:min-|max-)?(?:width|height)$|^(?:inline|block)-size$/u.test(
      property,
    ) &&
    /^(?:\d*\.)?\d+%$/u.test(value)
  )
    return true;
  if (/^(?:calc|clamp|min|max)\(/u.test(value)) {
    const outsideTokens = value.replace(/var\(--[\w-]+\)/gu, '');
    return !outsideTokens.match(length) && !colour.test(outsideTokens);
  }
  return false;
}

// The CSS an Astro file carries: its <style> blocks and its style attributes,
// including JSX style objects written as declarations.
export function astroStyles(source) {
  return [
    ...[...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)].map(
      (match) => match[1],
    ),
    ...[...source.matchAll(/\bstyle\s*=\s*["']([^"']+)["']/giu)].map(
      (match) => match[1],
    ),
    ...[...source.matchAll(/\bstyle\s*=\s*\{\{([\s\S]*?)\}\}/giu)].map(
      (match) =>
        [...match[1].matchAll(/([\w-]+)\s*:\s*(["'`])([^"'`]*?)\2/gu)]
          .map((entry) => `${entry[1]}: ${entry[3]};`)
          .join(''),
    ),
    ...[...source.matchAll(/\bstyle\s*=\s*\{(["'`])([\s\S]*?)\1\}/giu)].map(
      (match) => match[2],
    ),
  ];
}

// Every declaration in a piece of CSS, with the preludes of the blocks it
// sits in, outermost first (at-rules and selectors), so a check can tell a
// declaration inside @keyframes, or on a given selector, from any other.
export function cssDeclarations(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const declarations = [];
  const preludes = [];
  let buffer = '';
  let quote = null;
  let parentheses = 0;
  const flush = () => {
    const text = buffer.trim();
    buffer = '';
    const colon = text.indexOf(':');
    if (colon <= 0) return;
    const property = text.slice(0, colon).trim().toLowerCase();
    if (!/^-{0,2}[a-z][\w-]*$/u.test(property)) return;
    declarations.push({
      property,
      value: text
        .slice(colon + 1)
        .replace(/\s*!important\s*$/iu, '')
        .trim(),
      preludes: [...preludes],
    });
  };
  for (const char of source) {
    if (quote !== null) {
      buffer += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
    } else if (char === '(' || char === ')') {
      parentheses = Math.max(0, parentheses + (char === '(' ? 1 : -1));
      buffer += char;
    } else if (parentheses === 0 && char === '{') {
      preludes.push(buffer.trim().replace(/\s+/gu, ' '));
      buffer = '';
    } else if (parentheses === 0 && char === '}') {
      flush();
      preludes.pop();
    } else if (parentheses === 0 && char === ';') {
      flush();
    } else {
      buffer += char;
    }
  }
  flush();
  return declarations;
}

export const inKeyframes = (declaration) =>
  declaration.preludes.some((prelude) =>
    /^@(?:-webkit-)?keyframes\b/iu.test(prelude),
  );

// E11.5-11i: the motion values. A duration, delay, easing curve, animation
// range or movement distance comes from a token, like every other value.
// The translate, scale and rotate properties take no literal at all, beyond
// their identity values and a unitless multiplier in a translate's calc().
// Unitless numbers, angles and percentages inside a transform stay allowed
// (a 180° chevron turn, a bar sliding in from 100%); `linear` is the one
// keyword easing, for the in-flight spinner's constant turn.
const motionTime = /(?<![\w.-])(-?(?:\d*\.)?\d+)m?s\b/giu;
const motionLength =
  /(?<![\w.-])(-?(?:\d*\.)?\d+)(?:px|r?em|r?lh|ch|ex|cap|ic|cm|mm|in|pt|pc|q|[dsl]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))\b/giu;
const motionPercentage = /(?<![\w.-])-?(?:\d*\.)?\d+%/u;
const motionPercent = /(?<![\w.-])(-?(?:\d*\.)?\d+)%/gu;
const motionAngle = /(?<![\w.-])(-?(?:\d*\.)?\d+)(?:deg|grad|rad|turn)\b/giu;
const scaleFactor = /(?<![\w.-])(-?(?:\d*\.)?\d+)(%?)/gu;
const easingFunction = /\b(?:cubic-bezier|steps|linear)\s*\(/iu;
const easingKeyword =
  /^(?:ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/iu;

const withoutTokens = (value) => value.replace(/var\(\s*--[\w-]+\s*\)/gu, ' ');
const nonZero = (pattern, value) =>
  [...value.matchAll(pattern)].some((match) => Number(match[1]) !== 0);
const literalEasing = (value) =>
  easingFunction.test(value) ||
  value.split(/[\s,()]+/u).some((word) => easingKeyword.test(word.trim()));

function motionLiteral({ property, value, ...declaration }) {
  const bare = withoutTokens(value);
  if (/^(?:transition|animation)$/u.test(property))
    return nonZero(motionTime, bare) || literalEasing(bare);
  if (/-delay$/u.test(property)) return nonZero(motionTime, bare);
  if (/-timing-function$/u.test(property)) return literalEasing(bare);
  if (/^animation-range/u.test(property))
    return nonZero(motionLength, bare) || motionPercentage.test(bare);
  if (property === 'transform') return nonZero(motionLength, bare);
  if (property === 'translate')
    return nonZero(motionLength, bare) || nonZero(motionPercent, bare);
  if (property === 'rotate') return nonZero(motionAngle, bare);
  if (property === 'scale')
    return [...bare.matchAll(scaleFactor)].some(
      ([, factor, percent]) => Number(factor) !== (percent ? 100 : 1),
    );
  if (inKeyframes({ property, value, ...declaration }))
    return (
      nonZero(motionLength, bare) ||
      nonZero(motionTime, bare) ||
      easingFunction.test(bare)
    );
  return false;
}

function scanStyles(styles) {
  const issues = [];
  for (const css of styles) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    for (const match of withoutComments.matchAll(/@media\s+([^{}]+)\{/giu)) {
      for (const width of match[1].matchAll(
        /\b(?:min|max)-width\s*:\s*([^\s)]+)/giu,
      )) {
        if (!allowedBreakpoints.has(width[1].toLowerCase())) {
          issues.push(`unregistered media-query width ${width[1]}`);
        }
      }
      for (const found of match[1].matchAll(length)) {
        if (!allowedBreakpoints.has(found[0].toLowerCase())) {
          issues.push(`unregistered media-query length ${found[0]}`);
        }
      }
    }
    for (const match of withoutComments.matchAll(
      /(?:^|[;{}])\s*([\w-]+)\s*:\s*([^;{}]+)\s*;?/gmu,
    )) {
      const property = match[1].toLowerCase();
      const value = match[2].trim();
      if (checkedProperty.test(property) && !allowedValue(property, value)) {
        issues.push(`literal ${property}: ${value}`);
      }
    }
    for (const declaration of cssDeclarations(css)) {
      if (motionLiteral(declaration)) {
        issues.push(
          `literal ${inKeyframes(declaration) ? 'keyframe ' : ''}${declaration.property}: ${declaration.value}`,
        );
      }
    }
  }
  return [...new Set(issues)];
}

export function scanAstroLiteralValues(source) {
  const issues = [];
  if (colour.test(source.replace(/\/\*[\s\S]*?\*\//gu, ''))) {
    issues.push('literal colour in Astro source');
  }
  return [...issues, ...scanStyles(astroStyles(source))];
}

// A global stylesheet under src/styles/ other than tokens.css, which is
// where the values are defined.
export function scanStylesheetLiteralValues(source) {
  const issues = [];
  if (colour.test(source.replace(/\/\*[\s\S]*?\*\//gu, ''))) {
    issues.push('literal colour in stylesheet');
  }
  return [...issues, ...scanStyles([source])];
}

export const scannedStylesheet = (path) =>
  /^src\/styles\/[^/]+\.css$/u.test(path) && path !== 'src/styles/tokens.css';

// Every .astro file under src/ and every scanned stylesheet.
export async function scanAstroTree(root) {
  const issues = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const file = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.astro') || scannedStylesheet(file)) {
        const source = await readFile(path, 'utf8');
        for (const message of entry.name.endsWith('.astro')
          ? scanAstroLiteralValues(source)
          : scanStylesheetLiteralValues(source)) {
          issues.push({ path: file, message });
        }
      }
    }
  }
  await visit(join(root, 'src'));
  return issues;
}
