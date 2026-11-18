import { z } from 'zod';

import { equals, parseDecimal, toDecimalString } from '../../money/money.ts';
import { MoneyError } from '../../money/errors.ts';
import { parseMoney } from '../../money/parse.ts';
import type { PriceRecord } from '../../schema/price-record.ts';
import {
  asElement,
  FlightError,
  isJsonObject,
  JsonNumber,
  joinPayload,
  readFlightRows,
  walk,
  type FlightElement,
  type JsonObject,
  type JsonValue,
} from './flight.ts';
import {
  attribute,
  findAll,
  hasClass,
  isInside,
  parseHtml,
  scriptText,
  tagIs,
  visibleText,
  type HtmlDocument,
  type HtmlElement,
} from './html.ts';

// One reader per page type, each using the extraction source E11.6-01 chose
// (docs/features/price-index-source-findings.md#the-extraction-source-for-each-page-type).
// Every reader checks the page's structure and throws `PageParseError` on
// anything it does not recognise, so a changed page fails loudly as
// `parse_failed` and never yields a plausible wrong number or zero records.

export class PageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageParseError';
  }
}

type BillingPeriod = PriceRecord['billing_period'];

const slug = '([a-z0-9]+(?:-[a-z0-9]+)*)';
const countryHref = new RegExp(`^/countries/${slug}$`);
const serviceHref = new RegExp(`^/services/${slug}$`);
const countryServiceHref = new RegExp(`^/services/${slug}/${slug}$`);
const isoDate = z.iso.date();

function only<T>(items: readonly T[], what: string): T {
  if (items.length !== 1) {
    throw new PageParseError(`expected one ${what}, found ${items.length}`);
  }
  return items[0];
}

function textOf(root: HtmlElement, className: string): string {
  const element = only(
    findAll(root, (candidate) => hasClass(candidate, className)),
    `.${className}`,
  );
  return visibleText(element).trim();
}

function jsonLd(document: HtmlDocument, type: string): unknown[] {
  const found: unknown[] = [];
  for (const script of findAll(
    document,
    (element) =>
      element.name === 'script' &&
      attribute(element, 'type') === 'application/ld+json',
  )) {
    let value: unknown;
    try {
      value = JSON.parse(scriptText(script));
    } catch {
      throw new PageParseError('a JSON-LD script is not JSON');
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>)['@type'] === type
    ) {
      found.push(value);
    }
  }
  return found;
}

function flightRows(document: HtmlDocument): {
  values: JsonValue[];
  byId: Map<string, JsonValue>;
} {
  const scripts = findAll(
    document,
    (element) =>
      element.name === 'script' && attribute(element, 'src') === undefined,
  ).map(scriptText);
  try {
    const rows = readFlightRows(joinPayload(scripts));
    if (rows.length === 0) {
      throw new PageParseError('the page has no embedded data');
    }
    return {
      values: rows.map((row) => row.value),
      byId: new Map(rows.map((row) => [row.id, row.value])),
    };
  } catch (error) {
    if (error instanceof FlightError) {
      throw new PageParseError(
        `the embedded data is unreadable: ${error.message}`,
      );
    }
    throw error;
  }
}

function elementsIn(
  root: JsonValue,
  byId: ReadonlyMap<string, JsonValue>,
  test: (element: FlightElement) => boolean,
): FlightElement[] {
  const found: FlightElement[] = [];
  walk(root, byId, (value) => {
    const element = asElement(value);
    if (element && test(element)) {
      found.push(element);
    }
  });
  return found;
}

// ---------------------------------------------------------------- indexes

export interface IndexLink {
  readonly slug: string;
  readonly name: string;
}

function indexLinks(
  links: readonly { slug: string; name: string }[],
  what: string,
): IndexLink[] {
  if (links.length === 0) {
    throw new PageParseError(`no ${what} links`);
  }
  const bySlug = new Map<string, string>();
  for (const link of links) {
    if (link.name.length === 0) {
      throw new PageParseError(`the ${what} link ${link.slug} has no name`);
    }
    const known = bySlug.get(link.slug);
    if (known !== undefined && known !== link.name) {
      throw new PageParseError(`the ${what} ${link.slug} has two names`);
    }
    bySlug.set(link.slug, link.name);
  }
  return [...bySlug].map(([linkSlug, name]) => ({ slug: linkSlug, name }));
}

