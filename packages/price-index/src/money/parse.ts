import { minorUnitExponent } from '../schema/iso4217.ts';
import { MoneyError } from './errors.ts';
import { assertCurrency, fromMinor, type Money } from './money.ts';
import { currencyMarkPattern, currencyMarks } from './symbols.ts';

// Reads a price as a page displays it into exact money (E11.6-03). It covers
// every format E11.6-01 recorded on the 38 captured country pages (`kr 169`,
// `€18 EUR`, `CHF 23.40`, `Ft 2,790`, `$19.99 + tax`) and the local formats
// the ticket names (`149 kr`, `11,99 €`, `23,99 zł`), with thousands written
// as `.`, `,`, a space, a no-break space, a narrow no-break space or an
// apostrophe. Nothing is guessed: a text that two readings fit is refused.

/** How a price text was written, so `formatMoney` can write one back. */
export interface MoneyStyle {
  /** Everything before the number, exactly: `"kr\u00a0"`, `"€"`, `""`. */
  readonly prefix: string;
  /** Everything after the number, exactly: `" EUR"`, `" + tax"`, `""`. */
  readonly suffix: string;
  /** The thousands separator, or null when the text used none. */
  readonly groupSeparator: string | null;
  /** The decimal separator, or null when the text had no decimals. */
  readonly decimalSeparator: '.' | ',' | null;
  /** How many decimals the text wrote: 0 for `kr 169`, 2 for `€9.99`. */
  readonly fractionDigits: number;
}

export interface ParsedPrice {
  readonly money: Money;
  readonly style: MoneyStyle;
  /** The text exactly as given, for a record's `price_source_text`. */
  readonly sourceText: string;
}

export interface ParseMoneyOptions {
  /**
   * The currency the price is known to be in, such as the source's own
   * `official.currency` or a market's currency. It settles a shared mark
   * (`kr`, `$`) and must agree with any mark or code in the text.
   */
  readonly currency?: string;
}

/** Characters that only ever separate thousands. */
const spaceSeparators = [' ', '\u00a0', '\u202f'];
export const groupSeparators: readonly string[] = [
  '.',
  ',',
  ...spaceSeparators,
  "'",
  '\u2019',
];
const decimalSeparators: ReadonlySet<string> = new Set(['.', ',']);

