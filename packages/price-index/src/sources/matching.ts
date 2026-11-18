import { normaliseAlias } from '../schema/common.ts';

// Name matching for every source (docs/features/price-index.md#the-source-youfundceocom).
// A source name matches the catalogue only through `source_aliases`, compared
// after `normaliseAlias` (case, whitespace, punctuation and diacritics). A
// fuzzy score only ever *suggests* an alias for the founder; nothing here
// accepts one, and nothing writes to the catalogue.

/** True when any of the source's names equals any alias, after normalisation. */
export function matchesAlias(
  sourceNames: readonly string[],
  aliases: readonly string[],
): boolean {
  const keys = new Set(aliases.map(normaliseAlias));
  return sourceNames.some((name) => keys.has(normaliseAlias(name)));
}

function bigrams(value: string): string[] {
  const compact = value.replace(/ /g, '');
  const pairs: string[] = [];
  for (let index = 0; index + 1 < compact.length; index += 1) {
    pairs.push(compact.slice(index, index + 2));
  }
  return pairs;
}

/** Sørensen–Dice similarity of two normalised names' character pairs, 0 to 1. */
function dice(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.length === 0 || b.length === 0) {
    return left === right ? 1 : 0;
  }
  const remaining = new Map<string, number>();
  for (const pair of b) {
    remaining.set(pair, (remaining.get(pair) ?? 0) + 1);
  }
  let shared = 0;
  for (const pair of a) {
    const count = remaining.get(pair) ?? 0;
    if (count > 0) {
      shared += 1;
      remaining.set(pair, count - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * How alike two names are, 0 to 1. One name's words all being words of the
 * other ("adobe" in "adobe creative cloud") scores at least 0.75; otherwise
 * it is the Dice similarity of their letters.
 */
export function nameSimilarity(left: string, right: string): number {
  const a = normaliseAlias(left);
  const b = normaliseAlias(right);
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const score = dice(a, b);
  const wordsA = new Set(a.split(' '));
  const wordsB = new Set(b.split(' '));
  const contained =
    [...wordsA].every((word) => wordsB.has(word)) ||
    [...wordsB].every((word) => wordsA.has(word));
  return contained ? 0.75 + 0.25 * score : score;
}

/** The lowest similarity at which a suggestion is offered. */
export const suggestionThreshold = 0.6;

export interface SuggestionCandidate {
  readonly id: string;
  readonly names: readonly string[];
}

/**
 * The candidate whose names are most like the source's, if any reaches the
 * threshold. A tie goes to the earlier candidate, so the result is
 * deterministic. This is a suggestion for the founder and is never applied.
 */
export function suggestAlias(
  sourceNames: readonly string[],
  candidates: readonly SuggestionCandidate[],
): string | null {
  let best: { id: string; score: number } | null = null;
  for (const candidate of candidates) {
    let score = 0;
    for (const sourceName of sourceNames) {
      for (const name of candidate.names) {
        score = Math.max(score, nameSimilarity(sourceName, name));
      }
    }
    if (score >= suggestionThreshold && (best === null || score > best.score)) {
      best = { id: candidate.id, score };
    }
  }
  return best?.id ?? null;
}