/** `/countries`: the `a.prow[href^="/countries/"]` links and their titles. */
export function readCountriesIndex(html: string): IndexLink[] {
  const document = parseHtml(html);
  const links = findAll(
    document,
    (element) =>
      element.name === 'a' &&
      hasClass(element, 'prow') &&
      countryHref.test(attribute(element, 'href') ?? ''),
  ).map((link) => ({
    slug: countryHref.exec(attribute(link, 'href') ?? '')?.[1] ?? '',
    name: textOf(link, 'prow-title'),
  }));
  return indexLinks(links, 'country');
}

/** `/services`: the `a[href^="/services/"]` links, each named by its first paragraph. */
export function readServicesIndex(html: string): IndexLink[] {
  const document = parseHtml(html);
  const links = findAll(
    document,
    (element) =>
      element.name === 'a' &&
      serviceHref.test(attribute(element, 'href') ?? ''),
  ).map((link) => {
    const paragraphs = findAll(link, tagIs('p'));
    if (paragraphs.length === 0) {
      throw new PageParseError(
        `the service link ${attribute(link, 'href')} has no name`,
      );
    }
    return {
      slug: serviceHref.exec(attribute(link, 'href') ?? '')?.[1] ?? '',
      name: visibleText(paragraphs[0]).trim(),
    };
  });
  return indexLinks(links, 'service');
}

// ---------------------------------------------------------- country page

export interface CountryEntry {
  /** The source's service slug. */
  readonly service: string;
  readonly name: string;
  /** The country × service page's path. */
  readonly path: string;
}

export interface UnavailableEntry extends CountryEntry {
  /** The source's label, e.g. "Not verified yet" or "Not available here". */
  readonly label: string;
}

export interface CountryPage {
  /** The services the source prices in the country, in page order. */
  readonly priced: readonly CountryEntry[];
  /** The "No price shown for <country>" list. */
  readonly unavailable: readonly UnavailableEntry[];
}

/**
 * A country page: the priced list and the "No price shown" list from the
 * HTML (`li[data-name] > a.prow[href]`), with the priced list cross-checked
 * against the JSON-LD `ItemList` in count, URLs and order. Prices are not
 * read here, and "What you get in <country>" is ignored.
 */
export function readCountryPage(
  html: string,
  page: { url: string; origin: string; countrySlug: string },
): CountryPage {
  const document = parseHtml(html);
  const unavailableSections = findAll(
    document,
    (element) =>
      element.name === 'section' &&
      attribute(element, 'aria-labelledby') === 'unavailable',
  );
  if (unavailableSections.length > 1) {
    throw new PageParseError('more than one "No price shown" section');
  }
  const unavailableSection = unavailableSections.at(0);

  const priced: CountryEntry[] = [];
  const unavailable: UnavailableEntry[] = [];
  const seen = new Set<string>();
  for (const link of findAll(
    document,
    (element) =>
      element.name === 'a' &&
      hasClass(element, 'prow') &&
      element.parent?.type === 'tag' &&
      (element.parent as HtmlElement).name === 'li' &&
      attribute(element.parent as HtmlElement, 'data-name') !== undefined,
  )) {
    const href = attribute(link, 'href') ?? '';
    const match = countryServiceHref.exec(href);
    if (!match || match[2] !== page.countrySlug) {
      throw new PageParseError(
        `an entry links to ${JSON.stringify(href)}, not a service in ${page.countrySlug}`,
      );
    }
    if (seen.has(match[1])) {
      throw new PageParseError(`the service ${match[1]} is listed twice`);
    }
    seen.add(match[1]);
    const entry = {
      service: match[1],
      name: textOf(link, 'prow-title'),
      path: href,
    };
    if (unavailableSection && isInside(link, unavailableSection)) {
      const label = textOf(link, 'prow-sub');
      if (label.length === 0) {
        throw new PageParseError(
          `the "No price shown" entry ${href} has no label`,
        );
      }
      unavailable.push({ ...entry, label });
    } else {
      priced.push(entry);
    }
  }

  const list = only(jsonLd(document, 'ItemList'), 'JSON-LD ItemList') as Record<
    string,
    unknown
  >;
  if (list.url !== page.url) {
    throw new PageParseError(
      `the JSON-LD ItemList is for ${JSON.stringify(list.url)}, not this page`,
    );
  }
  const items = list.itemListElement;
  if (!Array.isArray(items)) {
    throw new PageParseError('the JSON-LD ItemList has no items');
  }
  const listed = items.map((item: unknown) =>
    typeof item === 'object' && item !== null
      ? (item as Record<string, unknown>).url
      : undefined,
  );
  const shown = priced.map((entry) => `${page.origin}${entry.path}`);
  if (
    listed.length !== shown.length ||
    listed.some((url, index) => url !== shown[index]) ||
    (list.numberOfItems !== undefined && list.numberOfItems !== shown.length)
  ) {
    throw new PageParseError(
      `the priced list (${shown.length}) disagrees with the JSON-LD ItemList (${listed.length})`,
    );
  }
  return { priced, unavailable };
}

