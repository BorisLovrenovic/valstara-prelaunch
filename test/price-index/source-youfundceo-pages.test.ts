import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

import {
  compare,
  fromDecimalString,
} from '../../packages/price-index/src/money/money.ts';
import {
  PageParseError,
  readCountriesIndex,
  readCountryPage,
  readCountryServicePage,
  readPriceMoves,
  readServicesIndex,
} from '../../packages/price-index/src/sources/youfundceo/pages.ts';
import {
  fixtureDirectory,
  fixtureHtml,
  origin,
} from '../helpers/price-index-sources.ts';

// E11.6-05: every founder-captured page parses to exactly what the page
// shows. The expectations are written by hand from the captured pages
// (docs/features/price-index-source-findings.md), never generated from the
// parser's output. Each page is read both as the browser rendered it (what
// the raw store keeps) and as the server sent it.

const NBSP = ' ';
const copies = ['rendered', 'server'] as const;

type Row = [
  key: string,
  name: string,
  period: 'month' | 'year',
  priceLocal: string,
  currency: string,
  sourceText: string,
  usd: string | null,
];

/** Every plan row of "All plans in <country>", in page order, by hand. */
const countryServicePages: Record<
  string,
  { market: string; verifiedAt: string; rows: Row[] }
> = {
  'services/adobe/sweden': {
    market: 'SE',
    verifiedAt: '2026-11-01',
    rows: [
      [
        'cc-pro',
        'Creative Cloud Pro',
        'month',
        '932.50',
        'SEK',
        `kr${NBSP}932.50`,
        '92.59',
      ],
      [
        'photoshop',
        'Photoshop',
        'month',
        '311.25',
        'SEK',
        `kr${NBSP}311.25`,
        '30.91',
      ],
      [
        'acrobat-pro',
        'Acrobat Pro',
        'month',
        '285.00',
        'SEK',
        `kr${NBSP}285`,
        '28.30',
      ],
      [
        'lightroom',
        'Lightroom (1TB)',
        'month',
        '173.75',
        'SEK',
        `kr${NBSP}173.75`,
        '17.25',
      ],
      [
        'express-premium',
        'Adobe Express Premium',
        'month',
        '142.50',
        'SEK',
        `kr${NBSP}142.50`,
        '14.15',
      ],
      [
        'acrobat-standard',
        'Acrobat Standard',
        'month',
        '215.00',
        'SEK',
        `kr${NBSP}215`,
        '21.35',
      ],
      [
        'acrobat-pro-monthly',
        'Acrobat Pro (monthly plan)',
        'month',
        '426.25',
        'SEK',
        `kr${NBSP}426.25`,
        '42.33',
      ],
      [
        'acrobat-standard-monthly',
        'Acrobat Standard (monthly plan)',
        'month',
        '358.75',
        'SEK',
        `kr${NBSP}358.75`,
        '35.62',
      ],
    ],
  },
  'services/adobe/united-states': {
    market: 'US',
    verifiedAt: '2026-11-01',
    rows: [
      [
        'cc-pro',
        'Creative Cloud Pro',
        'month',
        '69.99',
        'USD',
        '$69.99 + tax',
        '69.99',
      ],
      [
        'photoshop',
        'Photoshop',
        'month',
        '22.99',
        'USD',
        '$22.99 + tax',
        '22.99',
      ],
      [
        'acrobat-pro',
        'Acrobat Pro',
        'month',
        '19.99',
        'USD',
        '$19.99 + tax',
        '19.99',
      ],
      [
        'lightroom',
        'Lightroom (1TB)',
        'month',
        '11.99',
        'USD',
        '$11.99 + tax',
        '11.99',
      ],
      [
        'express-premium',
        'Adobe Express Premium',
        'month',
        '9.99',
        'USD',
        '$9.99 + tax',
        '9.99',
      ],
      [
        'acrobat-standard',
        'Acrobat Standard',
        'month',
        '14.99',
        'USD',
        '$14.99 + tax',
        '14.99',
      ],
      [
        'acrobat-pro-monthly',
        'Acrobat Pro (monthly plan)',
        'month',
        '29.99',
        'USD',
        '$29.99 + tax',
        '29.99',
      ],
      [
        'acrobat-standard-monthly',
        'Acrobat Standard (monthly plan)',
        'month',
        '24.99',
        'USD',
        '$24.99 + tax',
        '24.99',
      ],
    ],
  },
  'services/apple-music/sweden': {
    market: 'SE',
    verifiedAt: '2026-10-30',
    rows: [
      [
        'individual',
        'Individual',
        'month',
        '119.00',
        'SEK',
        `kr${NBSP}119`,
        '11.82',
      ],
      ['family', 'Family', 'month', '209.00', 'SEK', `kr${NBSP}209`, '20.75'],
      ['student', 'Student', 'month', '69.00', 'SEK', `kr${NBSP}69`, '6.85'],
    ],
  },
  'services/apple-music/united-states': {
    market: 'US',
    verifiedAt: '2026-11-16',
    rows: [
      [
        'individual',
        'Individual',
        'month',
        '11.99',
        'USD',
        '$11.99 + tax',
        '11.99',
      ],
      ['family', 'Family', 'month', '19.99', 'USD', '$19.99 + tax', '19.99'],
      ['student', 'Student', 'month', '6.99', 'USD', '$6.99 + tax', '6.99'],
    ],
  },
  'services/chatgpt/sweden': {
    market: 'SE',
    verifiedAt: '2026-10-28',
    rows: [
      [
        'plus',
        'ChatGPT Plus',
        'month',
        '249.00',
        'SEK',
        `kr${NBSP}249`,
        '24.73',
      ],
      ['go', 'ChatGPT Go', 'month', '85.00', 'SEK', `kr${NBSP}85`, '8.44'],
      [
        'pro-100',
        'ChatGPT Pro 100',
        'month',
        '1120.00',
        'SEK',
        `kr${NBSP}1,120`,
        '111.21',
      ],
      [
        'pro-200',
        'ChatGPT Pro 200',
        'month',
        '2495.00',
        'SEK',
        `kr${NBSP}2,495`,
        '247.75',
      ],
      [
        'pro-500',
        'ChatGPT Pro 500',
        'month',
        '5599.00',
        'SEK',
        `kr${NBSP}5,599`,
        '555.97',
      ],
    ],
  },
  'services/chatgpt/united-states': {
    market: 'US',
    verifiedAt: '2026-11-16',
    rows: [
      ['plus', 'ChatGPT Plus', 'month', '20.00', 'USD', '$20 + tax', '20.00'],
      ['go', 'ChatGPT Go', 'month', '8.00', 'USD', '$8 + tax', '8.00'],
      [
        'pro-100',
        'ChatGPT Pro 100',
        'month',
        '100.00',
        'USD',
        '$100 + tax',
        '100.00',
      ],
      [
        'pro-200',
        'ChatGPT Pro 200',
        'month',
        '200.00',
        'USD',
        '$200 + tax',
        '200.00',
      ],
      [
        'pro-500',
        'ChatGPT Pro 500',
        'month',
        '500.00',
        'USD',
        '$500 + tax',
        '500.00',
      ],
    ],
  },
  'services/netflix/sweden': {
    market: 'SE',
    verifiedAt: '2026-11-04',
    rows: [
      [
        'standard',
        'Standard',
        'month',
        '169.00',
        'SEK',
        `kr${NBSP}169`,
        '16.78',
      ],
      ['basic', 'Basic', 'month', '129.00', 'SEK', `kr${NBSP}129`, '12.81'],
      ['premium', 'Premium', 'month', '219.00', 'SEK', `kr${NBSP}219`, '21.75'],
    ],
  },
  'services/netflix/united-states': {
    market: 'US',
    verifiedAt: '2026-10-28',
    rows: [
      [
        'standard',
        'Standard',
        'month',
        '19.99',
        'USD',
        '$19.99 + tax',
        '19.99',
      ],
      [
        'standard-ads',
        'Standard with ads',
        'month',
        '8.99',
        'USD',
        '$8.99 + tax',
        '8.99',
      ],
      ['premium', 'Premium', 'month', '26.99', 'USD', '$26.99 + tax', '26.99'],
    ],
  },
  'services/spotify/sweden': {
    market: 'SE',
    verifiedAt: '2026-11-04',
    rows: [
      [
        'individual',
        'Premium Individual',
        'month',
        '149.00',
        'SEK',
        `kr${NBSP}149`,
        '14.80',
      ],
      [
        'student',
        'Premium Student',
        'month',
        '70.00',
        'SEK',
        `kr${NBSP}70`,
        '6.95',
      ],
      ['duo', 'Premium Duo', 'month', '199.00', 'SEK', `kr${NBSP}199`, '19.76'],
      [
        'family',
        'Premium Family',
        'month',
        '249.00',
        'SEK',
        `kr${NBSP}249`,
        '24.73',
      ],
    ],
  },
  'services/spotify/united-states': {
    market: 'US',
    verifiedAt: '2026-11-16',
    rows: [
      [
        'individual',
        'Premium Individual',
        'month',
        '12.99',
        'USD',
        '$12.99 + tax',
        '12.99',
      ],
      [
        'student',
        'Premium Student',
        'month',
        '6.99',
        'USD',
        '$6.99 + tax',
        '6.99',
      ],
      ['duo', 'Premium Duo', 'month', '18.99', 'USD', '$18.99 + tax', '18.99'],
      [
        'family',
        'Premium Family',
        'month',
        '21.99',
        'USD',
        '$21.99 + tax',
        '21.99',
      ],
    ],
  },
  'services/youtube-premium/sweden': {
    market: 'SE',
    verifiedAt: '2026-11-04',
    rows: [
      [
        'individual',
        'Individual',
        'month',
        '169.00',
        'SEK',
        `kr${NBSP}169`,
        '16.78',
      ],
      ['family', 'Family', 'month', '309.00', 'SEK', `kr${NBSP}309`, '30.68'],
      ['student', 'Student', 'month', '109.00', 'SEK', `kr${NBSP}109`, '10.82'],
      ['lite', 'Premium Lite', 'month', '99.00', 'SEK', `kr${NBSP}99`, '9.83'],
    ],
  },
  'services/youtube-premium/united-states': {
    market: 'US',
    verifiedAt: '2026-11-04',
    rows: [
      [
        'individual',
        'Individual',
        'month',
        '15.99',
        'USD',
        '$15.99 + tax',
        '15.99',
      ],
      ['family', 'Family', 'month', '26.99', 'USD', '$26.99 + tax', '26.99'],
      ['student', 'Student', 'month', '8.99', 'USD', '$8.99 + tax', '8.99'],
      ['lite', 'Premium Lite', 'month', '8.99', 'USD', '$8.99 + tax', '8.99'],
    ],
  },
};

