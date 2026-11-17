import { z } from 'zod';

import { iso4217Currencies } from './iso4217.ts';

// Lower-case kebab-case: letters and digits in runs joined by single hyphens.
// Service, plan and market slugs become permanent URLs (E11.6-10), so nothing
// else is accepted.
export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugSchema = z
  .string()
  .regex(slugPattern, { error: 'must be lower-case kebab-case' });

export const currencySchema = z
  .string()
  .refine((value) => iso4217Currencies.has(value), {
    error: 'is not a currency in the ISO 4217 table',
  });

export const displayNameSchema = z
  .string()
  .refine((value) => value.trim().length > 0 && value.trim() === value, {
    error: 'must be non-empty, with no leading or trailing whitespace',
  });

/**
 * The single normalisation every alias comparison uses: Unicode
 * compatibility decomposition, combining marks (diacritics) removed, lower
 * case, and every run of punctuation or whitespace collapsed to one space.
 * "Apple TV", "apple-tv" and "Àpple  TV." all normalise to "apple tv".
 */
export function normaliseAlias(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const aliasSchema = z
  .string()
  .refine((value) => normaliseAlias(value).length > 0, {
    error: 'must contain a letter or a digit',
  });

/** Keys of a list that occur more than once, in first-seen order. */
export function duplicates<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const repeated = new Set<T>();
  for (const item of items) {
    if (seen.has(item)) {
      repeated.add(item);
    }
    seen.add(item);
  }
  return [...repeated];
}
