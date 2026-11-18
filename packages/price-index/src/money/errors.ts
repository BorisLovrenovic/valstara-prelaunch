// The money module's typed errors (E11.6-03). A price that cannot be read
// exactly is refused with one of these codes, never guessed.

export const moneyErrorCodes = [
  /** The input is not a string (a price is never a JavaScript number). */
  'not_a_string',
  /** A minor-unit amount is not a bigint. */
  'not_a_bigint',
  /** The text has no number, more than one, or characters a price never has. */
  'malformed',
  /** `1.299` or `1,299` where the currency cannot settle which it means. */
  'ambiguous_separator',
  /** More decimals than the currency's minor-unit exponent allows. */
  'too_many_fraction_digits',
  /** No currency in the text and none given. */
  'missing_currency',
  /** A symbol several currencies share (`kr`, `$`) and nothing to settle it. */
  'ambiguous_currency',
  /** A currency code outside the ISO 4217 table. */
  'unknown_currency',
  /** The text's currency disagrees with the one given, or with itself. */
  'currency_mismatch',
  /** A negative result, or a negative factor. */
  'negative',
  /** The style has no decimal separator, so it cannot write this amount. */
  'style_cannot_write_fraction',
] as const;

export type MoneyErrorCode = (typeof moneyErrorCodes)[number];

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}
