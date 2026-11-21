import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import blocklistDocument from '../../../config/partner-code-blocklist.json' with { type: 'json' };
import type { DatabaseConnection } from '../db/pool.ts';
import {
  createReferralCodeRepository,
  referralCodeAvailabilityBatchLimit,
} from '../db/referral-code.ts';
import { referralCodeAlphabet } from './config.ts';

export const partnerCodeMinimumLength = 4;
export const partnerCodeMaximumLength = 16;
export const partnerCodeMaximumAlternatives = 3;

/** Format, blocklist and availability each refuse with their own reason. */
export type PartnerCodeRefusalReason = 'blocked' | 'format' | 'taken';

export type PartnerCodeCheck =
  | { readonly code: string; readonly outcome: 'available' }
  | {
      /** Up to three codes that passed every rule when checked. */
      readonly alternatives: readonly string[];
      readonly outcome: 'refused';
      readonly reason: PartnerCodeRefusalReason;
    };

export type PartnerCodeBlocklistCategory = 'brand' | 'profanity' | 'reserved';

export interface PartnerCodeBlocklist {
  readonly categories: readonly {
    readonly category: PartnerCodeBlocklistCategory;
    readonly contains: readonly string[];
    readonly exact: ReadonlySet<string>;
  }[];
}

export interface PartnerCodeRules {
  check(requested: string): Promise<PartnerCodeCheck>;
}

export interface PartnerCodeRulesDependencies {
  readonly blocklist?: PartnerCodeBlocklist;
  /** A random candidate for when no alternative can be derived from input. */
  readonly randomCandidate?: () => string;
}

const partnerCodePattern = /^[A-Z0-9]{4,16}$/u;
const blocklistTerm = z.string().regex(/^[A-Z0-9]+$/u);
const blocklistCategory = z
  .object({
    // A contained term needs two characters to mean anything. A provider
    // name longer than a code is still listed, so the list stays reconciled
    // with the showcase, and its shorter brand root is listed beside it.
    contains: z.array(blocklistTerm.min(2)),
    // An exact term outside the code length could never match a code.
    exact: z.array(
      blocklistTerm.min(partnerCodeMinimumLength).max(partnerCodeMaximumLength),
    ),
  })
  .strict();
const blocklistSchema = z
  .object({
    about: z.string(),
    brand: blocklistCategory,
    profanity: blocklistCategory,
    reserved: blocklistCategory,
  })
  .strict();

/** Validates the blocklist document; a malformed list fails at boot. */
export function parsePartnerCodeBlocklist(
  document: unknown,
): PartnerCodeBlocklist {
  const parsed = blocklistSchema.parse(document);
  return {
    categories: (['brand', 'reserved', 'profanity'] as const).map(
      (category) => ({
        category,
        contains: Object.freeze([...parsed[category].contains]),
        exact: new Set(parsed[category].exact),
      }),
    ),
  };
}

// Loaded once when the server module graph boots, from the repository's own
// configuration file.
export const partnerCodeBlocklist =
  parsePartnerCodeBlocklist(blocklistDocument);

/**
 * The stored form of a requested partner code: surrounding spaces ignored,
 * 4-16 of A-Z and 0-9 in any case, upper-cased. Null when the format fails.
 */
export function normalisePartnerCode(requested: string): string | null {
  const trimmed = requested.trim();
  if (!/^[A-Za-z0-9]{4,16}$/u.test(trimmed)) {
    return null;
  }
  return trimmed.toUpperCase();
}

/** The blocklist category refusing an upper-case code, or null. */
export function blockedPartnerCodeCategory(
  code: string,
  blocklist: PartnerCodeBlocklist = partnerCodeBlocklist,
): PartnerCodeBlocklistCategory | null {
  for (const { category, contains, exact } of blocklist.categories) {
    if (exact.has(code) || contains.some((term) => code.includes(term))) {
      return category;
    }
  }
  return null;
}

/**
 * The partner code rules (E11.7-01): format, blocklist and availability
 * against the shared registry, in that order, with alternatives for a refused
 * code. Availability is advisory: the registry's primary key decides a race.
 */
