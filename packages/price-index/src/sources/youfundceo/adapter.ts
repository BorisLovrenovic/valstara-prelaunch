import { z } from 'zod';

import type { Service } from '../../schema/catalogue.ts';
import { normaliseAlias } from '../../schema/common.ts';
import type { Market } from '../../schema/markets.ts';
import { sourceOrigin } from '../../schema/price-index-settings.ts';
import { matchesAlias, suggestAlias } from '../matching.ts';
import {
  SourceInputError,
  type Observation,
  type PageFailure,
  type PriceMove,
  type RawPages,
  type RawRun,
  type RunUnit,
  type SourceAdapter,
  type SourceContext,
  type SourceGap,
  type SourceParseResult,
  type UntrackedEntry,
} from '../source-adapter.ts';
import {
  PageParseError,
  readCountriesIndex,
  readCountryPage,
  readCountryServicePage,
  readPriceMoves,
  readServicesIndex,
  type CountryPage,
  type CountryServicePage,
  type IndexLink,
} from './pages.ts';

// The youfundceo.com adapter (E11.6-05). It asks for the minimum request set
// of docs/features/price-index-source-findings.md#the-minimum-request-set-for-a-monthly-run:
// `/countries`, `/services` and `/price-moves` once, then each enabled
// market's country page, then a country × service page **only for a tracked
// service the source prices in that country**. Every price comes from a
// country × service page. A service the source does not list, globally or in
// a country, is `not_on_source`; one in "No price shown" is `source_no_price`.
// Both are expected. Names match only through `source_aliases`.

export const youfundceoSource = 'scraper:youfundceo.com';

const indexUnitId = 'index';
const marketUnitPrefix = 'market:';
const countriesPath = '/countries';
const servicesPath = '/services';
const priceMovesPath = '/price-moves';
const observedAtSchema = z.iso.datetime();

function absolute(path: string): string {
  return `${sourceOrigin}${path}`;
}

type Read<T> =
  { ok: true; value: T } | { ok: false; failure: Omit<PageFailure, 'market'> };

/** Reads one fetched page, or says why it cannot be used. */
function readPage<T>(
  pages: RawPages,
  url: string,
  read: (html: string) => T,
): Read<T> {
  const page = pages.get(url);
  if (page === undefined) {
    return {
      ok: false,
      failure: {
        url,
        reason: 'market_failed',
        detail: 'the page was not fetched',
      },
    };
  }
  if (page.outcome !== 'ok') {
    return {
      ok: false,
      failure: {
        url,
        reason: 'market_failed',
        detail: `the page did not load (${page.outcome}: ${page.detail})`,
      },
    };
  }
  try {
    return { ok: true, value: read(page.html) };
  } catch (error) {
    if (error instanceof PageParseError) {
      return {
        ok: false,
        failure: { url, reason: 'parse_failed', detail: error.message },
      };
    }
    throw error;
  }
}

type Resolution =
  | { kind: 'found'; slug: string; name: string }
  | { kind: 'absent' }
  | { kind: 'ambiguous'; detail: string };

/**
 * Each catalogue service's source slug, through its service aliases only.
 * A service whose aliases match two source services, or a source service
 * two catalogue services claim, resolves to neither.
 */
