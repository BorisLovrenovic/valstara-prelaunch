import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  billingPeriods,
  configIssues,
  normaliseAlias,
  serviceCategories,
  serviceStatuses,
  type ConfigFileKey,
} from '../../packages/price-index/src/schema/index.ts';

// E11.6-02: the schemas of config/markets.json, config/catalogue.json and
// config/valstara-prices.json, one accept and one reject case per field rule.

type Json = Record<string, unknown>;

function market(overrides: Json = {}): Json {
  return {
    code: 'SE',
    name: 'Sweden',
    slug: 'sweden',
    currency: 'SEK',
    enabled: true,
    ...overrides,
  };
}

function plan(overrides: Json = {}): Json {
  return {
    plan_id: 'individual',
    name: 'Individual',
    billing_period: 'month',
    is_student: false,
    is_family: false,
    ...overrides,
  };
}

function service(overrides: Json = {}): Json {
  return {
    service_id: 'spotify',
    name: 'Spotify Premium',
    category: 'music',
    website_url: 'https://www.spotify.com/',
    status: 'launch',
    plans: [plan()],
    source_aliases: {
      service: ['Spotify Premium', 'spotify'],
      plans: { individual: ['Premium Individual', 'individual'] },
    },
    ...overrides,
  };
}

function valstaraPrice(overrides: Json = {}): Json {
  return {
    service_id: 'spotify',
    plan_id: 'individual',
    market: 'SE',
    term_months: 12,
    price_local: '1199.00',
    currency: 'SEK',
    ...overrides,
  };
}

function config({
  markets = [
    market(),
    market({
      code: 'US',
      name: 'United States',
      slug: 'united-states',
      currency: 'USD',
    }),
  ],
  services = [service()],
  prices = [] as Json[],
}: {
  markets?: Json[];
  services?: Json[];
  prices?: Json[];
} = {}): Record<ConfigFileKey, unknown> {
  return {
    markets: { markets },
    catalogue: { services },
    valstaraPrices: { prices },
  };
}

function messages(input: Record<ConfigFileKey, unknown>): string[] {
  return configIssues(input).issues.map(
    (issue) => `${issue.file} ${issue.path}: ${issue.message}`,
  );
}

function assertValid(input: Record<ConfigFileKey, unknown>) {
  assert.deepEqual(messages(input), []);
}

function assertRejected(
  input: Record<ConfigFileKey, unknown>,
  expected: RegExp,
) {
  const found = messages(input);
  assert.ok(
    found.some((message) => expected.test(message)),
    `expected an issue matching ${expected}, got:\n${found.join('\n') || '(none)'}`,
  );
}

test('the committed configuration files pass every rule', async () => {
  const read = async (path: string) =>
    JSON.parse(
      await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'),
    );
  const result = configIssues({
    markets: await read('config/markets.json'),
    catalogue: await read('config/catalogue.json'),
    valstaraPrices: await read('config/valstara-prices.json'),
  });
  assert.deepEqual(result.issues, []);
});

test('a minimal configuration is accepted', () => {
  assertValid(config());
});

test('duplicate identities are rejected', () => {
  assertRejected(
    config({ services: [service(), service({ name: 'Spotify again' })] }),
    /config\/catalogue\.json services: duplicate service_id spotify/,
  );
  assertRejected(
    config({
      services: [service({ plans: [plan(), plan({ name: 'Again' })] })],
    }),
    /duplicate plan_id individual in service spotify/,
  );
  assertRejected(
    config({ markets: [market(), market({ slug: 'sweden-again' })] }),
    /config\/markets\.json markets: duplicate market code SE/,
  );
  assertRejected(
    config({ markets: [market(), market({ code: 'NO', currency: 'NOK' })] }),
    /duplicate market slug sweden/,
  );
});

test('the same plan_id in two different services is accepted', () => {
  assertValid(
    config({
      services: [
        service(),
        service({
          service_id: 'apple-music',
          name: 'Apple Music',
          source_aliases: {
            service: ['Apple Music'],
            plans: { individual: ['Individual'] },
          },
        }),
      ],
    }),
  );
});

test('categories, statuses and billing periods are closed sets', () => {
  for (const category of serviceCategories) {
    assertValid(config({ services: [service({ category })] }));
  }
  for (const status of serviceStatuses) {
    assertValid(config({ services: [service({ status })] }));
  }
  for (const billing_period of billingPeriods) {
    assertValid(
      config({ services: [service({ plans: [plan({ billing_period })] })] }),
    );
  }

  assertRejected(
    config({ services: [service({ category: 'gaming' })] }),
    /services\.0\.category: /,
  );
  assertRejected(
    config({ services: [service({ status: 'sold_out' })] }),
    /services\.0\.status: /,
  );
  assertRejected(
    config({
      services: [service({ plans: [plan({ billing_period: 'week' })] })],
    }),
    /services\.0\.plans\.0\.billing_period: /,
  );
});

