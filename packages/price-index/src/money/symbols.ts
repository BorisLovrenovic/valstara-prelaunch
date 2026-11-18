// The currency marks a price text can carry, and the currencies each can mean
// (E11.6-03). They are the marks E11.6-01 recorded on the 38 captured country
// pages (docs/features/price-index-source-findings.md#local-number-and-currency-formats),
// plus the forms the ticket names (`C$`). A three-letter ISO 4217 code is
// also a mark, and means only itself.
//
// A mark shared by several currencies (`kr`, `$`) settles only against a
// currency the caller gives. A currency not listed under `$` must be written
// with its own code, or the parse fails loudly rather than guessing.

export const currencyMarks: ReadonlyMap<string, readonly string[]> = new Map([
  ['€', ['EUR']],
  ['£', ['GBP']],
  ['$', ['USD', 'CAD', 'AUD', 'NZD']],
  ['US$', ['USD']],
  ['A$', ['AUD']],
  ['AU$', ['AUD']],
  ['C$', ['CAD']],
  ['CA$', ['CAD']],
  ['NZ$', ['NZD']],
  ['kr', ['SEK', 'NOK', 'DKK', 'ISK']],
  ['zł', ['PLN']],
  ['lei', ['RON']],
  ['Kč', ['CZK']],
  ['Ft', ['HUF']],
]);

/** The marks, longest first, then any three-letter code, as one alternation. */
export const currencyMarkPattern = [
  ...[...currencyMarks.keys()]
    .sort((a, b) => b.length - a.length)
    .map((mark) => mark.replace(/\$/g, '\\$')),
  '[A-Z]{3}',
].join('|');
