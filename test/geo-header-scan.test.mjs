import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// S-01 removes location at signup. Any source reader of the country header is
// now a regression, including a resurrected geo module.
const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const HEADER_PATTERN = /CF-IPCountry/iu;

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.(?:ts|tsx|astro|mjs|js)$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

test('nothing in application source reads CF-IPCountry', () => {
  const offenders = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    if (!HEADER_PATTERN.test(readFileSync(file, 'utf8'))) {
      continue;
    }
    offenders.push(file.slice(SRC_ROOT.length + 1));
  }

  assert.deepEqual(
    offenders,
    [],
    `CF-IPCountry readers found in: ${offenders.join(', ')}`,
  );
});
