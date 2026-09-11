import { createHash } from 'node:crypto';

import { campaignFlagRegistry } from '../flags/registry.ts';
import type { Flag } from '../flags/types.ts';
import { geoCountryHeaderName } from '../geo/suggest-country.ts';

export const landingCacheVary = `${geoCountryHeaderName}, X-Valstara-Flag-Generation`;

export function landingFlagGeneration(flags: readonly Flag[]): string {
  const state = flags
    .map(({ enabled, key }) => `${key}:${enabled ? 1 : 0}`)
    .join('|');
  return createHash('sha256').update(state).digest('hex').slice(0, 16);
}

export function hasNonDefaultFlagState(flags: readonly Flag[]): boolean {
  return flags.some(
    ({ enabled, key }) => campaignFlagRegistry[key] !== enabled,
  );
}
