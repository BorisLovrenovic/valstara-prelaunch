import assert from 'node:assert/strict';
import test from 'node:test';

import { suggestCountry } from '../src/server/geo/suggest-country.ts';

function headers(value?: string): Headers {
  const result = new Headers();
  if (value !== undefined) {
    result.set('CF-IPCountry', value);
  }
  return result;
}

// The contract is a *suggestion*: a plausible ISO 3166-1 alpha-2 code, or null.
// Each null case matters because a null renders the selector unfilled — the
// alternative to guessing a country a person never chose.
const cases: ReadonlyArray<{
  readonly name: string;
  readonly header?: string;
  readonly expected: string | null;
}> = [
  {
    name: 'a valid code passes through, uppercased',
    header: 'FR',
    expected: 'FR',
  },
  { name: 'a lowercase code is normalised', header: 'ca', expected: 'CA' },
  {
    name: 'surrounding whitespace is trimmed',
    header: '  gb  ',
    expected: 'GB',
  },
  { name: 'an absent header returns null', expected: null },
  {
    name: 'the XX unknown sentinel returns null',
    header: 'XX',
    expected: null,
  },
  {
    name: 'the lowercase xx sentinel returns null',
    header: 'xx',
    expected: null,
  },
  { name: 'the T1 Tor sentinel returns null', header: 'T1', expected: null },
  { name: 'an empty header returns null', header: '', expected: null },
  { name: 'a one-letter value returns null', header: 'C', expected: null },
  { name: 'a three-letter value returns null', header: 'CAN', expected: null },
  { name: 'a digit-bearing value returns null', header: 'C1', expected: null },
];

for (const testCase of cases) {
  test(`suggestCountry — ${testCase.name}`, () => {
    assert.equal(suggestCountry(headers(testCase.header)), testCase.expected);
  });
}

test('suggestCountry only reads CF-IPCountry, not any other header', () => {
  const decoys = new Headers({
    'X-Country': 'DE',
    'Accept-Language': 'de-DE',
  });
  // A mutation that read the wrong header, or defaulted to a guess, would
  // return a country here instead of null.
  assert.equal(suggestCountry(decoys), null);
});