const space = `[${spaceSeparators.join('')}]`;
const numberPattern = /[0-9](?:[0-9.,'\u2019 \u00a0\u202f]*[0-9])?/g;
const prefixPattern = new RegExp(`^(?:(${currencyMarkPattern})${space}?)?$`);
const tax = `(?:${space}\\+${space}tax)?`;
/** After a number with no mark before it: a mark, then an ISO tag, then tax. */
const suffixPattern = new RegExp(
  `^(?:${space}?(${currencyMarkPattern}))?(?:${space}([A-Z]{3}))?${tax}$`,
);
/** After a number whose mark came first: only an ISO tag, then tax. */
const tagSuffixPattern = new RegExp(`^(?:${space}([A-Z]{3}))?${tax}$`);

function candidatesOf(mark: string): readonly string[] {
  const shared = currencyMarks.get(mark);
  if (shared) {
    return shared;
  }
  return [assertCurrency(mark)];
}

function marksIn(prefix: string, suffix: string, text: string): string[] {
  const prefixMatch = prefixPattern.exec(prefix);
  if (!prefixMatch) {
    throw new MoneyError(
      'malformed',
      `${JSON.stringify(text)} has an unreadable prefix ${JSON.stringify(prefix)}`,
    );
  }
  const prefixMark = prefixMatch[1];
  const suffixMatch = (prefixMark ? tagSuffixPattern : suffixPattern).exec(
    suffix,
  );
  if (!suffixMatch) {
    throw new MoneyError(
      'malformed',
      `${JSON.stringify(text)} has an unreadable suffix ${JSON.stringify(suffix)}`,
    );
  }
  return [prefixMark, ...suffixMatch.slice(1)].filter(
    (mark): mark is string => mark !== undefined,
  );
}

interface NumberParts {
  digits: string;
  fraction: string;
  groupSeparator: string | null;
  decimalSeparator: '.' | ',' | null;
}

/**
 * Splits the number into its whole digits and decimals. `exponentBound` is the
 * largest minor-unit exponent the text's currency can have, or undefined when
 * no currency is known. It settles `1.299` only when no candidate currency
 * has three decimals, because then `.299` cannot be decimals.
 */
function readNumber(
  core: string,
  exponentBound: number | undefined,
  text: string,
): NumberParts {
  const malformed = (why: string) =>
    new MoneyError('malformed', `${JSON.stringify(text)}: ${why}`);
  const separators = [...core.matchAll(/[^0-9]/g)].map((match) => ({
    character: match[0],
    index: match.index,
  }));
  for (let index = 1; index < separators.length; index += 1) {
    if (separators[index].index === separators[index - 1].index + 1) {
      throw malformed('two separators in a row');
    }
  }
  const kinds = new Set(separators.map((separator) => separator.character));
  if (kinds.size > 2) {
    throw malformed('more than two kinds of separator');
  }

  let decimal: '.' | ',' | null = null;
  const last = separators.at(-1)?.character;
  if (last !== undefined && kinds.size === 2) {
    const count = separators.filter((s) => s.character === last).length;
    if (!decimalSeparators.has(last) || count !== 1) {
      throw malformed('the last separator is not a single decimal separator');
    }
    decimal = last as '.' | ',';
  } else if (
    last !== undefined &&
    decimalSeparators.has(last) &&
    separators.length === 1
  ) {
    const [before, after] = core.split(last);
    const couldBeThousands =
      after.length === 3 && before.length <= 3 && !before.startsWith('0');
    if (!couldBeThousands) {
      decimal = last as '.' | ',';
    } else if (exponentBound === undefined || exponentBound >= 3) {
      throw new MoneyError(
        'ambiguous_separator',
        `${JSON.stringify(text)} could be thousands or decimals, and its currency does not settle which`,
      );
    }
  }

  const [whole, fraction = ''] =
    decimal === null ? [core] : core.split(decimal);
  const groupSeparator = [...kinds].find((kind) => kind !== decimal) ?? null;
  const groups =
    groupSeparator === null ? [whole] : whole.split(groupSeparator);
  if (
    groupSeparator !== null &&
    (groups[0].length > 3 || groups.slice(1).some((g) => g.length !== 3))
  ) {
    throw malformed('thousands are not grouped in threes');
  }
  const digits = groups.join('');
  if (digits.length > 1 && digits.startsWith('0')) {
    throw malformed('a leading zero');
  }
  return { digits, fraction, groupSeparator, decimalSeparator: decimal };
}

function resolveCurrency(
  candidateSets: readonly (readonly string[])[],
  given: string | undefined,
  text: string,
): string {
  let candidates: readonly string[] | undefined =
    given === undefined ? undefined : [given];
  for (const set of candidateSets) {
    candidates =
      candidates === undefined
        ? set
        : candidates.filter((currency) => set.includes(currency));
  }
  if (candidates === undefined) {
    throw new MoneyError(
      'missing_currency',
      `${JSON.stringify(text)} names no currency, and none was given`,
    );
  }
  if (candidates.length === 0) {
    throw new MoneyError(
      'currency_mismatch',
      `${JSON.stringify(text)} is not in ${given ?? 'one currency'}`,
    );
  }
  if (candidates.length > 1) {
    throw new MoneyError(
      'ambiguous_currency',
      `${JSON.stringify(text)} could be ${candidates.join(', ')}; give the currency`,
    );
  }
  return candidates[0];
}

/**
 * Reads a displayed price into exact money, with the style it was written in.
 * Refuses, with a `MoneyError`, anything it cannot read exactly.
 */
export function parseMoney(
  text: string,
  options: ParseMoneyOptions = {},
): ParsedPrice {
  if (typeof text !== 'string') {
    throw new MoneyError(
      'not_a_string',
      'a price must be given as text, never as a number',
    );
  }
  const given =
    options.currency === undefined
      ? undefined
      : assertCurrency(options.currency);
  const trimmed = text.trim();
  const numbers = [...trimmed.matchAll(numberPattern)];
  if (numbers.length !== 1) {
    throw new MoneyError(
      'malformed',
      `${JSON.stringify(text)} must hold exactly one number`,
    );
  }
  const [number] = numbers;
  const core = number[0];
  const prefix = trimmed.slice(0, number.index);
  const suffix = trimmed.slice(number.index + core.length);
  const candidateSets = marksIn(prefix, suffix, text).map(candidatesOf);

  const possible = (
    given === undefined
      ? candidateSets.length === 0
        ? undefined
        : candidateSets.flat()
      : [given]
  )?.map(minorUnitExponent);
  const parts = readNumber(
    core,
    possible === undefined ? undefined : Math.max(...possible),
    text,
  );
  const currency = resolveCurrency(candidateSets, given, text);
  const exponent = minorUnitExponent(currency);
  if (parts.fraction.length > exponent) {
    throw new MoneyError(
      'too_many_fraction_digits',
      `${JSON.stringify(text)} has more than the ${exponent} decimals of ${currency}`,
    );
  }

  const minor =
    BigInt(parts.digits) * 10n ** BigInt(exponent) +
    BigInt(parts.fraction.padEnd(exponent, '0') || '0');
  return {
    money: fromMinor(currency, minor),
    style: {
      prefix,
      suffix,
      groupSeparator: parts.groupSeparator,
      decimalSeparator: parts.decimalSeparator,
      fractionDigits: parts.fraction.length,
    },
    sourceText: text,
  };
}
