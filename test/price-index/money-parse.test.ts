import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  formatMoney,
  MoneyError,
  parseDecimal,
  parseMoney,
  toDecimalString,
  type MoneyErrorCode,
} from '../../packages/price-index/src/money/index.ts';
import { marketsFileSchema } from '../../packages/price-index/src/schema/index.ts';

// E11.6-03: reading displayed prices into exact money. Every currency in
// config/markets.json, and every currency on the 38 captured country pages,
// has a table of its own formats and of every thousands separator it can
// carry; ambiguous strings are refused, never guessed.

const NBSP = '\u00a0';
const NNBSP = '\u202f';

function decimalOf(text: string, currency?: string): string {
  const parsed = parseMoney(text, currency ? { currency } : {});
  if (currency) {
    assert.equal(parsed.money.currency, currency, text);
  }
  return `${toDecimalString(parsed.money)} ${parsed.money.currency}`;
}

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

/**
 * Each currency's own formats: the source's style as E11.6-01 recorded it
 * (docs/features/price-index-source-findings.md#local-number-and-currency-formats),
 * the forms the ticket names, and the local forms the currency is written in.
 * `context` is the currency the caller knows; it is given only where the mark
 * is shared (`kr`, `$`) or absent, so the rest prove the mark alone settles it.
 */
const ownFormats: Record<
  string,
  { text: string; expected: string; context?: string }[]
> = {
  SEK: [
    { text: `kr${NBSP}169`, expected: '169.00', context: 'SEK' },
    { text: `kr${NBSP}1,079.88`, expected: '1079.88', context: 'SEK' },
    { text: `kr${NBSP}70`, expected: '70.00', context: 'SEK' },
    { text: '149 kr', expected: '149.00', context: 'SEK' },
    { text: 'kr 149', expected: '149.00', context: 'SEK' },
    { text: `1${NNBSP}299,00 kr`, expected: '1299.00', context: 'SEK' },
    { text: '129,50 SEK', expected: '129.50' },
  ],
  NOK: [
    { text: `kr${NBSP}961.25`, expected: '961.25', context: 'NOK' },
    { text: `kr${NBSP}38`, expected: '38.00', context: 'NOK' },
    { text: `1${NBSP}299,00 kr`, expected: '1299.00', context: 'NOK' },
    { text: 'NOK 129', expected: '129.00' },
  ],
  DKK: [
    { text: `kr${NBSP}612.50`, expected: '612.50', context: 'DKK' },
    { text: `kr${NBSP}9`, expected: '9.00', context: 'DKK' },
    { text: '1.299,00 kr', expected: '1299.00', context: 'DKK' },
    { text: '79,00 DKK', expected: '79.00' },
  ],
  ISK: [
    { text: `kr${NBSP}1,190`, expected: '1190', context: 'ISK' },
    { text: `kr${NBSP}1,350`, expected: '1350', context: 'ISK' },
    { text: '1.190 kr', expected: '1190', context: 'ISK' },
    { text: 'ISK 990', expected: '990' },
  ],
  EUR: [
    { text: '€107.88', expected: '107.88' },
    { text: '€8', expected: '8.00' },
    { text: '€18 EUR', expected: '18.00' },
    { text: '€80.61 EUR', expected: '80.61' },
    { text: '11,99 €', expected: '11.99' },
    { text: '€11.99', expected: '11.99' },
    { text: `11,99${NBSP}€`, expected: '11.99' },
    { text: `1${NNBSP}299,99 €`, expected: '1299.99' },
    { text: '1.299,99 €', expected: '1299.99' },
  ],
  GBP: [
    { text: '£66.49', expected: '66.49' },
    { text: '£7', expected: '7.00' },
    { text: '£10.99', expected: '10.99' },
    { text: '£1,299.99', expected: '1299.99' },
  ],
  PLN: [
    { text: `zł${NBSP}299.88`, expected: '299.88' },
    { text: `zł${NBSP}25`, expected: '25.00' },
    { text: '23,99 zł', expected: '23.99' },
    { text: `1${NBSP}299,99 zł`, expected: '1299.99' },
  ],
  RON: [
    { text: `lei${NBSP}399.99`, expected: '399.99' },
    { text: `lei${NBSP}40`, expected: '40.00' },
    { text: '25,99 lei', expected: '25.99' },
    { text: '1.299,99 lei', expected: '1299.99' },
  ],
  CHF: [
    { text: `CHF${NBSP}131.88`, expected: '131.88' },
    { text: `CHF${NBSP}1`, expected: '1.00' },
    { text: 'CHF 14.39', expected: '14.39' },
    { text: "CHF 1'299.50", expected: '1299.50' },
    { text: 'CHF 1\u2019299.50', expected: '1299.50' },
  ],
  CAD: [
    { text: 'CA$143.40', expected: '143.40' },
    { text: 'CA$81', expected: '81.00' },
    { text: 'C$12.99', expected: '12.99' },
    { text: '$12.99', expected: '12.99', context: 'CAD' },
    { text: '12,99 $', expected: '12.99', context: 'CAD' },
  ],
  USD: [
    { text: '$107.40', expected: '107.40', context: 'USD' },
    { text: '$8', expected: '8.00', context: 'USD' },
    { text: '$11.99', expected: '11.99', context: 'USD' },
    { text: '$20 USD', expected: '20.00' },
    { text: '$19.99 + tax', expected: '19.99', context: 'USD' },
    { text: 'US$1,299.00', expected: '1299.00' },
  ],
  AUD: [
    { text: 'A$113.49', expected: '113.49' },
    { text: 'A$16', expected: '16.00' },
    { text: 'A$16.99', expected: '16.99' },
    { text: 'A$9.99 AUD', expected: '9.99' },
    { text: '$16.99', expected: '16.99', context: 'AUD' },
  ],
  CZK: [
    { text: `Kč${NBSP}549.99`, expected: '549.99' },
    { text: `Kč${NBSP}2,449`, expected: '2449.00' },
    { text: `2${NBSP}449 Kč`, expected: '2449.00' },
    { text: '199,00 Kč', expected: '199.00' },
  ],
  HUF: [
    { text: `Ft${NBSP}32,999`, expected: '32999.00' },
    { text: `Ft${NBSP}2,790`, expected: '2790.00' },
    { text: `Ft${NBSP}399`, expected: '399.00' },
    { text: `2${NBSP}790 Ft`, expected: '2790.00' },
  ],
  NZD: [
    { text: 'NZ$131.68', expected: '131.68' },
    { text: 'NZ$17', expected: '17.00' },
    { text: '$17.99', expected: '17.99', context: 'NZD' },
  ],
  RSD: [
    { text: `RSD${NBSP}2,599`, expected: '2599.00' },
    { text: `RSD${NBSP}819`, expected: '819.00' },
    { text: '2.599,00 RSD', expected: '2599.00' },
  ],
};

