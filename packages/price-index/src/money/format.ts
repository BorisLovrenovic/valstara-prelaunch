import { minorUnitExponent } from '../schema/iso4217.ts';
import { MoneyError } from './errors.ts';
import type { Money } from './money.ts';
import { groupSeparators, type MoneyStyle } from './parse.ts';

// Writes exact money back in a local style (E11.6-03). With the style
// `parseMoney` read from a text, it writes that text again exactly:
// `formatMoney(parsed.money, parsed.style) === text`.

/**
 * Writes `money` in `style`. It writes the style's number of decimals when
 * they hold the amount exactly (`kr 169`, `€9.99`), and otherwise all of the
 * currency's decimals, so no amount is ever cut short.
 */
export function formatMoney(money: Money, style: MoneyStyle): string {
  const exponent = minorUnitExponent(money.currency);
  if (
    !Number.isInteger(style.fractionDigits) ||
    style.fractionDigits < 0 ||
    style.fractionDigits > exponent
  ) {
    throw new MoneyError(
      'malformed',
      `a ${money.currency} style writes 0 to ${exponent} decimals`,
    );
  }
  if (
    style.groupSeparator !== null &&
    (!groupSeparators.includes(style.groupSeparator) ||
      style.groupSeparator === style.decimalSeparator)
  ) {
    throw new MoneyError(
      'malformed',
      'the style has an unknown thousands separator',
    );
  }

  const scale = 10n ** BigInt(exponent);
  const whole = (money.minor / scale).toString();
  const decimals =
    exponent === 0
      ? ''
      : (money.minor % scale).toString().padStart(exponent, '0');
  const shown = /^0*$/.test(decimals.slice(style.fractionDigits))
    ? style.fractionDigits
    : exponent;
  if (shown > 0 && style.decimalSeparator === null) {
    throw new MoneyError(
      'style_cannot_write_fraction',
      `the style has no decimal separator, so it cannot write ${money.currency} decimals`,
    );
  }

  const grouped =
    style.groupSeparator === null
      ? whole
      : whole.replace(/\B(?=(?:[0-9]{3})+$)/g, style.groupSeparator);
  const fraction =
    shown === 0 ? '' : `${style.decimalSeparator}${decimals.slice(0, shown)}`;
  return `${style.prefix}${grouped}${fraction}${style.suffix}`;
}
