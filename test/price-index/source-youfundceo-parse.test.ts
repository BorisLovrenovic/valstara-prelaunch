import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import type { CatalogueFile } from '../../packages/price-index/src/schema/catalogue.ts';
import { priceRecordSchema } from '../../packages/price-index/src/schema/price-record.ts';
import {
  SourceInputError,
  youfundceoAdapter,
  type Observation,
  type RawPage,
  type SourceContext,
  type SourceParseResult,
} from '../../packages/price-index/src/sources/index.ts';
import {
  capturedPages,
  capturedServicePairs,
  committedCatalogue,
  contextWithMarkets,
  deepFrozen,
  fixtureHtml,
  indexPaths,
  observedAt,
  okPage,
  origin,
} from '../helpers/price-index-sources.ts';

// E11.6-05: the youfundceo adapter reads a run's pages into observations,
// the gaps the source declares, untracked entries and failures. Every
// expectation is written by hand from the captured pages and the findings
// (docs/features/price-index-source-findings.md), never from the parser.

const NBSP = ' ';
const adapter = youfundceoAdapter;
const source = 'scraper:youfundceo.com';

function observation(
  market: 'SE' | 'US',
  service: string,
  plan: string,
  price: string,
  text: string,
  usd: string,
  path: string,
  verified: string,
): Observation {
  return {
    market,
    service_id: service,
    plan_id: plan,
    billing_period: 'month',
    price_local: price,
    price_source_text: text,
    currency: market === 'SE' ? 'SEK' : 'USD',
    price_usd_source: usd,
    source,
    source_url: `${origin}/services/${path}`,
    observed_at: observedAt,
    source_verified_at: verified,
  };
}

/** The 13 tracked plans priced on the 12 captured pages, by hand. */
const capturedObservations: Observation[] = [
  observation(
    'SE',
    'apple-music',
    'individual',
    '119.00',
    `kr${NBSP}119`,
    '11.82',
    'apple-music/sweden',
    '2026-10-30',
  ),
  observation(
    'US',
    'apple-music',
    'individual',
    '11.99',
    '$11.99 + tax',
    '11.99',
    'apple-music/united-states',
    '2026-11-16',
  ),
  observation(
    'SE',
    'chatgpt',
    'plus',
    '249.00',
    `kr${NBSP}249`,
    '24.73',
    'chatgpt/sweden',
    '2026-10-28',
  ),
  observation(
    'US',
    'chatgpt',
    'plus',
    '20.00',
    '$20 + tax',
    '20.00',
    'chatgpt/united-states',
    '2026-11-16',
  ),
  observation(
    'SE',
    'netflix',
    'basic',
    '129.00',
    `kr${NBSP}129`,
    '12.81',
    'netflix/sweden',
    '2026-11-04',
  ),
  observation(
    'SE',
    'netflix',
    'premium',
    '219.00',
    `kr${NBSP}219`,
    '21.75',
    'netflix/sweden',
    '2026-11-04',
  ),
  observation(
    'US',
    'netflix',
    'premium',
    '26.99',
    '$26.99 + tax',
    '26.99',
    'netflix/united-states',
    '2026-10-28',
  ),
  observation(
    'SE',
    'netflix',
    'standard',
    '169.00',
    `kr${NBSP}169`,
    '16.78',
    'netflix/sweden',
    '2026-11-04',
  ),
  observation(
    'US',
    'netflix',
    'standard',
    '19.99',
    '$19.99 + tax',
    '19.99',
    'netflix/united-states',
    '2026-10-28',
  ),
  observation(
    'SE',
    'spotify',
    'individual',
    '149.00',
    `kr${NBSP}149`,
    '14.80',
    'spotify/sweden',
    '2026-11-04',
  ),
  observation(
    'US',
    'spotify',
    'individual',
    '12.99',
    '$12.99 + tax',
    '12.99',
    'spotify/united-states',
    '2026-11-16',
  ),
  observation(
    'SE',
    'youtube-premium',
    'individual',
    '169.00',
    `kr${NBSP}169`,
    '16.78',
    'youtube-premium/sweden',
    '2026-11-04',
  ),
  observation(
    'US',
    'youtube-premium',
    'individual',
    '15.99',
    '$15.99 + tax',
    '15.99',
    'youtube-premium/united-states',
    '2026-11-04',
  ),
];