/**
 * How each currency writes its mark, for the separator tables: before the
 * number in the source's style, so each separator is tried in a real shape.
 */
const markOf: Record<
  string,
  { prefix: string; suffix: string; context?: string }
> = {
  SEK: { prefix: `kr${NBSP}`, suffix: '', context: 'SEK' },
  NOK: { prefix: `kr${NBSP}`, suffix: '', context: 'NOK' },
  DKK: { prefix: '', suffix: ' kr', context: 'DKK' },
  ISK: { prefix: `kr${NBSP}`, suffix: '', context: 'ISK' },
  EUR: { prefix: '', suffix: ' €' },
  GBP: { prefix: '£', suffix: '' },
  PLN: { prefix: '', suffix: ' zł' },
  RON: { prefix: '', suffix: ' lei' },
  CHF: { prefix: 'CHF ', suffix: '' },
  CAD: { prefix: 'CA$', suffix: '' },
  USD: { prefix: '$', suffix: '', context: 'USD' },
  AUD: { prefix: 'A$', suffix: '' },
  CZK: { prefix: '', suffix: ' Kč' },
  HUF: { prefix: '', suffix: ' Ft' },
  NZD: { prefix: 'NZ$', suffix: '' },
  RSD: { prefix: 'RSD ', suffix: '' },
};

/** The currencies of the 38 captured country pages (E11.6-01's table). */
const fixtureCurrencies = [
  'AUD',
  'CAD',
  'CHF',
  'CZK',
  'DKK',
  'EUR',
  'GBP',
  'HUF',
  'ISK',
  'NOK',
  'NZD',
  'PLN',
  'RON',
  'RSD',
  'SEK',
  'USD',
];

/** Every thousands separator the ticket names, and the typographic apostrophe. */
const thousandsSeparators = [
  { name: 'full stop', character: '.', decimal: ',' },
  { name: 'comma', character: ',', decimal: '.' },
  { name: 'space', character: ' ', decimal: ',' },
  { name: 'no-break space', character: NBSP, decimal: ',' },
  { name: 'narrow no-break space', character: NNBSP, decimal: ',' },
  { name: 'apostrophe', character: "'", decimal: '.' },
  { name: 'typographic apostrophe', character: '\u2019', decimal: '.' },
];

