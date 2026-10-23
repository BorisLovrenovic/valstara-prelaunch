import assert from 'node:assert/strict';
import test from 'node:test';

import { assetsInlineLimit } from '../astro.config.mjs';

test('the leaderboard island script is always inlined, whatever its size', () => {
  for (const fileName of [
    '_astro/Leaderboard.astro_astro_type_script_index_0_lang.yq1NshMU.js',
    'Leaderboard.astro_astro_type_script_index_1_lang.B7Gq-J_8.js',
  ]) {
    assert.equal(assetsInlineLimit(fileName), true, fileName);
  }
});

test('every other asset keeps the default inline rule', () => {
  for (const fileName of [
    '_astro/SignupForm.astro_astro_type_script_index_0_lang.B7GqgJA8.js',
    '_astro/ThemeToggle.astro_astro_type_script_index_0_lang.DckaWssZ.js',
    '_astro/Leaderboard.astro_astro_type_script_index_0_lang.yq1NshMU.js.map',
    '_astro/Leaderboard.yq1NshMU.css',
    '_astro/NotLeaderboard.astro_astro_type_script_index_0_lang.yq1NshMU.js',
    '/home/runner/work/src/assets/leaderboard.svg',
  ]) {
    assert.equal(assetsInlineLimit(fileName), undefined, fileName);
  }
});