function readPair(path: string, html: string, market: string) {
  return readCountryServicePage(html, { url: `${origin}/${path}`, market });
}

test('the twelve country × service pages parse to their hand-written plan tables', () => {
  assert.equal(
    readdirSync(fixtureDirectory).filter((name) =>
      /^services__.+__.+\.server\.html$/.test(name),
    ).length,
    Object.keys(countryServicePages).length,
  );
  for (const [path, expected] of Object.entries(countryServicePages)) {
    for (const copy of copies) {
      const page = readPair(
        path,
        fixtureHtml(path.replaceAll('/', '__'), copy),
        expected.market,
      );
      assert.equal(page.verifiedAt, expected.verifiedAt, `${path} (${copy})`);
      assert.deepEqual(
        page.rows.map((row): Row => [
          row.key,
          row.name,
          row.billingPeriod,
          row.priceLocal,
          row.currency,
          row.priceSourceText,
          row.priceUsd,
        ]),
        expected.rows,
        `${path} (${copy})`,
      );
    }
  }
});

/** The "numberOfItems" of a page's JSON-LD ItemList, read without the parser. */
function itemListCount(html: string): number {
  const match = /"@type":"ItemList".*?"numberOfItems":([0-9]+)/.exec(html);
  assert.ok(match, 'the page has an ItemList with numberOfItems');
  return Number.parseInt(match[1], 10);
}