function resolveServices(
  services: readonly Service[],
  links: readonly IndexLink[],
): Map<string, Resolution> {
  const claims = new Map<string, string[]>();
  const matched = new Map<string, IndexLink[]>();
  for (const service of services) {
    const found = links.filter((link) =>
      matchesAlias([link.name, link.slug], service.source_aliases.service),
    );
    matched.set(service.service_id, found);
    for (const link of found) {
      claims.set(link.slug, [
        ...(claims.get(link.slug) ?? []),
        service.service_id,
      ]);
    }
  }
  const resolutions = new Map<string, Resolution>();
  for (const service of services) {
    const found = matched.get(service.service_id) ?? [];
    if (found.length === 0) {
      resolutions.set(service.service_id, { kind: 'absent' });
    } else if (found.length > 1) {
      resolutions.set(service.service_id, {
        kind: 'ambiguous',
        detail: `the aliases of ${service.service_id} match ${found.length} source services: ${found.map((link) => link.slug).join(', ')}`,
      });
    } else if ((claims.get(found[0].slug) ?? []).length > 1) {
      resolutions.set(service.service_id, {
        kind: 'ambiguous',
        detail: `the source service ${found[0].slug} matches ${claims.get(found[0].slug)?.join(' and ')}`,
      });
    } else {
      resolutions.set(service.service_id, { kind: 'found', ...found[0] });
    }
  }
  return resolutions;
}

/** A market's country slug on the source, by its name or its own slug. */
function resolveCountry(
  market: Market,
  links: readonly IndexLink[],
): Resolution {
  const name = normaliseAlias(market.name);
  const found = links.filter(
    (link) => normaliseAlias(link.name) === name || link.slug === market.slug,
  );
  if (found.length === 0) {
    return { kind: 'absent' };
  }
  if (found.length > 1) {
    return {
      kind: 'ambiguous',
      detail: `${market.name} matches ${found.length} source countries: ${found.map((link) => link.slug).join(', ')}`,
    };
  }
  return { kind: 'found', ...found[0] };
}

function enabledMarkets(context: SourceContext): Market[] {
  return context.markets.markets.filter((market) => market.enabled);
}

function readCountry(pages: RawPages, url: string, countrySlug: string) {
  return readPage(pages, url, (html) =>
    readCountryPage(html, { url, origin: sourceOrigin, countrySlug }),
  );
}

function units(context: SourceContext): RunUnit[] {
  return [
    { id: indexUnitId, market: null },
    ...enabledMarkets(context).map((market) => ({
      id: `${marketUnitPrefix}${market.code}`,
      market: market.code,
    })),
  ];
}

function marketRequests(
  market: Market,
  context: SourceContext,
  pages: RawPages,
): string[] {
  const countries = readPage(
    pages,
    absolute(countriesPath),
    readCountriesIndex,
  );
  const services = readPage(pages, absolute(servicesPath), readServicesIndex);
  if (!countries.ok || !services.ok) {
    return [];
  }
  const country = resolveCountry(market, countries.value);
  if (country.kind !== 'found') {
    return [];
  }
  const countryUrl = absolute(`${countriesPath}/${country.slug}`);
  if (!pages.has(countryUrl)) {
    return [countryUrl];
  }
  const page = readCountry(pages, countryUrl, country.slug);
  if (!page.ok) {
    return [];
  }
  const resolutions = resolveServices(
    context.catalogue.services,
    services.value,
  );
  const wanted: string[] = [];
  for (const service of context.catalogue.services) {
    const resolution = resolutions.get(service.service_id);
    if (resolution?.kind !== 'found') {
      continue;
    }
    const entry = page.value.priced.find(
      (item) => item.service === resolution.slug,
    );
    if (entry) {
      wanted.push(absolute(entry.path));
    }
  }
  return wanted;
}

function requests(
  unit: RunUnit,
  context: SourceContext,
  pages: RawPages,
): string[] {
  let wanted: string[];
  if (unit.id === indexUnitId) {
    wanted = [countriesPath, servicesPath, priceMovesPath].map(absolute);
  } else {
    const market = enabledMarkets(context).find(
      (candidate) =>
        unit.market === candidate.code &&
        unit.id === `${marketUnitPrefix}${candidate.code}`,
    );
    wanted = market ? marketRequests(market, context, pages) : [];
  }
  return wanted.filter((url) => !pages.has(url));
}