export function createPartnerCodeRules(
  database: DatabaseConnection,
  dependencies: PartnerCodeRulesDependencies = {},
): PartnerCodeRules {
  const blocklist = dependencies.blocklist ?? partnerCodeBlocklist;
  const randomCandidate = dependencies.randomCandidate ?? createRandomCandidate;
  const registry = createReferralCodeRepository(database);

  const passesLocalRules = (code: string) =>
    partnerCodePattern.test(code) &&
    blockedPartnerCodeCategory(code, blocklist) === null;

  async function alternatives(
    requested: string,
    refusedCode: string | null,
  ): Promise<readonly string[]> {
    const found: string[] = [];
    const considered = new Set<string>(
      refusedCode === null ? [] : [refusedCode],
    );
    const takeAvailable = async (candidates: readonly string[]) => {
      const fresh = candidates.filter((candidate) => {
        if (considered.has(candidate) || !passesLocalRules(candidate)) {
          return false;
        }
        considered.add(candidate);
        return true;
      });
      for (
        let start = 0;
        start < fresh.length && found.length < partnerCodeMaximumAlternatives;
        start += referralCodeAvailabilityBatchLimit
      ) {
        const batch = fresh.slice(
          start,
          start + referralCodeAvailabilityBatchLimit,
        );
        const registered = await registry.findRegistered(batch);
        for (const candidate of batch) {
          if (
            !registered.has(candidate) &&
            found.length < partnerCodeMaximumAlternatives
          ) {
            found.push(candidate);
          }
        }
      }
    };

    for (const stem of alternativeStems(requested, blocklist)) {
      if (found.length >= partnerCodeMaximumAlternatives) {
        break;
      }
      await takeAvailable(derivedCandidates(stem));
    }
    for (
      let round = 0;
      round < maximumRandomRounds &&
      found.length < partnerCodeMaximumAlternatives;
      round += 1
    ) {
      await takeAvailable(
        Array.from({ length: randomCandidatesPerRound }, randomCandidate),
      );
    }
    return found;
  }

  return {
    async check(requested) {
      const code = normalisePartnerCode(requested);
      if (code === null) {
        return refusal('format', await alternatives(requested, null));
      }
      if (blockedPartnerCodeCategory(code, blocklist) !== null) {
        return refusal('blocked', await alternatives(requested, code));
      }
      if ((await registry.findRegistered([code])).has(code)) {
        return refusal('taken', await alternatives(requested, code));
      }
      return { code, outcome: 'available' };
    },
  };
}

const maximumSuffix = 199;
const maximumRandomRounds = 3;
const randomCandidatesPerRound = 16;
const randomCandidateLength = 8;

function refusal(
  reason: PartnerCodeRefusalReason,
  alternatives: readonly string[],
): PartnerCodeCheck {
  return { alternatives, outcome: 'refused', reason };
}

/**
 * The bases alternatives are built from: the request's letters and digits,
 * upper-cased, and the same with every contained blocklist term removed.
 */
function alternativeStems(
  requested: string,
  blocklist: PartnerCodeBlocklist,
): readonly string[] {
  const base = requested
    .replace(/[^A-Za-z0-9]/gu, '')
    .toUpperCase()
    .slice(0, partnerCodeMaximumLength);
  let cleaned = base;
  for (let pass = 0; pass < partnerCodeMaximumLength; pass += 1) {
    let next = cleaned;
    for (const { contains } of blocklist.categories) {
      for (const term of contains) {
        next = next.replaceAll(term, '');
      }
    }
    if (next === cleaned) {
      break;
    }
    cleaned = next;
  }
  return [...new Set([cleaned, base])].filter((stem) => stem.length > 0);
}

/** The stem itself, then the stem with 1, 2, 3 … appended, at most 16 long. */
function derivedCandidates(stem: string): readonly string[] {
  const candidates = [stem];
  for (let suffix = 1; suffix <= maximumSuffix; suffix += 1) {
    const digits = String(suffix);
    candidates.push(
      stem.slice(0, partnerCodeMaximumLength - digits.length) + digits,
    );
  }
  return candidates;
}

/** Eight characters from the unambiguous member-code alphabet, unbiased. */
function createRandomCandidate(): string {
  const unbiasedMaximum = 256 - (256 % referralCodeAlphabet.length);
  let candidate = '';
  while (candidate.length < randomCandidateLength) {
    for (const value of randomBytes(randomCandidateLength)) {
      if (value < unbiasedMaximum && candidate.length < randomCandidateLength) {
        candidate += referralCodeAlphabet.charAt(
          value % referralCodeAlphabet.length,
        );
      }
    }
  }
  return candidate;
}