/** The tracked products the source does not list, with their plans (the findings' list). */
const notOnSource: [string, string[]][] = [
  ['bolt-new', ['pro']],
  ['canva', ['pro']],
  ['crunchyroll', ['mega-fan']],
  ['duolingo', ['max', 'super']],
  ['figma', ['professional']],
  ['linkedin-premium', ['business', 'career']],
  ['lovable', ['pro']],
  ['myfitnesspal', ['premium']],
  ['n8n', ['starter']],
  ['notion', ['plus']],
  ['perplexity', ['pro']],
];

const swedenAndUs = [
  ...indexPaths,
  '/countries/sweden',
  '/countries/united-states',
  ...capturedServicePairs,
];

function parse(
  context: SourceContext,
  pages: Map<string, RawPage>,
): SourceParseResult {
  return adapter.parse({ observedAt, pages }, context);
}

function gapKey(gap: SourceParseResult['gaps'][number]): string {
  return [
    gap.market,
    gap.service_id,
    gap.plan_id,
    gap.reason,
    gap.source_url ?? '-',
    gap.note ?? '-',
  ].join(' ');
}

function assertCoversEveryPlan(
  result: SourceParseResult,
  context: SourceContext,
) {
  const seen = new Map<string, number>();
  for (const entry of [...result.observations, ...result.gaps]) {
    const key = [
      entry.market,
      entry.service_id,
      entry.plan_id,
      entry.billing_period,
    ].join('/');
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const expected = context.markets.markets
    .filter((market) => market.enabled)
    .flatMap((market) =>
      context.catalogue.services.flatMap((service) =>
        service.plans.map((plan) =>
          [
            market.code,
            service.service_id,
            plan.plan_id,
            plan.billing_period,
          ].join('/'),
        ),
      ),
    );
  assert.deepEqual([...seen.keys()].sort(), [...expected].sort());
  assert.ok(
    [...seen.values()].every((count) => count === 1),
    'each plan exactly once',
  );
}

test('Sweden and the United States: the captured pages parse to the hand-written observations', () => {
  const context = contextWithMarkets(['SE', 'US']);
  const result = parse(context, capturedPages(swedenAndUs));
  assert.equal(result.source, source);
  assert.deepEqual(result.observations, capturedObservations);
  assertCoversEveryPlan(result, context);

  const gaps = new Set(result.gaps.map(gapKey));
  const expected = new Set<string>();
  for (const market of ['SE', 'US']) {
    const country = market === 'SE' ? 'sweden' : 'united-states';
    expected.add(
      `${market} adobe-creative-cloud individual not_on_source ${origin}/services -`,
    );
    for (const [service, plans] of notOnSource) {
      for (const plan of plans) {
        expected.add(
          `${market} ${service} ${plan} not_on_source ${origin}/services -`,
        );
      }
    }
    // Their country × service pages are not in the capture.
    expected.add(
      `${market} amazon-prime prime market_failed ${origin}/services/amazon-prime/${country} the page was not fetched`,
    );
    expected.add(
      `${market} apple-tv individual market_failed ${origin}/services/apple-tv-plus/${country} the page was not fetched`,
    );
  }
  // The United States lists no Basic, so it stays missing until the founder decides.
  expected.add(
    `US netflix basic not_on_source ${origin}/services/netflix/united-states -`,
  );
  assert.deepEqual([...gaps].sort(), [...expected].sort());
  assert.equal(result.gaps.length, expected.size);

  assert.deepEqual(
    result.failures.map((failure) => [
      failure.url.slice(origin.length),
      failure.market,
      failure.reason,
    ]),
    [
      ['/services/amazon-prime/sweden', 'SE', 'market_failed'],
      ['/services/amazon-prime/united-states', 'US', 'market_failed'],
      ['/services/apple-tv-plus/sweden', 'SE', 'market_failed'],
      ['/services/apple-tv-plus/united-states', 'US', 'market_failed'],
    ],
  );
});

test('observations and gaps are records E11.6-06 can build: each passes the record schema', () => {
  const result = parse(
    contextWithMarkets(['SE', 'US']),
    capturedPages(swedenAndUs),
  );
  for (const entry of result.observations) {
    priceRecordSchema.parse({
      ...entry,
      status: 'ok',
      missing_reason: null,
      notes: null,
    });
  }
  for (const gap of result.gaps) {
    priceRecordSchema.parse({
      market: gap.market,
      service_id: gap.service_id,
      plan_id: gap.plan_id,
      billing_period: gap.billing_period,
      price_local: null,
      price_source_text: null,
      currency: null,
      price_usd_source: null,
      source,
      source_url: gap.source_url,
      observed_at: observedAt,
      source_verified_at: null,
      status: 'missing',
      missing_reason: gap.reason,
      notes: gap.note,
    });
  }
});

test('the server copies parse to exactly the same result as the rendered pages', () => {
  const context = contextWithMarkets(['SE', 'US']);
  assert.deepEqual(
    parse(context, capturedPages(swedenAndUs, 'server')),
    parse(context, capturedPages(swedenAndUs)),
  );
});

test('untracked on source: every unmatched service and plan, each with a suggestion that is only a suggestion', () => {
  const result = parse(
    contextWithMarkets(['SE', 'US']),
    capturedPages(swedenAndUs),
  );
  const services = result.untracked.filter((entry) => entry.kind === 'service');
  const matched = [
    'amazon-prime',
    'apple-music',
    'apple-tv-plus',
    'chatgpt',
    'netflix',
    'spotify',
    'youtube-premium',
  ];
  assert.equal(services.length, 41 - matched.length);
  assert.ok(services.every((entry) => !matched.includes(entry.source_service)));
  const suggestions = Object.fromEntries(
    services
      .filter((entry) => entry.suggestion)
      .map((entry) => [entry.source_service, entry.suggestion]),
  );
  assert.deepEqual(suggestions.adobe, { service_id: 'adobe-creative-cloud' });
  assert.deepEqual(suggestions['prime-video'], { service_id: 'amazon-prime' });

  const plans = result.untracked
    .filter((entry) => entry.kind === 'plan')
    .map((entry) => [
      entry.service_id,
      entry.source_plan,
      entry.source_name,
      entry.markets.join(','),
    ]);
  assert.deepEqual(plans, [
    ['apple-music', 'family', 'Family', 'SE,US'],
    ['apple-music', 'student', 'Student', 'SE,US'],
    ['chatgpt', 'go', 'ChatGPT Go', 'SE,US'],
    ['chatgpt', 'pro-100', 'ChatGPT Pro 100', 'SE,US'],
    ['chatgpt', 'pro-200', 'ChatGPT Pro 200', 'SE,US'],
    ['chatgpt', 'pro-500', 'ChatGPT Pro 500', 'SE,US'],
    ['netflix', 'standard-ads', 'Standard with ads', 'US'],
    ['spotify', 'duo', 'Premium Duo', 'SE,US'],
    ['spotify', 'family', 'Premium Family', 'SE,US'],
    ['spotify', 'student', 'Premium Student', 'SE,US'],
    ['youtube-premium', 'family', 'Family', 'SE,US'],
    ['youtube-premium', 'lite', 'Premium Lite', 'SE,US'],
    ['youtube-premium', 'student', 'Student', 'SE,US'],
  ]);
});

/**
 * Per market, by hand from the findings' table: the tracked services the
 * source lists under "No price shown", and those it does not list at all.
 */
const noPrice: Record<string, string[]> = {
  AU: ['youtube-premium'],
  RO: ['apple-music', 'youtube-premium'],
  HR: ['apple-music'],
};
const notListed: Record<string, string[]> = {
  NO: ['amazon-prime'],
  DK: ['amazon-prime'],
  FI: ['amazon-prime'],
  CH: ['amazon-prime'],
  PT: ['amazon-prime'],
  RO: ['amazon-prime'],
  HR: ['amazon-prime'],
};
const marketSlugs: Record<string, string> = {
  GB: 'united-kingdom',
  DE: 'germany',
  ES: 'spain',
  FR: 'france',
  IT: 'italy',
  PL: 'poland',
  RO: 'romania',
  SE: 'sweden',
  NO: 'norway',
  DK: 'denmark',
  FI: 'finland',
  CH: 'switzerland',
  NL: 'netherlands',
  HR: 'croatia',
  IE: 'ireland',
  AT: 'austria',
  PT: 'portugal',
  CA: 'canada',
  US: 'united-states',
  AU: 'australia',
};

test('not_on_source in every enabled market for a product the source lacks; source_no_price for "No price shown"', () => {
  const context = contextWithMarkets('all');
  const pages = capturedPages([
    ...indexPaths,
    ...Object.values(marketSlugs).map((slug) => `/countries/${slug}`),
  ]);
  const result = parse(context, pages);
  assertCoversEveryPlan(result, context);
  const reasons = new Map(
    result.gaps.map((gap) => [
      `${gap.market} ${gap.service_id} ${gap.plan_id}`,
      gap,
    ]),
  );
  for (const [code, slug] of Object.entries(marketSlugs)) {
    for (const [service, plans] of [
      ...notOnSource,
      ['adobe-creative-cloud', ['individual']] as const,
    ]) {
      for (const plan of plans) {
        const gap = reasons.get(`${code} ${service} ${plan}`);
        assert.equal(
          gap?.reason,
          'not_on_source',
          `${code} ${service} ${plan}`,
        );
        assert.equal(gap?.source_url, `${origin}/services`);
      }
    }
    for (const service of noPrice[code] ?? []) {
      const gap = reasons.get(`${code} ${service} individual`);
      assert.equal(gap?.reason, 'source_no_price', `${code} ${service}`);
      assert.equal(gap?.note, 'Not verified yet');
      assert.equal(gap?.source_url, `${origin}/countries/${slug}`);
    }
    for (const service of notListed[code] ?? []) {
      const gap = reasons.get(`${code} ${service} prime`);
      assert.equal(gap?.reason, 'not_on_source', `${code} ${service}`);
      assert.equal(gap?.source_url, `${origin}/countries/${slug}`);
    }
  }
  // Every other tracked plan is priced on the source, and its page was not
  // fetched here, so it is a failed page, never a quiet "no price".
  const expected = {
    not_on_source: 20 * 14 + 7,
    source_no_price: 4,
    market_failed: 129 + 20 * 2,
  };
  const counted: Record<string, number> = {};
  for (const gap of result.gaps) {
    counted[gap.reason] = (counted[gap.reason] ?? 0) + 1;
  }
  assert.deepEqual(counted, expected);
  assert.deepEqual(result.observations, []);
});

test('"Not available here" is still source_no_price, with the label kept, and never not_offered', () => {
  const context = contextWithMarkets(['HR']);
  const croatia = fixtureHtml('countries__croatia');
  const marker = 'href="/services/apple-music/croatia"';
  const start = croatia.indexOf(marker);
  assert.ok(start > 0);
  const label = croatia.indexOf('prow-sub">Not verified yet<', start);
  const planted =
    croatia.slice(0, label) +
    'prow-sub">Not available here<' +
    croatia.slice(label + 'prow-sub">Not verified yet<'.length);
  const pages = capturedPages(indexPaths);
  pages.set(...okPage('/countries/croatia', planted));
  const gap = parse(context, pages).gaps.find(
    (entry) => entry.service_id === 'apple-music',
  );
  assert.equal(gap?.reason, 'source_no_price');
  assert.equal(gap?.note, 'Not available here');
});

function withPage(path: string, html: string): Map<string, RawPage> {
  const pages = capturedPages(swedenAndUs);
  pages.set(...okPage(path, html));
  return pages;
}

test('a restructured country × service page fails as parse_failed, never zero records, and the other pages still parse', () => {
  const context = contextWithMarkets(['SE', 'US']);
  const sweden = fixtureHtml('services__netflix__sweden');
  for (const planted of [
    sweden.replaceAll('aria-labelledby="plans"', 'aria-labelledby="plan-list"'),
    sweden.replaceAll('\\"official\\"', '\\"listPrice\\"'),
  ]) {
    assert.notEqual(planted, sweden);
    const result = parse(
      context,
      withPage('/services/netflix/sweden', planted),
    );
    assert.deepEqual(
      result.observations,
      capturedObservations.filter(
        (entry) => !(entry.market === 'SE' && entry.service_id === 'netflix'),
      ),
    );
    const netflix = result.gaps.filter(
      (gap) => gap.market === 'SE' && gap.service_id === 'netflix',
    );
    assert.deepEqual(
      netflix.map((gap) => [gap.plan_id, gap.reason, gap.source_url]),
      ['basic', 'premium', 'standard'].map((plan) => [
        plan,
        'parse_failed',
        `${origin}/services/netflix/sweden`,
      ]),
    );
    const failure = result.failures.find(
      (entry) => entry.reason === 'parse_failed',
    );
    assert.equal(failure?.url, `${origin}/services/netflix/sweden`);
    assert.equal(failure?.market, 'SE');
    assertCoversEveryPlan(result, context);
  }
});

test('a restructured country page fails that market only; a broken index fails every market', () => {
  const context = contextWithMarkets(['SE', 'US']);
  const country = parse(
    context,
    withPage(
      '/countries/sweden',
      fixtureHtml('countries__sweden').replaceAll(
        'class="prow"',
        'class="row"',
      ),
    ),
  );
  assert.deepEqual(
    country.observations,
    capturedObservations.filter((entry) => entry.market === 'US'),
  );
  const sweden = country.gaps.filter((gap) => gap.market === 'SE');
  assert.ok(sweden.length > 0);
  assert.ok(sweden.every((gap) => gap.reason === 'parse_failed'));
  assertCoversEveryPlan(country, context);

  const index = parse(
    context,
    withPage(
      '/services',
      fixtureHtml('services').replaceAll('href="/services/', 'href="/apps/'),
    ),
  );
  assert.deepEqual(index.observations, []);
  assert.ok(index.gaps.every((gap) => gap.reason === 'parse_failed'));
  assert.deepEqual(
    index.failures.map((failure) => [
      failure.url,
      failure.market,
      failure.reason,
    ]),
    [[`${origin}/services`, null, 'parse_failed']],
  );
  assertCoversEveryPlan(index, context);
});

test('a page that did not load is market_failed with its outcome', () => {
  const context = contextWithMarkets(['US']);
  const pages = capturedPages(swedenAndUs);
  const url = `${origin}/services/chatgpt/united-states`;
  pages.set(url, { url, outcome: 'http_error', detail: 'HTTP 404' });
  const result = parse(context, pages);
  const gap = result.gaps.find((entry) => entry.service_id === 'chatgpt');
  assert.equal(gap?.reason, 'market_failed');
  assert.equal(gap?.note, 'the page did not load (http_error: HTTP 404)');
  assert.ok(
    !result.observations.some((entry) => entry.service_id === 'chatgpt'),
  );
});

function withAliases(
  catalogue: CatalogueFile,
  serviceId: string,
  aliases: CatalogueFile['services'][number]['source_aliases'],
  plans?: CatalogueFile['services'][number]['plans'],
): CatalogueFile {
  return {
    services: catalogue.services.map((service) =>
      service.service_id === serviceId
        ? { ...service, source_aliases: aliases, plans: plans ?? service.plans }
        : service,
    ),
  };
}

test('a new alias in the catalogue matches with no code change', () => {
  const catalogue = withAliases(committedCatalogue(), 'adobe-creative-cloud', {
    service: ['Adobe Creative Cloud', 'adobe'],
    plans: { individual: ['Creative Cloud Pro', 'cc-pro'] },
  });
  const result = parse(
    contextWithMarkets(['SE', 'US'], catalogue),
    capturedPages(swedenAndUs),
  );
  const adobe = result.observations.filter(
    (entry) => entry.service_id === 'adobe-creative-cloud',
  );
  assert.deepEqual(adobe, [
    observation(
      'SE',
      'adobe-creative-cloud',
      'individual',
      '932.50',
      `kr${NBSP}932.50`,
      '92.59',
      'adobe/sweden',
      '2026-11-01',
    ),
    observation(
      'US',
      'adobe-creative-cloud',
      'individual',
      '69.99',
      '$69.99 + tax',
      '69.99',
      'adobe/united-states',
      '2026-11-01',
    ),
  ]);
  assert.ok(
    !result.untracked.some(
      (entry) => entry.kind === 'service' && entry.source_service === 'adobe',
    ),
  );
  assert.ok(
    result.untracked.some(
      (entry) =>
        entry.kind === 'plan' &&
        entry.service_id === 'adobe-creative-cloud' &&
        entry.source_plan === 'photoshop',
    ),
  );

  // A new plan with its alias is observed too, again with no code change.
  const spotify = committedCatalogue().services.find(
    (service) => service.service_id === 'spotify',
  );
  assert.ok(spotify);
  const duo = withAliases(
    committedCatalogue(),
    'spotify',
    {
      ...spotify.source_aliases,
      plans: { ...spotify.source_aliases.plans, duo: ['Premium Duo'] },
    },
    [
      ...spotify.plans,
      {
        plan_id: 'duo',
        name: 'Duo',
        billing_period: 'month',
        is_student: false,
        is_family: false,
      },
    ],
  );
  const withDuo = parse(
    contextWithMarkets(['SE', 'US'], duo),
    capturedPages(swedenAndUs),
  );
  assert.deepEqual(
    withDuo.observations.filter((entry) => entry.plan_id === 'duo'),
    [
      observation(
        'SE',
        'spotify',
        'duo',
        '199.00',
        `kr${NBSP}199`,
        '19.76',
        'spotify/sweden',
        '2026-11-04',
      ),
      observation(
        'US',
        'spotify',
        'duo',
        '18.99',
        '$18.99 + tax',
        '18.99',
        'spotify/united-states',
        '2026-11-16',
      ),
    ],
  );
});

test("a removed service's entries become untracked, and nothing of it is observed", () => {
  const catalogue = committedCatalogue();
  const result = parse(
    contextWithMarkets(['SE', 'US'], {
      services: catalogue.services.filter(
        (service) => service.service_id !== 'netflix',
      ),
    }),
    capturedPages(swedenAndUs),
  );
  assert.ok(
    !result.observations.some((entry) => entry.service_id === 'netflix'),
  );
  assert.ok(!result.gaps.some((entry) => entry.service_id === 'netflix'));
  assert.ok(
    !result.untracked.some(
      (entry) => entry.kind === 'plan' && entry.service_id === 'netflix',
    ),
  );
  assert.deepEqual(
    result.untracked.find(
      (entry) => entry.kind === 'service' && entry.source_service === 'netflix',
    ),
    {
      kind: 'service',
      source_service: 'netflix',
      source_name: 'Netflix',
      suggestion: null,
    },
  );
  assert.ok(
    result.priceMoves
      ?.filter((move) => move.source_service === 'netflix')
      .every((move) => move.service_id === null),
  );
});

test('an ambiguous alias fails as parse_failed and is never resolved by picking one match', () => {
  const baseline = parse(
    contextWithMarkets(['SE', 'US']),
    capturedPages(swedenAndUs),
  );
  // Every failure but the planted one is a failure the baseline already has.
  const assertFailures = (
    result: SourceParseResult,
    before: SourceParseResult,
    planted: SourceParseResult['failures'][number],
    what: string,
  ) => {
    assert.deepEqual(
      result.failures.filter((failure) => failure.reason === 'parse_failed'),
      [planted],
      what,
    );
    assert.deepEqual(
      result.failures.filter((failure) => failure.reason !== 'parse_failed'),
      before.failures,
      what,
    );
  };
  assert.ok(
    baseline.failures.every((failure) => failure.reason === 'market_failed'),
  );
  const netflix = committedCatalogue().services.find(
    (service) => service.service_id === 'netflix',
  );
  assert.ok(netflix);
  const outside = (serviceIds: readonly string[]) => ({
    observations: (entries: readonly Observation[]) =>
      entries.filter((entry) => !serviceIds.includes(entry.service_id)),
    gaps: (entries: SourceParseResult['gaps']) =>
      entries.filter((entry) => !serviceIds.includes(entry.service_id)),
  });
  const failedGaps = (
    result: SourceParseResult,
    serviceIds: readonly string[],
  ) =>
    result.gaps
      .filter((gap) => serviceIds.includes(gap.service_id))
      .map((gap) => [
        gap.market,
        gap.service_id,
        gap.plan_id,
        gap.reason,
        gap.source_url,
        gap.note,
      ]);

  // A service's aliases match two source services: neither is chosen.
  {
    const context = contextWithMarkets(
      ['SE', 'US'],
      withAliases(committedCatalogue(), 'netflix', {
        ...netflix.source_aliases,
        service: ['Netflix', 'netflix', 'adobe'],
      }),
    );
    const result = parse(context, capturedPages(swedenAndUs));
    const detail =
      'the aliases of netflix match 2 source services: netflix, adobe';
    assert.deepEqual(
      result.observations,
      outside(['netflix']).observations(capturedObservations),
    );
    assert.deepEqual(
      outside(['netflix']).gaps(result.gaps),
      outside(['netflix']).gaps(baseline.gaps),
    );
    assert.deepEqual(failedGaps(result, ['netflix']), [
      ['SE', 'netflix', 'basic', 'parse_failed', `${origin}/services`, detail],
      ['US', 'netflix', 'basic', 'parse_failed', `${origin}/services`, detail],
      [
        'SE',
        'netflix',
        'premium',
        'parse_failed',
        `${origin}/services`,
        detail,
      ],
      [
        'US',
        'netflix',
        'premium',
        'parse_failed',
        `${origin}/services`,
        detail,
      ],
      [
        'SE',
        'netflix',
        'standard',
        'parse_failed',
        `${origin}/services`,
        detail,
      ],
      [
        'US',
        'netflix',
        'standard',
        'parse_failed',
        `${origin}/services`,
        detail,
      ],
    ]);
    assertFailures(
      result,
      baseline,
      {
        url: `${origin}/services`,
        market: null,
        reason: 'parse_failed',
        detail,
      },
      'two source services',
    );
    assertCoversEveryPlan(result, context);
  }

  // One source service is claimed by two catalogue services: neither gets it.
  {
    const context = contextWithMarkets(
      ['SE', 'US'],
      withAliases(committedCatalogue(), 'adobe-creative-cloud', {
        service: ['netflix'],
        plans: {},
      }),
    );
    const result = parse(context, capturedPages(swedenAndUs));
    const detail =
      'the source service netflix matches adobe-creative-cloud and netflix';
    const claimants = ['adobe-creative-cloud', 'netflix'];
    assert.deepEqual(
      result.observations,
      outside(claimants).observations(capturedObservations),
    );
    assert.deepEqual(
      outside(claimants).gaps(result.gaps),
      outside(claimants).gaps(baseline.gaps),
    );
    const services = `${origin}/services`;
    assert.deepEqual(failedGaps(result, claimants), [
      [
        'SE',
        'adobe-creative-cloud',
        'individual',
        'parse_failed',
        services,
        detail,
      ],
      [
        'US',
        'adobe-creative-cloud',
        'individual',
        'parse_failed',
        services,
        detail,
      ],
      ['SE', 'netflix', 'basic', 'parse_failed', services, detail],
      ['US', 'netflix', 'basic', 'parse_failed', services, detail],
      ['SE', 'netflix', 'premium', 'parse_failed', services, detail],
      ['US', 'netflix', 'premium', 'parse_failed', services, detail],
      ['SE', 'netflix', 'standard', 'parse_failed', services, detail],
      ['US', 'netflix', 'standard', 'parse_failed', services, detail],
    ]);
    assertFailures(
      result,
      baseline,
      { url: services, market: null, reason: 'parse_failed', detail },
      'claimed twice',
    );
    assertCoversEveryPlan(result, context);
  }

  // A plan row matches two plans, or two plan rows match one plan: the
  // country × service page fails, and no row is assigned to either plan.
  const sweden = `${origin}/services/netflix/sweden`;
  const planCases: [string, Record<string, string[]>, string][] = [
    [
      'one row matches two plans',
      {
        basic: ['Basic', 'basic'],
        standard: ['Standard', 'standard', 'basic'],
        premium: ['Premium', 'premium'],
      },
      'the plan row basic matches basic and standard',
    ],
    [
      'two rows match one plan',
      {
        basic: ['Basic', 'basic', 'Standard', 'standard'],
        standard: [],
        premium: ['Premium', 'premium'],
      },
      // The Sweden page lists standard before basic.
      '2 plan rows match netflix basic: standard, basic',
    ],
  ];
  for (const [what, plans, detail] of planCases) {
    const context = contextWithMarkets(
      ['SE'],
      withAliases(committedCatalogue(), 'netflix', {
        service: netflix.source_aliases.service,
        plans,
      }),
    );
    const result = parse(context, capturedPages(swedenAndUs));
    const seBaseline = parse(
      contextWithMarkets(['SE']),
      capturedPages(swedenAndUs),
    );
    assert.deepEqual(
      result.observations,
      outside(['netflix']).observations(
        capturedObservations.filter((entry) => entry.market === 'SE'),
      ),
      what,
    );
    assert.deepEqual(
      outside(['netflix']).gaps(result.gaps),
      outside(['netflix']).gaps(seBaseline.gaps),
      what,
    );
    assert.deepEqual(
      failedGaps(result, ['netflix']),
      [
        ['SE', 'netflix', 'basic', 'parse_failed', sweden, detail],
        ['SE', 'netflix', 'premium', 'parse_failed', sweden, detail],
        ['SE', 'netflix', 'standard', 'parse_failed', sweden, detail],
      ],
      what,
    );
    assertFailures(
      result,
      seBaseline,
      { url: sweden, market: 'SE', reason: 'parse_failed', detail },
      what,
    );
    assert.ok(
      !result.untracked.some(
        (entry) => entry.kind === 'plan' && entry.service_id === 'netflix',
      ),
      what,
    );
    assertCoversEveryPlan(result, context);
  }
});

test('no suggestion is ever written to the catalogue or applied to a match', () => {
  const catalogueFile = readFileSync('config/catalogue.json');
  const context = deepFrozen(contextWithMarkets(['SE', 'US']));
  const before = structuredClone(context);
  // A frozen context makes any write throw (ES modules are strict).
  const result = parse(context, capturedPages(swedenAndUs));
  assert.deepEqual(context, before);
  assert.deepEqual(readFileSync('config/catalogue.json'), catalogueFile);
  // Adobe has a suggestion, and is still unmatched.
  assert.ok(
    result.untracked.some(
      (entry) =>
        entry.kind === 'service' &&
        entry.suggestion?.service_id === 'adobe-creative-cloud',
    ),
  );
  assert.ok(
    !result.observations.some(
      (entry) => entry.service_id === 'adobe-creative-cloud',
    ),
  );
  assert.equal(
    result.gaps.filter(
      (gap) =>
        gap.service_id === 'adobe-creative-cloud' &&
        gap.reason === 'not_on_source',
    ).length,
    2,
  );
  // "Standard with ads" is suggested for Standard, and is never read as Standard or Basic.
  const ads = result.untracked.find(
    (entry) => entry.kind === 'plan' && entry.source_plan === 'standard-ads',
  );
  assert.deepEqual(ads?.kind === 'plan' ? ads.suggestion : null, {
    plan_id: 'standard',
  });
  assert.ok(!result.observations.some((entry) => entry.price_local === '8.99'));
  // The sources read no file and write none.
  for (const file of listSources('packages/price-index/src/sources')) {
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /node:fs|from 'fs'|writeFile|appendFile/,
      file,
    );
  }
});

function listSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listSources(`${directory}/${entry.name}`)
      : [`${directory}/${entry.name}`],
  );
}

test('price moves are kept as their own list and never alter an observation', () => {
  const context = contextWithMarkets(['SE', 'US']);
  const baseline = parse(context, capturedPages(swedenAndUs));
  assert.equal(baseline.priceMoves?.length, 205);
  assert.deepEqual(
    baseline.priceMoves
      ?.slice(0, 1)
      .map((move) => [
        move.source_service,
        move.service_id,
        move.source_plan,
        move.plan_id,
        move.market,
        move.old_price,
        move.new_price,
      ]),
    [['netflix', 'netflix', 'basic', 'basic', 'HR', '5.99', '6.99']],
  );
  const spotifyDuo = baseline.priceMoves?.find(
    (move) => move.source_service === 'spotify' && move.source_plan === 'duo',
  );
  assert.equal(spotifyDuo?.service_id, 'spotify');
  assert.equal(spotifyDuo?.plan_id, null);

  // Without the page: no list, a failure, and the same observations.
  const without = capturedPages(swedenAndUs);
  without.delete(`${origin}/price-moves`);
  const missing = parse(context, without);
  assert.equal(missing.priceMoves, null);
  assert.deepEqual(missing.observations, baseline.observations);
  assert.deepEqual(missing.gaps, baseline.gaps);
  assert.ok(
    missing.failures.some(
      (failure) =>
        failure.url === `${origin}/price-moves` && failure.market === null,
    ),
  );

  // With moves that disagree with every observed price: the same observations.
  const moves = fixtureHtml('price-moves').replace(
    /(\\"(?:netflix|spotify|apple-music)\\",\\"[a-z-]+\\",\\"(?:SE|US)\\",\\"m\\",\\"[A-Z]{3}\\",)[0-9.]+,[0-9.]+,/g,
    (_match, prefix: string) => `${prefix}1,9999,`,
  );
  assert.notEqual(moves, fixtureHtml('price-moves'));
  const tampered = parse(context, withPage('/price-moves', moves));
  assert.deepEqual(tampered.observations, baseline.observations);
  assert.deepEqual(tampered.gaps, baseline.gaps);
  assert.ok(
    tampered.priceMoves?.some(
      (move) => move.market === 'SE' && move.new_price === '9999.00',
    ),
  );
});

test('observedAt is required as an RFC 3339 UTC time, and every observation carries it', () => {
  const context = contextWithMarkets(['SE']);
  for (const bad of [
    '',
    '2026-11-18',
    'yesterday',
    '2026-11-18T10:00:00+02:00',
  ]) {
    assert.throws(
      () => adapter.parse({ observedAt: bad, pages: new Map() }, context),
      SourceInputError,
      bad,
    );
  }
  const result = adapter.parse(
    { observedAt: '2026-12-01T08:00:00Z', pages: capturedPages(swedenAndUs) },
    context,
  );
  assert.ok(result.observations.length > 0);
  assert.ok(
    result.observations.every(
      (entry) => entry.observed_at === '2026-12-01T08:00:00Z',
    ),
  );
});
