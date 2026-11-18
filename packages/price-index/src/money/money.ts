import { iso4217Currencies, minorUnitExponent } from '../schema/iso4217.ts';
import { MoneyError } from './errors.ts';

// Exact money in integer minor units (E11.6-03, epic rule 3). An amount is a
// bigint count of the currency's minor unit: `149.00 SEK` is `14900n`. A float
// never holds a price, so every entry point refuses a JavaScript number, and
// there is no conversion between currencies anywhere.

export interface Money {
  readonly currency: string;
  /** The amount in the currency's minor unit. Never negative. */
  readonly minor: bigint;
}

export function assertCurrency(currency: unknown): string {
  if (typeof currency !== 'string') {
    throw new MoneyError('not_a_string', 'a currency code must be a string');
  }
  if (!iso4217Currencies.has(currency)) {
    throw new MoneyError(
      'unknown_currency',
      `${currency} is not a currency in the ISO 4217 table`,
    );
  }
  return currency;
}

/** A money value from a minor-unit amount, which must be a bigint ≥ 0. */
export function fromMinor(currency: string, minor: bigint): Money {
  const code = assertCurrency(currency);
  if (typeof minor !== 'bigint') {
    throw new MoneyError(
      'not_a_bigint',
      'a minor-unit amount must be a bigint, never a number',
    );
  }
  if (minor < 0n) {
    throw new MoneyError('negative', 'a price is never negative');
  }
  return { currency: code, minor };
}

function scale(currency: string): bigint {
  return 10n ** BigInt(minorUnitExponent(currency));
}

/**
 * Reads a plain decimal, such as the text of a JSON number on the source
 * (`932.5`) or a price typed by the founder (`149`), into exact money. It may
 * carry fewer decimals than the currency's exponent, never more: nothing is
 * rounded. Signs, exponent notation, separators and symbols are refused.
 */
export function parseDecimal(text: string, currency: string): Money {
  if (typeof text !== 'string') {
    throw new MoneyError(
      'not_a_string',
      'a price must be given as text, never as a number',
    );
  }
  const code = assertCurrency(currency);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text);
  if (!match) {
    throw new MoneyError(
      'malformed',
      `${JSON.stringify(text)} is not a plain decimal`,
    );
  }
  const exponent = minorUnitExponent(code);
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) {
    throw new MoneyError(
      'too_many_fraction_digits',
      `${JSON.stringify(text)} has more than the ${exponent} decimals of ${code}`,
    );
  }
  return fromMinor(
    code,
    BigInt(match[1]) * scale(code) +
      BigInt(fraction.padEnd(exponent, '0') || '0'),
  );
}

/**
 * The exact decimal string of a money value, written at the currency's
 * exponent: `"149.00"` for SEK, `"1190"` for ISK. This is the form a record's
 * `price_local` holds.
 */
export function toDecimalString(money: Money): string {
  const exponent = minorUnitExponent(money.currency);
  if (exponent === 0) {
    return money.minor.toString();
  }
  const digits = money.minor.toString().padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/**
 * Reads a decimal string written exactly at the currency's exponent, the form
 * `toDecimalString` writes and a record stores. `"149"` is refused for SEK.
 */
export function fromDecimalString(value: string, currency: string): Money {
  const parsed = parseDecimal(value, currency);
  if (toDecimalString(parsed) !== value) {
    throw new MoneyError(
      'malformed',
      `${JSON.stringify(value)} is not written at the ${minorUnitExponent(parsed.currency)} decimals of ${parsed.currency}`,
    );
  }
  return parsed;
}

function sameCurrency(a: Money, b: Money): string {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      'currency_mismatch',
      `cannot combine ${a.currency} with ${b.currency}: there is no conversion`,
    );
  }
  return a.currency;
}

export function add(a: Money, b: Money): Money {
  return fromMinor(sameCurrency(a, b), a.minor + b.minor);
}

/** `a − b`; refused when the result would be negative. */
export function subtract(a: Money, b: Money): Money {
  return fromMinor(sameCurrency(a, b), a.minor - b.minor);
}

/** `money × factor`, for a whole factor such as a term in months. */
export function multiply(money: Money, factor: bigint): Money {
  if (typeof factor !== 'bigint') {
    throw new MoneyError(
      'not_a_bigint',
      'a factor must be a bigint, never a number',
    );
  }
  return fromMinor(money.currency, money.minor * factor);
}

/** -1, 0 or 1 as `a` is below, equal to or above `b`, in one currency. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  if (a.minor === b.minor) {
    return 0;
  }
  return a.minor < b.minor ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}
