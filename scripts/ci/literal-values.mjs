import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const designBreakpoints = Object.freeze(['40rem', '64rem', '80rem']);
const allowedBreakpoints = new Set(designBreakpoints);
const length =
  /-?(?:\d*\.)?\d+(?:px|rem|em|ch|ex|vw|vh|vmin|vmax|cqw|cqh)\b/giu;
const colour = /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\s*\(/iu;
const checkedProperty =
  /^(?:color|background(?:-color)?|border(?:-[\w-]+)?-color|outline-color|fill|stroke|font(?:-family|-size|-weight)?|line-height|letter-spacing|border-radius|box-shadow|z-index|(?:margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|outline-offset)(?:-[\w-]+)?|(?:animation|transition)-duration|(?:min-|max-)?(?:width|height)|(?:inline|block)-size)$/u;

function allowedValue(property, value) {
  if (/^(?:(?:var\(--[\w-]+\)|0)(?:\s+|$))+$/u.test(value)) return true;
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

export function scanAstroLiteralValues(source) {
  const issues = [];
  if (colour.test(source.replace(/\/\*[\s\S]*?\*\//gu, ''))) {
    issues.push('literal colour in Astro source');
  }
  const styles = [
    ...[...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)].map(
      (match) => match[1],
    ),
    ...[...source.matchAll(/\bstyle\s*=\s*["']([^"']+)["']/giu)].map(
      (match) => match[1],
    ),
  ];

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
  }
  return issues;
}

export async function scanAstroTree(root) {
  const issues = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.astro')) {
        for (const message of scanAstroLiteralValues(
          await readFile(path, 'utf8'),
        )) {
          issues.push({ path: relative(root, path), message });
        }
      }
    }
  }
  await visit(join(root, 'src'));
  return issues;
}
