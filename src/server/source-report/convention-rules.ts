// E11.8-02: the rules for the UTM convention, `config/utm-convention.json`,
// and the labels the per-platform report prints. This module imports no file,
// so `npm run check` (scripts/ci/utm-convention-check.ts) can report every
// problem with a broken file; convention.ts loads the committed one.

export const utmConventionPath = 'config/utm-convention.json';

export interface UtmConvention {
  readonly utm_source: readonly string[];
  readonly utm_medium: readonly string[];
}

/**
 * A listed value is already normalised (lower case, no surrounding space),
 * so it can equal a normalised stored value: a letter or digit, then up to 63
 * letters, digits, hyphens or underscores.
 */
export const utmConventionValuePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/** A campaign is printed only when its normalised form matches this. */
export const utmCampaignPattern = /^[a-z0-9-]{1,64}$/u;

/** The labels the report prints itself; no listed value may take one. */
export const sourceReportLabels = Object.freeze({
  other: 'other',
  notSet: '(not set)',
  referral: 'referral link or code',
  none: 'none',
});

const reservedValues = new Set<string>([
  sourceReportLabels.other,
  sourceReportLabels.none,
]);

const conventionKeys = ['utm_source', 'utm_medium'] as const;

/** Every problem with a candidate convention; empty when it is valid. */
export function utmConventionProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['the convention must be a JSON object'];
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(record)) {
    if (!(conventionKeys as readonly string[]).includes(key)) {
      problems.push(`unknown key "${key}"`);
    }
  }
  for (const key of conventionKeys) {
    const list = record[key];
    if (!Array.isArray(list)) {
      problems.push(`${key} must be a list of values`);
      continue;
    }
    if (list.length === 0) problems.push(`${key} lists no value`);
    const seen = new Set<string>();
    for (const entry of list as unknown[]) {
      if (typeof entry !== 'string') {
        problems.push(`${key} holds a value that is not text`);
        continue;
      }
      if (!utmConventionValuePattern.test(entry)) {
        problems.push(
          `${key} value "${entry}" must be lower case letters, digits, hyphens or underscores, starting with a letter or digit, at most 64 characters`,
        );
      }
      if (reservedValues.has(entry)) {
        problems.push(
          `${key} value "${entry}" is a label the report prints itself`,
        );
      }
      if (seen.has(entry)) problems.push(`${key} lists "${entry}" twice`);
      seen.add(entry);
    }
  }
  return problems;
}

/** Validates a candidate convention, or throws with every problem. */
export function parseUtmConvention(value: unknown): UtmConvention {
  const problems = utmConventionProblems(value);
  if (problems.length > 0) {
    throw new Error(`${utmConventionPath} is invalid: ${problems.join('; ')}.`);
  }
  const record = value as UtmConvention;
  return Object.freeze({
    utm_source: Object.freeze([...record.utm_source]),
    utm_medium: Object.freeze([...record.utm_medium]),
  });
}