test('all 38 country pages parse, in both copies, with the priced list the JSON-LD counts', () => {
  const pages = readdirSync(fixtureDirectory)
    .map((name) => /^countries__(.+)\.server\.html$/.exec(name)?.[1])
    .filter((slug): slug is string => slug !== undefined);
  assert.equal(pages.length, 38);
  for (const slug of pages) {
    const results = copies.map((copy) => {
      const html = fixtureHtml(`countries__${slug}`, copy);
      const page = readCountryPage(html, {
        url: `${origin}/countries/${slug}`,
        origin,
        countrySlug: slug,
      });
      assert.equal(page.priced.length, itemListCount(html), slug);
      assert.ok(page.priced.length > 0, slug);
      for (const entry of [...page.priced, ...page.unavailable]) {
        assert.equal(entry.path, `/services/${entry.service}/${slug}`, slug);
      }
      for (const entry of page.unavailable) {
        assert.ok(
          ['Not verified yet', 'Not available here'].includes(entry.label),
          `${slug}: ${entry.label}`,
        );
      }
      return page;
    });
    assert.deepEqual(results[0], results[1], `${slug}: both copies agree`);
  }
});

test('Sweden: the "No price shown" list, by hand, and "What you get" is not read', () => {
  const page = readCountryPage(fixtureHtml('countries__sweden'), {
    url: `${origin}/countries/sweden`,
    origin,
    countrySlug: 'sweden',
  });
  assert.deepEqual(
    page.unavailable.map((entry) => [entry.service, entry.name, entry.label]),
    [
      ['amazon-music', 'Amazon Music Unlimited', 'Not verified yet'],
      ['audible', 'Audible', 'Not verified yet'],
      ['iqiyi', 'iQIYI', 'Not verified yet'],
      ['prime-video', 'Prime Video', 'Not verified yet'],
      ['ubisoft-plus', 'Ubisoft+', 'Not verified yet'],
      ['zee5', 'ZEE5', 'Not verified yet'],
    ],
  );
  assert.equal(page.priced.length, 32);
  assert.deepEqual(page.priced.slice(0, 2), [
    {
      service: 'adobe',
      name: 'Adobe Creative Cloud',
      path: '/services/adobe/sweden',
    },
    {
      service: 'amazon-prime',
      name: 'Amazon Prime',
      path: '/services/amazon-prime/sweden',
    },
  ]);
  assert.equal(page.priced.at(-1)?.service, 'youtube-premium');
});

