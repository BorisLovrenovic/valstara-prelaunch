import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasNonDefaultFlagState,
  landingFlagGeneration,
} from '../src/server/cache/landing.ts';
import {
  campaignFlagKeys,
  campaignFlagRegistry,
} from '../src/server/flags/registry.ts';

const defaults = campaignFlagKeys.map((key) => ({
  enabled: campaignFlagRegistry[key],
  key,
}));

test('landing cache generation is stable and any non-default flag state bypasses', () => {
  assert.equal(hasNonDefaultFlagState(defaults), false);
  const firstGeneration = landingFlagGeneration(defaults);
  assert.equal(landingFlagGeneration([...defaults]), firstGeneration);

  const flagged = defaults.map((flag) =>
    flag.key === 'signup.enabled' ? { ...flag, enabled: false } : flag,
  );
  assert.equal(hasNonDefaultFlagState(flagged), true);
  assert.notEqual(landingFlagGeneration(flagged), firstGeneration);
});
