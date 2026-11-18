import assert from 'node:assert/strict';
import test from 'node:test';

import {
  matchesAlias,
  nameSimilarity,
  suggestAlias,
  suggestionThreshold,
} from '../../packages/price-index/src/sources/matching.ts';

// E11.6-05: names match only through `source_aliases`, after normalising
// case, whitespace, punctuation and diacritics. The fuzzy score only ever
// suggests.

test('an alias matches after normalising case, whitespace, punctuation and diacritics', () => {
  assert.ok(matchesAlias(['Premium Individual'], ['premium-individual']));
  assert.ok(matchesAlias(['  APPLE   tv.'], ['Àpple TV']));
  assert.ok(matchesAlias(['apple-tv-plus'], ['Apple TV Plus']));
  assert.ok(matchesAlias(['Standard with ads', 'basic'], ['Basic', 'basic']));
});

test('anything else does not match: no prefix, substring or fuzzy match', () => {
  assert.equal(matchesAlias(['Standard with ads'], ['Standard']), false);
  assert.equal(matchesAlias(['standard-ads'], ['standard']), false);
  assert.equal(matchesAlias(['Prime Video'], ['Amazon Prime', 'Prime']), false);
  assert.equal(matchesAlias(['Premium'], ['Premium Individual']), false);
  assert.equal(matchesAlias(['Netflix'], []), false);
  assert.equal(matchesAlias([], ['Netflix']), false);
});

test('the similarity scores word containment above letter overlap', () => {
  assert.ok(nameSimilarity('adobe', 'Adobe Creative Cloud') >= 0.75);
  assert.ok(
    nameSimilarity('Prime Video', 'Amazon Prime / Prime Video') >= 0.75,
  );
  assert.equal(nameSimilarity('Netflix', 'netflix'), 1);
  assert.ok(nameSimilarity('Deezer', 'Spotify') < suggestionThreshold);
  assert.equal(nameSimilarity('', 'Spotify'), 0);
});

test('a suggestion is the most similar candidate above the threshold, or none', () => {
  const services = [
    {
      id: 'adobe-creative-cloud',
      names: ['Adobe Creative Cloud', 'adobe-creative-cloud'],
    },
    {
      id: 'amazon-prime',
      names: ['Amazon Prime / Prime Video', 'amazon-prime'],
    },
    { id: 'spotify', names: ['Spotify Premium', 'spotify'] },
  ];
  assert.equal(
    suggestAlias(['Adobe Creative Cloud', 'adobe'], services),
    'adobe-creative-cloud',
  );
  assert.equal(
    suggestAlias(['Prime Video', 'prime-video'], services),
    'amazon-prime',
  );
  assert.equal(suggestAlias(['Deezer', 'deezer'], services), null);
  assert.equal(suggestAlias(['Spotify'], []), null);
});

test('a tie goes to the earlier candidate, so the suggestion is deterministic', () => {
  const candidates = [
    { id: 'first', names: ['Pro'] },
    { id: 'second', names: ['Pro'] },
  ];
  assert.equal(suggestAlias(['pro'], candidates), 'first');
  assert.equal(suggestAlias(['pro'], [...candidates].reverse()), 'second');
});