test('every market currency and every captured currency has a format table', () => {
  const markets = marketsFileSchema.parse(
    JSON.parse(readFileSync('config/markets.json', 'utf8')),
  );
  const required = new Set([
    ...markets.markets.map((market) => market.currency),
    ...fixtureCurrencies,
  ]);
  assert.deepEqual(
    [...required].sort(),
    Object.keys(ownFormats).sort(),
    'a currency without a parse table',
  );
  assert.deepEqual(Object.keys(markOf).sort(), [...required].sort());
});

for (const [currency, rows] of Object.entries(ownFormats)) {
  test(`${currency}: its own formats parse exactly and write back unchanged`, () => {
    for (const row of rows) {
      const parsed = parseMoney(
        row.text,
        row.context ? { currency: row.context } : {},
      );
      assert.equal(parsed.money.currency, currency, row.text);
      assert.equal(toDecimalString(parsed.money), row.expected, row.text);
      assert.equal(parsed.sourceText, row.text);
      assert.equal(formatMoney(parsed.money, parsed.style), row.text);
    }
  });

  test(`${currency}: every thousands separator parses exactly`, () => {
    const { prefix, suffix, context } = markOf[currency];
    const whole = currency === 'ISK' ? '1299' : '1299.00';
    const many = currency === 'ISK' ? '12345678' : '12345678.00';
    for (const { name, character, decimal } of thousandsSeparators) {
      const label = `${currency} with a ${name}`;
      const text = (number: string) => `${prefix}${number}${suffix}`;
      assert.equal(
        decimalOf(text(`1${character}299`), context),
        `${whole} ${currency}`,
        label,
      );
      assert.equal(
        decimalOf(text(`12${character}345${character}678`), context),
        `${many} ${currency}`,
        label,
      );
      if (currency === 'ISK') {
        // ISK has no minor unit, so decimals can only be refused.
        assertRefused(
          () => parseMoney(text(`1${character}299${decimal}99`), { currency }),
          'too_many_fraction_digits',
          label,
        );
      } else {
        assert.equal(
          decimalOf(text(`1${character}299${decimal}99`), context),
          `1299.99 ${currency}`,
          label,
        );
        assert.equal(
          decimalOf(
            text(`12${character}345${character}678${decimal}05`),
            context,
          ),
          `12345678.05 ${currency}`,
          label,
        );
      }
    }
  });
}

test('an ambiguous separator is refused, never guessed', () => {
  // With no currency, `1.299` could be 1299 or 1.299.
  for (const text of ['1.299', '1,299', '12.500', '999,999']) {
    assertRefused(() => parseMoney(text), 'ambiguous_separator', text);
  }
  // A three-decimal currency cannot settle it either.
  for (const currency of ['TND', 'KWD', 'BHD']) {
    assertRefused(
      () => parseMoney('1.299', { currency }),
      'ambiguous_separator',
      `1.299 ${currency}`,
    );
    assertRefused(
      () => parseMoney(`1,299 ${currency}`),
      'ambiguous_separator',
      `1,299 ${currency}`,
    );
  }
  // A currency with fewer than three decimals settles it: `.299` cannot be
  // its decimals, so the separator is a thousands separator.
  assert.equal(decimalOf('€1.299'), '1299.00 EUR');
  assert.equal(decimalOf('1.299', 'EUR'), '1299.00 EUR');
  assert.equal(decimalOf('1,299', 'ISK'), '1299 ISK');
  // A form that is never ambiguous needs no currency to read the number.
  assert.equal(decimalOf('1.299,99', 'EUR'), '1299.99 EUR');
  assert.equal(decimalOf('1,299.999', 'TND'), '1299.999 TND');
  assert.equal(decimalOf('0.299', 'TND'), '0.299 TND');
});

test('a currency it cannot settle is refused', () => {
  assertRefused(() => parseMoney('149'), 'missing_currency', '149');
  assertRefused(() => parseMoney('11.99'), 'missing_currency', '11.99');
  assertRefused(() => parseMoney('kr 149'), 'ambiguous_currency', 'kr');
  assertRefused(() => parseMoney('$11.99'), 'ambiguous_currency', '$');
  assertRefused(
    () => parseMoney('€9.99', { currency: 'SEK' }),
    'currency_mismatch',
    '€ given SEK',
  );
  assertRefused(
    () => parseMoney('kr 149', { currency: 'EUR' }),
    'currency_mismatch',
    'kr given EUR',
  );
  assertRefused(
    () => parseMoney('€18 USD'),
    'currency_mismatch',
    'a mark and a code that disagree',
  );
  assertRefused(
    () => parseMoney('$12.99', { currency: 'SGD' }),
    'currency_mismatch',
    '$ for a currency the table does not list under $',
  );
  assertRefused(() => parseMoney('ABC 12'), 'unknown_currency', 'ABC');
  assertRefused(
    () => parseMoney('12', { currency: 'XXX' }),
    'unknown_currency',
    'XXX',
  );
});

