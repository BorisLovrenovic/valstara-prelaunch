import assert from 'node:assert/strict';
import test from 'node:test';

import {
  add,
  compare,
  equals,
  formatMoney,
  fromDecimalString,
  fromMinor,
  MoneyError,
  multiply,
  parseMoney,
  subtract,
  toDecimalString,
  type MoneyErrorCode,
  type MoneyStyle,
} from '../../packages/price-index/src/money/index.ts';

// E11.6-03: writing exact money back in a local style, the decimal strings a
// record stores, and arithmetic in integer minor units with no conversion.

function assertRefused(
  run: () => unknown,
  code: MoneyErrorCode,
  label: string,
): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof MoneyError && error.code === code,
    `${label} should be refused with ${code}`,
  );
}

const sek = (decimal: string) => fromDecimalString(decimal, 'SEK');
const eur = (decimal: string) => fromDecimalString(decimal, 'EUR');

test('a parsed text writes back byte for byte, its spaces and suffixes kept', () => {
  const texts: [string, string?][] = [
    ['kr\u00a01,079.88', 'SEK'],
    ['kr\u00a0169', 'SEK'],
    ['1\u202f299,00 kr', 'SEK'],
    ['€18 EUR'],
    ['$19.99 + tax', 'USD'],
    ["CHF 1'299.50"],
    ['CHF 1\u2019299.50'],
    ['1.299,99 €'],
    ['€9.9'],
    ['Ft\u00a032,999'],
    ['kr\u00a01,190', 'ISK'],
    ['12 345 678,05 zł'],
  ];
  for (const [text, currency] of texts) {
    const parsed = parseMoney(text, currency ? { currency } : {});
    assert.equal(formatMoney(parsed.money, parsed.style), text);
    assert.equal(parsed.sourceText, text);
  }
});

test('the source text is kept exactly, outer whitespace included', () => {
  const text = ' kr\u00a0149 ';
  const parsed = parseMoney(text, { currency: 'SEK' });
  assert.equal(parsed.sourceText, text);
  assert.equal(toDecimalString(parsed.money), '149.00');
  assert.equal(formatMoney(parsed.money, parsed.style), 'kr\u00a0149');
});

test('a style writes other amounts exactly, never cutting decimals', () => {
  const whole = parseMoney('kr\u00a0169', { currency: 'SEK' }).style;
  assert.equal(formatMoney(sek('129.00'), whole), 'kr\u00a0129');
  assert.equal(formatMoney(sek('1299.00'), whole), 'kr\u00a01299');

  const grouped: MoneyStyle = parseMoney('kr\u00a01,079.88', {
    currency: 'SEK',
  }).style;
  assert.equal(formatMoney(sek('1234567.50'), grouped), 'kr\u00a01,234,567.50');
  assert.equal(formatMoney(sek('999.00'), grouped), 'kr\u00a0999.00');

  const european = parseMoney('1.299,99 €').style;
  assert.equal(formatMoney(eur('0.05'), european), '0,05 €');

  // `€9.9` wrote one decimal; 9.95 needs two, so both are written.
  const oneDecimal = parseMoney('€9.9').style;
  assert.equal(formatMoney(eur('9.95'), oneDecimal), '€9.95');
  assert.equal(formatMoney(eur('9.90'), oneDecimal), '€9.9');

  // `€8` showed no decimal separator, so it cannot write €8.50.
  const noSeparator = parseMoney('€8').style;
  assert.equal(formatMoney(eur('12.00'), noSeparator), '€12');
  assertRefused(
    () => formatMoney(eur('8.50'), noSeparator),
    'style_cannot_write_fraction',
    '€8.50 in the €8 style',
  );

  assertRefused(
    () => formatMoney(sek('1.00'), { ...whole, fractionDigits: 3 }),
    'malformed',
    'three decimals for SEK',
  );
  assertRefused(
    () =>
      formatMoney(sek('1.00'), {
        ...grouped,
        groupSeparator: '-',
      }),
    'malformed',
    'an unknown thousands separator',
  );
});

test('decimal strings are written and read at the currency exponent only', () => {
  assert.equal(toDecimalString(fromMinor('SEK', 14900n)), '149.00');
  assert.equal(toDecimalString(fromMinor('SEK', 5n)), '0.05');
  assert.equal(toDecimalString(fromMinor('ISK', 1190n)), '1190');
  assert.equal(toDecimalString(fromMinor('KWD', 1250n)), '1.250');
  assert.equal(toDecimalString(fromMinor('EUR', 0n)), '0.00');

  assert.equal(sek('149.00').minor, 14900n);
  assert.equal(fromDecimalString('1190', 'ISK').minor, 1190n);
  for (const [value, currency] of [
    ['149', 'SEK'],
    ['149.0', 'SEK'],
    ['149.000', 'SEK'],
    ['1190.0', 'ISK'],
    ['1.25', 'KWD'],
  ]) {
    assert.throws(
      () => fromDecimalString(value, currency),
      MoneyError,
      `${value} ${currency}`,
    );
  }
});

test('a minor-unit amount must be a bigint, never a number', () => {
  assertRefused(
    () => fromMinor('SEK', 14900 as unknown as bigint),
    'not_a_bigint',
    'a number amount',
  );
  assertRefused(
    () => multiply(sek('1.00'), 12 as unknown as bigint),
    'not_a_bigint',
    'a number factor',
  );
  assertRefused(() => fromMinor('SEK', -1n), 'negative', 'a negative amount');
  assertRefused(() => fromMinor('XYZ', 1n), 'unknown_currency', 'XYZ');
});

test('arithmetic is exact in minor units and never mixes currencies', () => {
  // 0.1 + 0.2 is exactly 0.30 here, unlike in floating point.
  assert.equal(toDecimalString(add(eur('0.10'), eur('0.20'))), '0.30');
  assert.equal(
    toDecimalString(subtract(sek('149.00'), sek('129.00'))),
    '20.00',
  );
  assert.equal(toDecimalString(multiply(sek('149.00'), 12n)), '1788.00');
  assert.equal(compare(sek('129.00'), sek('149.00')), -1);
  assert.equal(compare(sek('149.00'), sek('149.00')), 0);
  assert.equal(compare(sek('149.00'), sek('129.00')), 1);
  assert.equal(equals(sek('149.00'), sek('149.00')), true);
  assert.equal(
    equals(sek('149.00'), fromDecimalString('149.00', 'NOK')),
    false,
  );

  assertRefused(
    () => add(sek('1.00'), eur('1.00')),
    'currency_mismatch',
    'SEK + EUR',
  );
  assertRefused(
    () => compare(sek('1.00'), eur('1.00')),
    'currency_mismatch',
    'SEK against EUR',
  );
  assertRefused(
    () => subtract(sek('1.00'), sek('2.00')),
    'negative',
    'a result below zero',
  );
  assertRefused(
    () => multiply(sek('1.00'), -1n),
    'negative',
    'a negative factor',
  );
});