test('a currency must be in the ISO 4217 table', () => {
  for (const currency of [
    'GBP',
    'EUR',
    'PLN',
    'RON',
    'SEK',
    'NOK',
    'DKK',
    'CHF',
    'CAD',
    'USD',
    'AUD',
  ]) {
    assertValid(config({ markets: [market({ currency })] }));
  }
  for (const currency of ['XYZ', 'sek', 'HRK', 'XXX', 'SE', '']) {
    assertRejected(
      config({ markets: [market({ currency })] }),
      /markets\.0\.currency: is not a currency in the ISO 4217 table/,
    );
  }
  assertRejected(
    config({ prices: [valstaraPrice({ currency: 'XYZ' })] }),
    /config\/valstara-prices\.json prices\.0\.currency: is not a currency in the ISO 4217 table/,
  );
});

test('slugs must be lower-case kebab-case', () => {
  assertValid(
    config({
      services: [
        service({
          service_id: 'n8n',
          plans: [plan({ plan_id: 'mega-fan' })],
          source_aliases: { service: [], plans: {} },
        }),
      ],
      markets: [market({ slug: 'bosnia-and-herzegovina' })],
    }),
  );

  for (const slug of [
    'Spotify',
    'spotify_premium',
    'spotify-',
    '-spotify',
    'spotify--premium',
    'spotify premium',
    'spötify',
    '',
  ]) {
    assertRejected(
      config({ services: [service({ service_id: slug })] }),
      /services\.0\.service_id: must be lower-case kebab-case/,
    );
    assertRejected(
      config({
        services: [
          service({
            plans: [plan({ plan_id: slug })],
            source_aliases: { service: [], plans: {} },
          }),
        ],
      }),
      /services\.0\.plans\.0\.plan_id: must be lower-case kebab-case/,
    );
    assertRejected(
      config({ markets: [market({ slug })] }),
      /markets\.0\.slug: must be lower-case kebab-case/,
    );
  }
});

test('a service id reserved by the market hub route is rejected', () => {
  assertRejected(
    config({ services: [service({ service_id: 'countries' })] }),
    /service_id: is reserved by a price route/,
  );
});

test('an alias that maps to two different plans is rejected', () => {
  const netflix = (plans: Record<string, string[]>) =>
    service({
      service_id: 'netflix',
      name: 'Netflix',
      category: 'streaming',
      plans: [
        plan({ plan_id: 'basic', name: 'Basic' }),
        plan({ plan_id: 'standard', name: 'Standard' }),
      ],
      source_aliases: { service: ['Netflix'], plans },
    });

  assertValid(
    config({
      services: [
        netflix({ basic: ['Basic', 'basic'], standard: ['Standard'] }),
      ],
    }),
  );
  assertRejected(
    config({
      services: [
        netflix({ basic: ['Basic'], standard: ['Standard', 'Basic'] }),
      ],
    }),
    /alias "Basic" maps to two plans, basic and standard, in service netflix/,
  );
  // The collision is found after the matcher's normalisation, so a variant
  // spelling cannot slip one alias onto two plans.
  assertRejected(
    config({
      services: [
        netflix({
          basic: ['Standard with ads'],
          standard: ['standard-with-ads.'],
        }),
      ],
    }),
    /alias "standard-with-ads\." maps to two plans, basic and standard/,
  );
});

test('an alias that maps to two different services is rejected', () => {
  assertRejected(
    config({
      services: [
        service(),
        service({
          service_id: 'spotify-family',
          name: 'Spotify Family',
          source_aliases: { service: ['SPOTIFY'], plans: {} },
        }),
      ],
    }),
    /alias "SPOTIFY" maps to two services, spotify and spotify-family/,
  );
});

test('a plan alias may repeat across services, where matching is per service', () => {
  assertValid(
    config({
      services: [
        service(),
        service({
          service_id: 'youtube-premium',
          name: 'YouTube Premium',
          category: 'streaming',
          source_aliases: {
            service: ['YouTube Premium'],
            plans: { individual: ['individual'] },
          },
        }),
      ],
    }),
  );
});

test('aliases for an unknown plan, and empty aliases, are rejected', () => {
  assertRejected(
    config({
      services: [
        service({
          source_aliases: { service: [], plans: { family: ['Family'] } },
        }),
      ],
    }),
    /alias entry for unknown plan family in service spotify/,
  );
  assertRejected(
    config({
      services: [
        service({ source_aliases: { service: ['  --  '], plans: {} } }),
      ],
    }),
    /source_aliases\.service\.0: must contain a letter or a digit/,
  );
});