test('a text that is not one plain price is refused', () => {
  const malformed = [
    '',
    'kr',
    '€9.99 / €4.99',
    '-€5',
    '€-5',
    '€1,29,999',
    '€1.2999,00',
    '€1 299.299,00',
    '€1..299',
    '€1.299.99',
    "€1'299 999",
    '€012',
    '€9.99 tax',
    'kr  149',
    'about €9',
    '€9.99 per month',
    '€9e2',
  ];
  for (const text of malformed) {
    assertRefused(
      () => parseMoney(text, { currency: 'EUR' }),
      'malformed',
      text,
    );
  }
  assertRefused(
    () => parseMoney('€1234.567'),
    'too_many_fraction_digits',
    'three decimals for EUR',
  );
  assertRefused(
    () => parseMoney('€0.299'),
    'too_many_fraction_digits',
    'a leading zero cannot start a thousands group',
  );
});

test('a JavaScript number is refused wherever a price enters', () => {
  for (const value of [149, 11.99, 0.1 + 0.2]) {
    assertRefused(
      () => parseMoney(value as unknown as string, { currency: 'SEK' }),
      'not_a_string',
      `parseMoney(${value})`,
    );
    assertRefused(
      () => parseDecimal(value as unknown as string, 'SEK'),
      'not_a_string',
      `parseDecimal(${value})`,
    );
  }
});

test('parseDecimal reads a JSON number text exactly, never through a float', () => {
  assert.equal(toDecimalString(parseDecimal('932.5', 'SEK')), '932.50');
  assert.equal(toDecimalString(parseDecimal('169', 'SEK')), '169.00');
  assert.equal(toDecimalString(parseDecimal('1190', 'ISK')), '1190');
  assert.equal(toDecimalString(parseDecimal('0.1', 'USD')), '0.10');
  // 2^53 + 1 is not a double; as text it stays exact.
  assert.equal(
    toDecimalString(parseDecimal('9007199254740993.01', 'USD')),
    '9007199254740993.01',
  );
  for (const text of ['1e3', '-1', '+1', '1.', '.5', '01', '1,5', ' 1', '']) {
    assertRefused(() => parseDecimal(text, 'SEK'), 'malformed', text);
  }
  assertRefused(
    () => parseDecimal('1.999', 'SEK'),
    'too_many_fraction_digits',
    '1.999 SEK',
  );
  assertRefused(
    () => parseDecimal('1.5', 'ISK'),
    'too_many_fraction_digits',
    '1.5 ISK',
  );
});

// Every visible price on the founder-captured country pages, read with the
// currency the page's own embedded data gives, which is how the adapter will
// read it (docs/features/price-index-source-findings.md).
const fixtureDirectory = 'packages/price-index/test/fixtures/youfundceo/pages';

function visiblePrices(html: string): string[] {
  return [
    ...html.matchAll(/whitespace-pre"> · <!-- -->(.*?)<\/span><\/span>/g),
  ].map((match) => match[1].replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ''));
}

function embeddedPrices(html: string): { amount: string; currency: string }[] {
  return [
    ...html.matchAll(
      /\\"official\\":\{\\"amount\\":([0-9.]+),\\"currency\\":\\"([A-Z]{3})\\"/g,
    ),
  ].map((match) => ({ amount: match[1], currency: match[2] }));
}

test('every price on the 38 captured country pages parses to its embedded value', () => {
  const pages = readdirSync(fixtureDirectory).filter((name) =>
    /^countries__.+\.server\.html$/.test(name),
  );
  assert.equal(pages.length, 38);
  const seen = new Set<string>();
  let count = 0;
  for (const page of pages) {
    const html = readFileSync(`${fixtureDirectory}/${page}`, 'utf8');
    const texts = visiblePrices(html);
    const embedded = embeddedPrices(html);
    assert.ok(texts.length > 0, `${page} has prices`);
    assert.equal(texts.length, embedded.length, page);
    texts.forEach((text, index) => {
      const { amount, currency } = embedded[index];
      const parsed = parseMoney(text, { currency });
      assert.deepEqual(
        parsed.money,
        parseDecimal(amount, currency),
        `${page}: ${JSON.stringify(text)} against ${amount} ${currency}`,
      );
      assert.equal(formatMoney(parsed.money, parsed.style), text);
      seen.add(currency);
      count += 1;
    });
  }
  assert.ok(count > 1000, `only ${count} prices read`);
  assert.deepEqual([...seen].sort(), fixtureCurrencies);
});