test('/countries lists 248 countries, and the 20 markets by their own names', () => {
  for (const copy of copies) {
    const countries = readCountriesIndex(fixtureHtml('countries', copy));
    assert.equal(countries.length, 248);
    const bySlug = new Map(countries.map((link) => [link.slug, link.name]));
    for (const [slug, name] of [
      ['united-kingdom', 'United Kingdom'],
      ['united-states', 'United States'],
      ['sweden', 'Sweden'],
      ['croatia', 'Croatia'],
      ['australia', 'Australia'],
      ['aland-islands', 'Åland Islands'],
    ]) {
      assert.equal(bySlug.get(slug), name, slug);
    }
  }
});

/** The 41 service slugs of /services, as listed in the findings. */
const sourceServices = [
  'adobe',
  'amazon-music',
  'amazon-prime',
  'apple-arcade',
  'apple-fitness-plus',
  'apple-music',
  'apple-one',
  'apple-tv-plus',
  'audible',
  'babbel',
  'bitdefender',
  'chatgpt',
  'claude',
  'coursera-plus',
  'dazn',
  'deezer',
  'disney-plus',
  'gemini',
  'google-one',
  'grok',
  'hbo-max',
  'icloud-plus',
  'iqiyi',
  'microsoft-365',
  'mubi',
  'netflix',
  'nintendo-switch-online',
  'nordvpn',
  'paramount-plus',
  'playstation-plus',
  'prime-video',
  'proton',
  'soundcloud',
  'spotify',
  'twitch-turbo',
  'ubisoft-plus',
  'viki',
  'viu',
  'xbox-game-pass',
  'youtube-premium',
  'zee5',
];

