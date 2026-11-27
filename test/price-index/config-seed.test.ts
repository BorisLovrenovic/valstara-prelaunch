import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  catalogueFileSchema,
  marketsFileSchema,
  valstaraPricesFileSchema,
} from '../../packages/price-index/src/schema/index.ts';

// E11.6-02: the seeded configuration is exactly what the founder decided.
// docs/features/price-index.md#markets-configmarketsjson and
// #catalogue-configcataloguejson, and the name mappings confirmed in
// docs/features/price-index-source-findings.md (D-019 Q4, option B).

async function read(path: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'),
  );
}

test('config/markets.json holds the 20 markets, all enabled, each in its currency', async () => {
  const { markets } = marketsFileSchema.parse(
    await read('config/markets.json'),
  );
  assert.deepEqual(
    markets.map((market) => [
      market.code,
      market.name,
      market.slug,
      market.currency,
      market.enabled,
    ]),
    [
      ['GB', 'United Kingdom', 'united-kingdom', 'GBP', true],
      ['DE', 'Germany', 'germany', 'EUR', true],
      ['ES', 'Spain', 'spain', 'EUR', true],
      ['FR', 'France', 'france', 'EUR', true],
      ['IT', 'Italy', 'italy', 'EUR', true],
      ['PL', 'Poland', 'poland', 'PLN', true],
      ['RO', 'Romania', 'romania', 'RON', true],
      ['SE', 'Sweden', 'sweden', 'SEK', true],
      ['NO', 'Norway', 'norway', 'NOK', true],
      ['DK', 'Denmark', 'denmark', 'DKK', true],
      ['FI', 'Finland', 'finland', 'EUR', true],
      ['CH', 'Switzerland', 'switzerland', 'CHF', true],
      ['NL', 'Netherlands', 'netherlands', 'EUR', true],
      ['HR', 'Croatia', 'croatia', 'EUR', true],
      ['IE', 'Ireland', 'ireland', 'EUR', true],
      ['AT', 'Austria', 'austria', 'EUR', true],
      ['PT', 'Portugal', 'portugal', 'EUR', true],
      ['CA', 'Canada', 'canada', 'CAD', true],
      ['US', 'United States', 'united-states', 'USD', true],
      ['AU', 'Australia', 'australia', 'AUD', true],
    ],
  );
});

test('the markets whose names need an article in a sentence carry it (E11.6-10)', async () => {
  const { markets } = marketsFileSchema.parse(
    await read('config/markets.json'),
  );
  assert.deepEqual(
    markets
      .filter((market) => market.name_in_sentence !== undefined)
      .map((market) => [market.code, market.name_in_sentence]),
    [
      ['GB', 'the United Kingdom'],
      ['NL', 'the Netherlands'],
      ['US', 'the United States'],
    ],
  );
});

test('config/catalogue.json tracks exactly the founder’s products and monthly plans', async () => {
  const { services } = catalogueFileSchema.parse(
    await read('config/catalogue.json'),
  );
  assert.deepEqual(
    services.map((service) => [
      service.name,
      service.plans.map((plan) => plan.name),
    ]),
    [
      ['Adobe Creative Cloud', ['Individual']],
      ['Amazon Prime / Prime Video', ['Prime']],
      ['Apple TV', ['Individual']],
      ['Apple Music', ['Individual']],
      ['Bolt.new', ['Pro']],
      ['Canva', ['Pro']],
      ['ChatGPT', ['Plus']],
      ['Crunchyroll', ['Mega Fan']],
      ['Duolingo', ['Super', 'Max']],
      ['Figma', ['Professional']],
      ['LinkedIn Premium', ['Career', 'Business']],
      ['Lovable', ['Pro']],
      ['MyFitnessPal', ['Premium']],
      ['n8n', ['Starter']],
      ['Netflix', ['Basic', 'Standard', 'Premium (4K)']],
      ['Notion', ['Plus']],
      ['Perplexity', ['Pro']],
      ['Spotify Premium', ['Individual']],
      ['YouTube Premium', ['Individual']],
    ],
  );

  for (const service of services) {
    assert.equal(
      service.status,
      service.service_id === 'perplexity' ? 'planned' : 'launch',
      service.service_id,
    );
    for (const plan of service.plans) {
      // No student plans and no family plans (founder, 2026-11-17), each at
      // the monthly price the source shows.
      assert.equal(
        plan.is_student,
        false,
        `${service.service_id}/${plan.plan_id}`,
      );
      assert.equal(
        plan.is_family,
        false,
        `${service.service_id}/${plan.plan_id}`,
      );
      assert.equal(
        plan.billing_period,
        'month',
        `${service.service_id}/${plan.plan_id}`,
      );
    }
  }
});