function byIdentity(
  a: {
    service_id: string;
    plan_id: string;
    billing_period: string;
    market: string;
  },
  b: {
    service_id: string;
    plan_id: string;
    billing_period: string;
    market: string;
  },
): number {
  for (const key of [
    'service_id',
    'plan_id',
    'billing_period',
    'market',
  ] as const) {
    if (a[key] !== b[key]) {
      return a[key] < b[key] ? -1 : 1;
    }
  }
  return 0;
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

interface PlanMatch {
  observations: Observation[];
  absent: Service['plans'];
  untracked: {
    key: string;
    name: string;
    billingPeriod: Observation['billing_period'];
  }[];
}

/**
 * Matches a page's plan rows to the service's plans through the plan
 * aliases. A row matches when its name or key equals an alias; it is an
 * observation only in the plan's own billing period. Two rows for one plan,
 * or one row for two plans, fail the page.
 */
function matchPlans(
  service: Service,
  page: CountryServicePage,
  observation: (
    plan: Service['plans'][number],
    row: CountryServicePage['rows'][number],
  ) => Observation,
): PlanMatch {
  const rowsByPlan = new Map<string, CountryServicePage['rows'][number][]>();
  const untracked: PlanMatch['untracked'] = [];
  for (const row of page.rows) {
    const plans = service.plans.filter((plan) =>
      matchesAlias(
        [row.name, row.key],
        service.source_aliases.plans[plan.plan_id] ?? [],
      ),
    );
    if (plans.length > 1) {
      throw new PageParseError(
        `the plan row ${row.key} matches ${plans.map((plan) => plan.plan_id).join(' and ')}`,
      );
    }
    const [plan] = plans;
    if (plan && plan.billing_period === row.billingPeriod) {
      rowsByPlan.set(plan.plan_id, [
        ...(rowsByPlan.get(plan.plan_id) ?? []),
        row,
      ]);
    } else {
      untracked.push({
        key: row.key,
        name: row.name,
        billingPeriod: row.billingPeriod,
      });
    }
  }
  const observations: Observation[] = [];
  const absent: Service['plans'] = [];
  for (const plan of service.plans) {
    const rows = rowsByPlan.get(plan.plan_id) ?? [];
    if (rows.length > 1) {
      throw new PageParseError(
        `${rows.length} plan rows match ${service.service_id} ${plan.plan_id}: ${rows.map((row) => row.key).join(', ')}`,
      );
    }
    if (rows.length === 1) {
      observations.push(observation(plan, rows[0]));
    } else {
      absent.push(plan);
    }
  }
  return { observations, absent, untracked };
}

function parse(raw: RawRun, context: SourceContext): SourceParseResult {
  if (!observedAtSchema.safeParse(raw.observedAt).success) {
    throw new SourceInputError(
      `observedAt must be an RFC 3339 UTC time, not ${JSON.stringify(raw.observedAt)}`,
    );
  }
  const { pages } = raw;
  const catalogue = context.catalogue.services;
  const observations: Observation[] = [];
  const gaps: SourceGap[] = [];
  const failures = new Map<string, PageFailure>();
  const untrackedPlans = new Map<string, UntrackedEntry & { kind: 'plan' }>();

  const fail = (
    failure: Omit<PageFailure, 'market'>,
    market: string | null,
  ) => {
    failures.set(`${failure.url}\u0000${market ?? ''}`, { ...failure, market });
  };
  const gap = (
    market: Market,
    service: Service,
    plans: Service['plans'],
    reason: SourceGap['reason'],
    sourceUrl: string | null,
    note: string | null,
  ) => {
    for (const plan of plans) {
      gaps.push({
        market: market.code,
        service_id: service.service_id,
        plan_id: plan.plan_id,
        billing_period: plan.billing_period,
        reason,
        source_url: sourceUrl,
        note,
      });
    }
  };
  const gapEveryService = (
    market: Market,
    failure: Omit<PageFailure, 'market'>,
    shared: boolean,
  ) => {
    fail(failure, shared ? null : market.code);
    for (const service of catalogue) {
      gap(
        market,
        service,
        service.plans,
        failure.reason,
        failure.url,
        failure.detail,
      );
    }
  };

  const countries = readPage(
    pages,
    absolute(countriesPath),
    readCountriesIndex,
  );
  const services = readPage(pages, absolute(servicesPath), readServicesIndex);
  const resolutions = services.ok
    ? resolveServices(catalogue, services.value)
    : new Map<string, Resolution>();

  const untrackedServices: UntrackedEntry[] = [];
  if (services.ok) {
    for (const link of services.value) {
      const claimed = catalogue.some((service) =>
        matchesAlias([link.name, link.slug], service.source_aliases.service),
      );
      if (claimed) {
        continue;
      }
      const suggestion = suggestAlias(
        [link.name, link.slug],
        catalogue.map((service) => ({
          id: service.service_id,
          names: [service.name, service.service_id],
        })),
      );
      untrackedServices.push({
        kind: 'service',
        source_service: link.slug,
        source_name: link.name,
        suggestion: suggestion === null ? null : { service_id: suggestion },
      });
    }
  }

  for (const market of enabledMarkets(context)) {
    if (!services.ok) {
      gapEveryService(market, services.failure, true);
      continue;
    }
    if (!countries.ok) {
      gapEveryService(market, countries.failure, true);
      continue;
    }
    const country = resolveCountry(market, countries.value);
    if (country.kind === 'absent') {
      for (const service of catalogue) {
        gap(
          market,
          service,
          service.plans,
          'not_on_source',
          absolute(countriesPath),
          `the source does not list ${market.name}`,
        );
      }
      continue;
    }
    if (country.kind === 'ambiguous') {
      gapEveryService(
        market,
        {
          url: absolute(countriesPath),
          reason: 'parse_failed',
          detail: country.detail,
        },
        false,
      );
      continue;
    }
    const countryUrl = absolute(`${countriesPath}/${country.slug}`);
    const countryPage: Read<CountryPage> = readCountry(
      pages,
      countryUrl,
      country.slug,
    );
    if (!countryPage.ok) {
      gapEveryService(market, countryPage.failure, false);
      continue;
    }

    for (const service of catalogue) {
      const resolution = resolutions.get(service.service_id) ?? {
        kind: 'absent',
      };
      if (resolution.kind === 'absent') {
        gap(
          market,
          service,
          service.plans,
          'not_on_source',
          absolute(servicesPath),
          null,
        );
        continue;
      }
      if (resolution.kind === 'ambiguous') {
        const failure = {
          url: absolute(servicesPath),
          reason: 'parse_failed' as const,
          detail: resolution.detail,
        };
        fail(failure, null);
        gap(
          market,
          service,
          service.plans,
          'parse_failed',
          failure.url,
          failure.detail,
        );
        continue;
      }
      const noPrice = countryPage.value.unavailable.find(
        (entry) => entry.service === resolution.slug,
      );
      if (noPrice) {
        gap(
          market,
          service,
          service.plans,
          'source_no_price',
          countryUrl,
          noPrice.label,
        );
        continue;
      }
      const priced = countryPage.value.priced.find(
        (entry) => entry.service === resolution.slug,
      );
      if (!priced) {
        gap(market, service, service.plans, 'not_on_source', countryUrl, null);
        continue;
      }

      const pageUrl = absolute(priced.path);
      const matched = readPage(pages, pageUrl, (html) => {
        const page = readCountryServicePage(html, {
          url: pageUrl,
          market: market.code,
        });
        return matchPlans(service, page, (plan, row) => ({
          market: market.code,
          service_id: service.service_id,
          plan_id: plan.plan_id,
          billing_period: plan.billing_period,
          price_local: row.priceLocal,
          price_source_text: row.priceSourceText,
          currency: row.currency,
          price_usd_source: row.priceUsd,
          source: youfundceoSource,
          source_url: pageUrl,
          observed_at: raw.observedAt,
          source_verified_at: page.verifiedAt,
        }));
      });
      if (!matched.ok) {
        fail(matched.failure, market.code);
        gap(
          market,
          service,
          service.plans,
          matched.failure.reason,
          pageUrl,
          matched.failure.detail,
        );
        continue;
      }
      observations.push(...matched.value.observations);
      gap(
        market,
        service,
        matched.value.absent,
        'not_on_source',
        pageUrl,
        null,
      );
      for (const row of matched.value.untracked) {
        const key = [service.service_id, row.key, row.billingPeriod].join(
          '\u0000',
        );
        const known = untrackedPlans.get(key);
        if (known) {
          untrackedPlans.set(key, {
            ...known,
            markets: [...known.markets, market.code],
          });
          continue;
        }
        const suggestion = suggestAlias(
          [row.name, row.key],
          service.plans.map((plan) => ({
            id: plan.plan_id,
            names: [plan.name, plan.plan_id],
          })),
        );
        untrackedPlans.set(key, {
          kind: 'plan',
          service_id: service.service_id,
          source_service: resolution.slug,
          source_plan: row.key,
          source_name: row.name,
          billing_period: row.billingPeriod,
          markets: [market.code],
          suggestion: suggestion === null ? null : { plan_id: suggestion },
        });
      }
    }
  }

  const moves = readPage(pages, absolute(priceMovesPath), readPriceMoves);
  let priceMoves: PriceMove[] | null = null;
  if (moves.ok) {
    priceMoves = moves.value.map((move) => {
      const sourceName = services.ok
        ? services.value.find((link) => link.slug === move.service)?.name
        : undefined;
      const matches = catalogue.filter((service) =>
        matchesAlias(
          sourceName === undefined
            ? [move.service]
            : [move.service, sourceName],
          service.source_aliases.service,
        ),
      );
      const service = matches.length === 1 ? matches[0] : undefined;
      const plans = service
        ? service.plans.filter((plan) =>
            matchesAlias(
              [move.plan],
              service.source_aliases.plans[plan.plan_id] ?? [],
            ),
          )
        : [];
      return {
        source_service: move.service,
        source_plan: move.plan,
        service_id: service?.service_id ?? null,
        plan_id: plans.length === 1 ? plans[0].plan_id : null,
        market: move.country,
        period: move.period,
        currency: move.currency,
        old_price: move.oldPrice,
        new_price: move.newPrice,
        date: move.date,
        after_date: move.afterDate,
        evidence_url: move.evidenceUrl,
        source_flag: move.flag,
        old_usd: move.oldUsd,
        new_usd: move.newUsd,
      };
    });
  } else {
    fail(moves.failure, null);
  }

  const untracked: UntrackedEntry[] = [
    ...untrackedServices.sort((a, b) =>
      compareText(a.source_service, b.source_service),
    ),
    ...[...untrackedPlans.values()]
      .map((entry) => ({
        ...entry,
        markets: [...entry.markets].sort(compareText),
      }))
      .sort(
        (a, b) =>
          compareText(a.service_id, b.service_id) ||
          compareText(a.source_plan, b.source_plan) ||
          compareText(a.billing_period, b.billing_period),
      ),
  ];
  return {
    source: youfundceoSource,
    observations: observations.sort(byIdentity),
    gaps: gaps.sort(byIdentity),
    untracked,
    priceMoves,
    failures: [...failures.values()].sort(
      (a, b) =>
        compareText(a.url, b.url) ||
        compareText(a.market ?? '', b.market ?? ''),
    ),
  };
}

/** The youfundceo.com source. It fetches nothing itself and writes nothing. */
export const youfundceoAdapter: SourceAdapter = {
  id: 'youfundceo',
  source: youfundceoSource,
  origin: sourceOrigin,
  units,
  requests,
  parse,
};
