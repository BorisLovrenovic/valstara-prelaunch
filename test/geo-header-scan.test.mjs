import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The geo module's whole value is that `CF-IPCountry` is turned into a
// *suggestion* in one place, so no consumer can quietly let detection decide the
// country (`docs/modules/platform.md#geo`). This scan enforces that: the header
// name may appear only inside the geo module. If any route, page or component
// starts reading it directly, this fails.
const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const GEO_MODULE = 'server/geo/suggest-country.ts';
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

test('CF-IPCountry is referenced only inside the geo module', () => {
  const offenders = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    if (!HEADER_PATTERN.test(readFileSync(file, 'utf8'))) {
      continue;
    }
    const relative = file.slice(SRC_ROOT.length + 1);
    if (relative !== GEO_MODULE) {
      offenders.push(relative);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `only ${GEO_MODULE} may read CF-IPCountry; found it in: ${offenders.join(', ')}`,
  );
});

test('the geo module does reference the header — the scan is not vacuous', () => {
  const source = readFileSync(`${SRC_ROOT}/${GEO_MODULE}`, 'utf8');
  assert.match(source, HEADER_PATTERN);
});