test('official_hosts is exactly the founder’s seed (D-031 Q1)', async () => {
  const { services } = catalogueFileSchema.parse(
    await read('config/catalogue.json'),
  );
  assert.deepEqual(
    Object.fromEntries(
      services
        .filter((service) => service.official_hosts !== undefined)
        .map((service) => [service.service_id, service.official_hosts]),
    ),
    {
      'amazon-prime': [
        'www.amazon.co.uk',
        'www.amazon.de',
        'www.amazon.es',
        'www.amazon.fr',
        'www.amazon.it',
        'www.amazon.pl',
        'www.amazon.se',
        'www.amazon.nl',
        'www.amazon.ca',
        'www.amazon.com.au',
      ],
      'apple-tv': ['www.apple.com'],
      chatgpt: ['openai.com'],
      'linkedin-premium': ['www.linkedin.com'],
      netflix: ['help.netflix.com'],
    },
  );
});

test('source_aliases come only from the confirmed and founder-confirmed mappings', async () => {
  const { services } = catalogueFileSchema.parse(
    await read('config/catalogue.json'),
  );
  const aliases = Object.fromEntries(
    services.map((service) => [service.service_id, service.source_aliases]),
  );
  const none = { service: [], plans: {} };

  assert.deepEqual(aliases, {
    // Unmapped by founder decision: Creative Cloud Pro carries Adobe's
    // annual-commitment price, so the plan stays `missing`.
    'adobe-creative-cloud': none,
    // Amazon Prime "Prime" only; Prime Video (`prime-video`) is not an alias.
    'amazon-prime': {
      service: ['Amazon Prime', 'amazon-prime'],
      plans: { prime: ['Prime'] },
    },
    'apple-tv': {
      service: ['Apple TV', 'apple-tv-plus'],
      plans: { individual: ['Apple TV'] },
    },
    'apple-music': {
      service: ['Apple Music', 'apple-music'],
      plans: { individual: ['Individual', 'individual'] },
    },
    chatgpt: {
      service: ['ChatGPT', 'chatgpt'],
      plans: { plus: ['ChatGPT Plus', 'plus'] },
    },
    // Netflix Basic is "Basic" only; "Standard with ads" is never an alias.
    netflix: {
      service: ['Netflix', 'netflix'],
      plans: {
        basic: ['Basic', 'basic'],
        standard: ['Standard', 'standard'],
        premium: ['Premium', 'premium'],
      },
    },
    spotify: {
      service: ['Spotify Premium', 'spotify'],
      plans: { individual: ['Premium Individual', 'individual'] },
    },
    'youtube-premium': {
      service: ['YouTube Premium', 'youtube-premium'],
      plans: { individual: ['Individual', 'individual'] },
    },
    // Not on the source: `missing` / `not_on_source` in every market.
    'bolt-new': none,
    canva: none,
    crunchyroll: none,
    duolingo: none,
    figma: none,
    'linkedin-premium': none,
    lovable: none,
    myfitnesspal: none,
    n8n: none,
    notion: none,
    perplexity: none,
  });

  const netflixAliases = Object.values(aliases.netflix.plans).flat();
  assert.ok(
    !netflixAliases.some((alias) => /standard.?(with.?)?ads/i.test(alias)),
  );
  assert.ok(
    !aliases['amazon-prime'].service.some((alias) =>
      /prime.?video/i.test(alias),
    ),
  );
});

test('config/valstara-prices.json is seeded empty', async () => {
  assert.deepEqual(
    valstaraPricesFileSchema.parse(await read('config/valstara-prices.json')),
    { prices: [] },
  );
});