test('a plan with no alias entry is accepted, and stays unmatched', () => {
  assertValid(
    config({
      services: [
        service({
          service_id: 'adobe-creative-cloud',
          name: 'Adobe Creative Cloud',
          category: 'productivity',
          source_aliases: { service: [], plans: {} },
        }),
      ],
    }),
  );
});

test('a Valstara price must name a known service, plan and market, in its currency', () => {
  assertValid(
    config({
      prices: [
        valstaraPrice(),
        valstaraPrice({ term_months: 1, price_local: '99' }),
      ],
    }),
  );

  assertRejected(
    config({ prices: [valstaraPrice({ service_id: 'tidal' })] }),
    /valstara-prices\.json prices\.0: Valstara price for unknown service tidal/,
  );
  assertRejected(
    config({ prices: [valstaraPrice({ plan_id: 'family' })] }),
    /Valstara price for unknown plan family of service spotify/,
  );
  assertRejected(
    config({ prices: [valstaraPrice({ market: 'NO' })] }),
    /Valstara price for unknown market NO/,
  );
  assertRejected(
    config({ prices: [valstaraPrice({ currency: 'EUR' })] }),
    /Valstara price in EUR, but market SE uses SEK/,
  );
  assertRejected(
    config({
      prices: [valstaraPrice(), valstaraPrice({ price_local: '1099.00' })],
    }),
    /duplicate Valstara price for spotify\/individual\/SE\/12 months/,
  );
});

test('a Valstara price is a positive exact decimal string over a whole term', () => {
  for (const price_local of [
    '0',
    '0.00',
    '-1.00',
    '1,99',
    '1.',
    '.99',
    '01.99',
    '1e3',
    ' 9.99',
  ]) {
    assertRejected(
      config({ prices: [valstaraPrice({ price_local })] }),
      /prices\.0\.price_local: /,
    );
  }
  assertRejected(
    config({ prices: [valstaraPrice({ price_local: 9.99 })] }),
    /prices\.0\.price_local: /,
  );
  for (const term_months of [0, 1.5, '12']) {
    assertRejected(
      config({ prices: [valstaraPrice({ term_months })] }),
      /prices\.0\.term_months: /,
    );
  }
});

test('other field rules: codes, names, flags, URLs, plans and unknown keys', () => {
  for (const code of ['se', 'SWE', 'S', '']) {
    assertRejected(
      config({ markets: [market({ code })] }),
      /markets\.0\.code: must be an ISO 3166-1 alpha-2 code/,
    );
  }
  assertRejected(
    config({ markets: [market({ enabled: 'yes' })] }),
    /markets\.0\.enabled: /,
  );
  assertRejected(
    config({ markets: [market({ name: ' Sweden' })] }),
    /markets\.0\.name: must be non-empty/,
  );
  assertRejected(
    config({ services: [service({ name: '' })] }),
    /services\.0\.name: must be non-empty/,
  );
  assertRejected(
    config({ services: [service({ website_url: 'http://www.spotify.com/' })] }),
    /services\.0\.website_url: must be an https URL/,
  );
  assertRejected(
    config({ services: [service({ website_url: 'spotify.com' })] }),
    /services\.0\.website_url: must be an https URL/,
  );
  assertRejected(
    config({ services: [service({ plans: [] })] }),
    /services\.0\.plans: /,
  );
  assertRejected(
    config({ services: [service({ plans: [plan({ is_student: 'no' })] })] }),
    /plans\.0\.is_student: /,
  );
  assertRejected(
    config({ services: [service({ plans: [plan({ is_family: 1 })] })] }),
    /plans\.0\.is_family: /,
  );
  assertRejected(config({ markets: [market({ fx: 'ECB' })] }), /markets\.0: /);
  assertRejected(
    config({ services: [service({ price_usd: '1.00' })] }),
    /services\.0: /,
  );
  assertRejected(
    config({ services: [service({ source_aliases: ['Spotify'] })] }),
    /services\.0\.source_aliases: /,
  );
});

test('the alias normalisation folds case, whitespace, punctuation and diacritics', () => {
  assert.equal(normaliseAlias('Apple TV'), 'apple tv');
  assert.equal(normaliseAlias('apple-tv-plus'), 'apple tv plus');
  assert.equal(normaliseAlias('  ÀPPLE  TV. '), 'apple tv');
  assert.equal(normaliseAlias('Crème Brûlée+'), 'creme brulee');
  assert.equal(normaliseAlias('n8n'), 'n8n');
  assert.equal(normaliseAlias('—'), '');
});