// -------------------------------------------------- country × service page

export interface PlanRow {
  /** The row's React key without its period, e.g. `basic`, `cc-pro`. */
  readonly key: string;
  /** The plan's name as displayed, e.g. "Premium Individual". */
  readonly name: string;
  readonly billingPeriod: BillingPeriod;
  readonly priceLocal: string;
  readonly currency: string;
  /** The displayed price, without its period: `kr 169`, `$19.99 + tax`. */
  readonly priceSourceText: string;
  readonly priceUsd: string | null;
}

export interface CountryServicePage {
  /** JSON-LD `Dataset.dateModified`: the source's "last checked" date. */
  readonly verifiedAt: string;
  readonly rows: readonly PlanRow[];
}

const rowKeyPattern = /^(.+)-(month|year)$/;
const periodSuffix = /^(.*\S)\s+\/\s+[^\s/]+$/;

function decimal(text: string, currency: string, what: string): string {
  try {
    return toDecimalString(parseDecimal(text, currency));
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new PageParseError(
        `${what} ${JSON.stringify(text)}: ${error.message}`,
      );
    }
    throw error;
  }
}

interface EmbeddedRow {
  key: string;
  dataName: string;
  official: JsonObject;
  usd: JsonValue;
}

function embeddedRows(document: HtmlDocument): EmbeddedRow[] {
  const { values, byId } = flightRows(document);
  const sections = values.flatMap((value) =>
    elementsIn(
      value,
      new Map(),
      (element) =>
        element.type === 'section' &&
        element.props['aria-labelledby'] === 'plans',
    ),
  );
  const section = only(sections, 'embedded plans section');
  const items = elementsIn(
    section.props as JsonValue,
    byId,
    (element) =>
      element.type === 'li' && typeof element.props['data-name'] === 'string',
  );
  return items.map((item) => {
    if (item.key === null) {
      throw new PageParseError('an embedded plan row has no key');
    }
    const holders: JsonObject[] = [];
    walk(item.props as JsonValue, byId, (value) => {
      if (isJsonObject(value) && Object.hasOwn(value, 'official')) {
        holders.push(value);
      }
    });
    const holder = only(holders, `price in the plan row ${item.key}`);
    const official = holder.official;
    if (!isJsonObject(official)) {
      throw new PageParseError(
        `the plan row ${item.key} has no official price`,
      );
    }
    if (!Object.hasOwn(holder, 'usd')) {
      throw new PageParseError(`the plan row ${item.key} has no USD figure`);
    }
    return {
      key: item.key,
      dataName: item.props['data-name'] as string,
      official,
      usd: holder.usd,
    };
  });
}