test('/services lists the 41 services of the findings, with their display names', () => {
  for (const copy of copies) {
    const services = readServicesIndex(fixtureHtml('services', copy));
    assert.deepEqual(services.map((link) => link.slug).sort(), sourceServices);
    const bySlug = new Map(services.map((link) => [link.slug, link.name]));
    assert.equal(bySlug.get('adobe'), 'Adobe Creative Cloud');
    assert.equal(bySlug.get('apple-tv-plus'), 'Apple TV');
    assert.equal(bySlug.get('gemini'), 'Google AI (Gemini)');
    assert.equal(bySlug.get('amazon-prime'), 'Amazon Prime');
    assert.equal(bySlug.get('prime-video'), 'Prime Video');
  }
});

const ourMarkets = new Set([
  'GB',
  'DE',
  'ES',
  'FR',
  'IT',
  'PL',
  'RO',
  'SE',
  'NO',
  'DK',
  'FI',
  'CH',
  'NL',
  'HR',
  'IE',
  'AT',
  'PT',
  'CA',
  'US',
  'AU',
]);

test('"Price moves": all 205 rows from the embedded data, exact', () => {
  for (const copy of copies) {
    const moves = readPriceMoves(fixtureHtml('price-moves', copy));
    assert.equal(moves.length, 205);
    assert.deepEqual(moves[0], {
      service: 'netflix',
      plan: 'basic',
      country: 'HR',
      period: 'm',
      currency: 'EUR',
      oldPrice: '5.99',
      newPrice: '6.99',
      date: '2026-11-04',
      afterDate: null,
      evidenceUrl: 'https://help.netflix.com/en/node/24926/hr',
      flag: false,
      oldUsd: '6.61',
      newUsd: '7.71',
    });
    assert.deepEqual(
      moves.find((move) => move.afterDate !== null),
      {
        service: 'apple-music',
        plan: 'family',
        country: 'AE',
        period: 'm',
        currency: 'AED',
        oldPrice: '33.99',
        newPrice: '39.99',
        date: '2026-08-10',
        afterDate: '2026-07-04',
        evidenceUrl:
          'https://web.archive.org/web/20260810032354/https://www.apple.com/ae/apple-music/',
        flag: false,
        oldUsd: null,
        newUsd: null,
      },
    );
    assert.deepEqual(moves.at(-1), {
      service: 'netflix',
      plan: 'standard',
      country: 'TR',
      period: 'm',
      currency: 'TRY',
      oldPrice: '176.99',
      newPrice: '229.99',
      date: '2024-11-26',
      afterDate: '2024-05-24',
      evidenceUrl:
        'https://web.archive.org/web/20241126205434/https://help.netflix.com/en/node/24926/tr',
      flag: false,
      oldUsd: null,
      newUsd: null,
    });
    const byService = new Map<string, number>();
    for (const move of moves) {
      byService.set(move.service, (byService.get(move.service) ?? 0) + 1);
    }
    assert.deepEqual(Object.fromEntries(byService), {
      netflix: 49,
      spotify: 9,
      'apple-music': 147,
    });
    assert.equal(
      moves.filter((move) => ourMarkets.has(move.country)).length,
      76,
    );
    const flagged = moves.filter((move) => move.flag);
    assert.equal(flagged.length, 9);
    // Three Apple Music and six Netflix rows, all in the United States.
    assert.deepEqual(
      flagged.map((move) => `${move.service} ${move.plan} ${move.country}`),
      [
        'apple-music family US',
        'apple-music individual US',
        'apple-music student US',
        'netflix premium US',
        'netflix standard US',
        'netflix standard-ads US',
        'netflix premium US',
        'netflix standard US',
        'netflix standard-ads US',
      ],
    );
    // "205 rises, no cuts", compared as exact money.
    for (const move of moves) {
      assert.equal(
        compare(
          fromDecimalString(move.newPrice, move.currency),
          fromDecimalString(move.oldPrice, move.currency),
        ),
        1,
      );
    }
  }
});

