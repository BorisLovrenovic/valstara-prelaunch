import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the scaffold pins the Astro Node standalone runtime', async () => {
  const config = await readFile(
    new URL('../astro.config.mjs', import.meta.url),
    'utf8',
  );

  assert.match(config, /@astrojs\/node/);
  assert.match(config, /mode: 'standalone'/);
  assert.match(config, /output: 'server'/);
});