/**
 * A country × service page: every row of "All plans in <country>"
 * (`section[aria-labelledby="plans"]`). The price, currency, period and USD
 * figure come from the embedded `official` and `usd` props and the row's
 * `"<plan>-<period>"` key; the displayed text gives `price_source_text`, and
 * its number must equal the embedded amount; the JSON-LD `Dataset` gives the
 * "last checked" date. Any disagreement fails the page.
 */
export function readCountryServicePage(
  html: string,
  page: { url: string; market: string },
): CountryServicePage {
  const document = parseHtml(html);
  const section = only(
    findAll(
      document,
      (element) =>
        element.name === 'section' &&
        attribute(element, 'aria-labelledby') === 'plans',
    ),
    'plans section',
  );
  const visibleRows = findAll(
    section,
    (element) =>
      element.name === 'li' && attribute(element, 'data-name') !== undefined,
  );
  const embedded = embeddedRows(document);
  if (visibleRows.length === 0) {
    throw new PageParseError('the plans section lists no plan');
  }
  if (visibleRows.length !== embedded.length) {
    throw new PageParseError(
      `the page shows ${visibleRows.length} plans, its embedded data ${embedded.length}`,
    );
  }

  const keys = new Set<string>();
  const rows = embedded.map((row, index): PlanRow => {
    const visible = visibleRows[index];
    if (attribute(visible, 'data-name') !== row.dataName) {
      throw new PageParseError(
        `plan row ${index + 1} is ${JSON.stringify(attribute(visible, 'data-name'))} on the page and ${JSON.stringify(row.dataName)} in its data`,
      );
    }
    if (keys.has(row.key)) {
      throw new PageParseError(`the plan row ${row.key} appears twice`);
    }
    keys.add(row.key);
    const key = rowKeyPattern.exec(row.key);
    if (!key) {
      throw new PageParseError(`the plan row key ${row.key} names no period`);
    }
    const billingPeriod = key[2] as BillingPeriod;
    const { amount, currency, yearly } = row.official;
    if (
      !(amount instanceof JsonNumber) ||
      typeof currency !== 'string' ||
      typeof yearly !== 'boolean'
    ) {
      throw new PageParseError(`the plan row ${row.key} has a malformed price`);
    }
    if (yearly !== (billingPeriod === 'year')) {
      throw new PageParseError(
        `the plan row ${row.key} disagrees with its own yearly flag`,
      );
    }
    const priceLocal = decimal(
      amount.text,
      currency,
      `the amount of ${row.key}`,
    );

    const subText = textOf(visible, 'prow-sub');
    const priceSourceText = periodSuffix.exec(subText)?.[1] ?? subText;
    let shownMatches = false;
    try {
      const shown = parseMoney(priceSourceText, { currency });
      shownMatches = equals(shown.money, parseDecimal(amount.text, currency));
    } catch (error) {
      if (!(error instanceof MoneyError)) {
        throw error;
      }
    }
    if (!shownMatches) {
      throw new PageParseError(
        `the displayed price ${JSON.stringify(priceSourceText)} of ${row.key} is not ${amount.text} ${currency}`,
      );
    }

    let priceUsd: string | null = null;
    if (row.usd instanceof JsonNumber) {
      priceUsd = decimal(row.usd.text, 'USD', `the USD figure of ${row.key}`);
    } else if (row.usd !== null) {
      throw new PageParseError(
        `the plan row ${row.key} has a malformed USD figure`,
      );
    }
    return {
      key: key[1],
      name: textOf(visible, 'prow-title'),
      billingPeriod,
      priceLocal,
      currency,
      priceSourceText,
      priceUsd,
    };
  });

  const dataset = only(
    jsonLd(document, 'Dataset'),
    'JSON-LD Dataset',
  ) as Record<string, unknown>;
  if (dataset.url !== page.url) {
    throw new PageParseError(
      `the JSON-LD Dataset is for ${JSON.stringify(dataset.url)}, not this page`,
    );
  }
  const coverage = dataset.spatialCoverage;
  if (
    typeof coverage === 'object' &&
    coverage !== null &&
    'identifier' in coverage &&
    coverage.identifier !== page.market
  ) {
    throw new PageParseError(
      `the page covers ${JSON.stringify(coverage.identifier)}, not ${page.market}`,
    );
  }
  const verifiedAt = dataset.dateModified;
  if (
    typeof verifiedAt !== 'string' ||
    !isoDate.safeParse(verifiedAt).success
  ) {
    throw new PageParseError('the JSON-LD Dataset has no "last checked" date');
  }
  return { verifiedAt, rows };
}