// ------------------------------------------------- planted, broken pages

function plant(html: string, from: string, to: string, after = ''): string {
  const start = after === '' ? 0 : html.indexOf(after);
  assert.ok(start >= 0, `the page contains ${after}`);
  const index = html.indexOf(from, start);
  assert.ok(index >= 0, `the page contains ${from}`);
  return html.slice(0, index) + to + html.slice(index + from.length);
}

function plantAll(html: string, from: string, to: string): string {
  assert.ok(html.includes(from), `the page contains ${from}`);
  return html.replaceAll(from, to);
}

const usNetflix = fixtureHtml('services__netflix__united-states');
const usNetflixUrl = `${origin}/services/netflix/united-states`;

function assertRefused(read: () => unknown, message: RegExp, what: string) {
  assert.throws(read, (error: unknown) => {
    assert.ok(error instanceof PageParseError, `${what}: ${String(error)}`);
    assert.match(error.message, message, what);
    return true;
  });
}

test('a country × service page whose structure changed is refused, never read as zero rows', () => {
  const read = (html: string, url = usNetflixUrl, market = 'US') =>
    readCountryServicePage(html, { url, market });
  // The planted cases start from a page that reads.
  assert.equal(read(usNetflix).rows.length, 3);

  const cases: [string, string, RegExp][] = [
    [
      'the plans section is gone from the page',
      plantAll(
        usNetflix,
        'aria-labelledby="plans"',
        'aria-labelledby="plan-list"',
      ),
      /expected one plans section, found 0/,
    ],
    [
      'the plans section is gone from the embedded data',
      plantAll(
        usNetflix,
        '\\"aria-labelledby\\":\\"plans\\"',
        '\\"aria-labelledby\\":\\"plan-list\\"',
      ),
      /expected one embedded plans section, found 0/,
    ],
    [
      'the price prop is renamed',
      plantAll(usNetflix, '\\"official\\"', '\\"listPrice\\"'),
      /expected one price in the plan row standard-month, found 0/,
    ],
    [
      'the displayed price disagrees with the embedded amount',
      plant(
        usNetflix,
        '$19.99<!-- --> + tax',
        '$18.99<!-- --> + tax',
        'aria-labelledby="plans"',
      ),
      /displayed price "\$18\.99 \+ tax" of standard-month is not 19\.99 USD/,
    ],
    [
      'a plan row loses its period',
      plantAll(usNetflix, '\\"standard-month\\"', '\\"standard\\"'),
      /names no period/,
    ],
    [
      'the USD figure is a float artefact',
      plantAll(usNetflix, '\\"usd\\":19.99,', '\\"usd\\":19.990000000000002,'),
      /the USD figure of standard-month/,
    ],
    [
      'the "last checked" date is gone',
      plantAll(
        usNetflix,
        '"dateModified":"2026-10-28"',
        '"modified":"2026-10-28"',
      ),
      /no "last checked" date/,
    ],
    [
      'the page lists a row the embedded data does not',
      plant(
        usNetflix,
        '<li data-name="premium">',
        '<li data-name="premium"></li><li data-name="extra">',
      ),
      /shows 4 plans, its embedded data 3/,
    ],
    [
      'the rows are in another order on the page',
      plant(usNetflix, 'data-name="standard"', 'data-name="premium-x"'),
      /plan row 1 is "premium-x" on the page and "standard" in its data/,
    ],
  ];
  for (const [what, html, message] of cases) {
    assertRefused(() => read(html), message, what);
  }
  assertRefused(
    () => read(usNetflix, `${origin}/services/netflix/sweden`),
    /is for "https:\/\/www\.youfundceo\.com\/services\/netflix\/united-states", not this page/,
    'a page served for another URL',
  );
  assertRefused(
    () => read(usNetflix, usNetflixUrl, 'SE'),
    /covers "US", not SE/,
    'a page for another country',
  );
});

test('a country page whose structure changed is refused', () => {
  const sweden = fixtureHtml('countries__sweden');
  const read = (html: string, countrySlug = 'sweden') =>
    readCountryPage(html, {
      url: `${origin}/countries/sweden`,
      origin,
      countrySlug,
    });
  assert.equal(read(sweden).priced.length, 32);
  assertRefused(
    () => read(plantAll(sweden, 'class="prow"', 'class="row"')),
    /the priced list \(0\) disagrees with the JSON-LD ItemList \(32\)/,
    'the list markup changed',
  );
  assertRefused(
    () =>
      read(
        plant(
          sweden,
          '"url":"https://www.youfundceo.com/services/adobe/sweden"',
          '"url":"https://www.youfundceo.com/services/adobe-x/sweden"',
        ),
      ),
    /disagrees with the JSON-LD ItemList/,
    'the JSON-LD names another service',
  );
  assertRefused(
    () => read(plantAll(sweden, '"@type":"ItemList"', '"@type":"List"')),
    /expected one JSON-LD ItemList, found 0/,
    'the JSON-LD ItemList is gone',
  );
  assertRefused(
    () => read(sweden, 'norway'),
    /not a service in norway/,
    'a page for another country',
  );
  assertRefused(
    () =>
      read(
        plant(
          sweden,
          'prow-sub">Not verified yet<',
          'prow-sub"><',
          'aria-labelledby="unavailable"',
        ),
      ),
    /has no label/,
    'a "No price shown" entry without its label',
  );
});

test('the indexes and "Price moves" refuse a changed structure', () => {
  assertRefused(
    () =>
      readCountriesIndex(
        plantAll(fixtureHtml('countries'), 'class="prow"', 'class="row"'),
      ),
    /no country links/,
    '/countries',
  );
  assertRefused(
    () =>
      readServicesIndex(
        plantAll(fixtureHtml('services'), 'href="/services/', 'href="/apps/'),
      ),
    /no service links/,
    '/services',
  );
  const moves = fixtureHtml('price-moves');
  assertRefused(
    () => readPriceMoves(plantAll(moves, '\\"rows\\":', '\\"items\\":')),
    /expected one embedded list of price moves, found 0/,
    'the rows prop is renamed',
  );
  assertRefused(
    () =>
      readPriceMoves(
        plant(
          moves,
          '\\"basic\\",\\"HR\\",\\"m\\",\\"EUR\\",5.99',
          '\\"basic\\",\\"HR\\",\\"m\\",\\"EUR\\",5.999',
        ),
      ),
    /the old price of price move 1/,
    'an amount with more decimals than its currency',
  );
  assertRefused(
    () =>
      readPriceMoves(
        plant(
          moves,
          '\\"HR\\",\\"m\\",\\"EUR\\",5.99,6.99,',
          '\\"HR\\",\\"m\\",\\"EUR\\",5.99,',
        ),
      ),
    /price move 1 is not a 13-field row/,
    'a row with a field missing',
  );
});