// ------------------------------------------------------------ price moves

export interface RawPriceMove {
  readonly service: string;
  readonly plan: string;
  readonly country: string;
  readonly period: string;
  readonly currency: string;
  readonly oldPrice: string;
  readonly newPrice: string;
  readonly date: string;
  readonly afterDate: string | null;
  readonly evidenceUrl: string;
  readonly flag: boolean;
  readonly oldUsd: string | null;
  readonly newUsd: string | null;
}

function moveField<T>(
  row: readonly JsonValue[],
  index: number,
  test: (value: JsonValue) => value is T & JsonValue,
  what: string,
  position: number,
): T {
  const value = row[index];
  if (!test(value)) {
    throw new PageParseError(`price move ${position} has a malformed ${what}`);
  }
  return value;
}

const isString = (value: JsonValue): value is string =>
  typeof value === 'string';
const isNumber = (value: JsonValue): value is JsonNumber =>
  value instanceof JsonNumber;
const isDate = (value: JsonValue): value is string =>
  typeof value === 'string' && isoDate.safeParse(value).success;

/** "Price moves": the embedded `rows` prop, every row, newest first. */
export function readPriceMoves(html: string): RawPriceMove[] {
  const { values } = flightRows(parseHtml(html));
  const lists: JsonValue[][] = [];
  for (const value of values) {
    walk(value, new Map(), (candidate) => {
      if (
        isJsonObject(candidate) &&
        Object.hasOwn(candidate, 'rows') &&
        Array.isArray(candidate.rows)
      ) {
        lists.push(candidate.rows);
      }
    });
  }
  const rows = only(lists, 'embedded list of price moves');
  if (rows.length === 0) {
    throw new PageParseError('the list of price moves is empty');
  }
  return rows.map((row, index) => {
    const position = index + 1;
    if (!Array.isArray(row) || row.length !== 13) {
      throw new PageParseError(`price move ${position} is not a 13-field row`);
    }
    const currency = moveField(row, 4, isString, 'currency', position);
    const flag = moveField(row, 10, isNumber, 'flag', position);
    if (flag.text !== '0' && flag.text !== '1') {
      throw new PageParseError(`price move ${position} has a malformed flag`);
    }
    const usd = (field: number, what: string): string | null => {
      const value = row[field];
      if (value === null) {
        return null;
      }
      if (!(value instanceof JsonNumber)) {
        throw new PageParseError(
          `price move ${position} has a malformed ${what}`,
        );
      }
      return decimal(
        value.text,
        'USD',
        `the ${what} of price move ${position}`,
      );
    };
    const afterDate = row[8];
    if (afterDate !== null && !isDate(afterDate)) {
      throw new PageParseError(
        `price move ${position} has a malformed "after" date`,
      );
    }
    const country = moveField(row, 2, isString, 'country', position);
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new PageParseError(
        `price move ${position} has a malformed country`,
      );
    }
    return {
      service: moveField(row, 0, isString, 'service', position),
      plan: moveField(row, 1, isString, 'plan', position),
      country,
      period: moveField(row, 3, isString, 'period', position),
      currency,
      oldPrice: decimal(
        moveField(row, 5, isNumber, 'old price', position).text,
        currency,
        `the old price of price move ${position}`,
      ),
      newPrice: decimal(
        moveField(row, 6, isNumber, 'new price', position).text,
        currency,
        `the new price of price move ${position}`,
      ),
      date: moveField(row, 7, isDate, 'date', position),
      afterDate,
      evidenceUrl: moveField(row, 9, isString, 'evidence URL', position),
      flag: flag.text === '1',
      oldUsd: usd(11, 'old USD figure'),
      newUsd: usd(12, 'new USD figure'),
    };
  });
}
