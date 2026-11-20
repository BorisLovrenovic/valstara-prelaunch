import { canonicalUrl } from '../../src/server/seo.ts';

// Strict checks of the price pages' JSON-LD against schema.org, as search
// engines read it. Only the fields this site writes are allowed, so an added
// claim must be added here deliberately. Dataset moved here from
// test/price-index/price-index-pages.test.ts (E11.6-13) when the E11.6-16
// audit came to validate it on the served `/price-index` too; FAQPage's
// check is test/helpers/faq-page-data.mjs.
// Exports only: node --test runs every file under test/, helpers included.

const isoDate = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;

/**
 * Every way a Dataset JSON-LD object falls short of schema.org's Dataset as
 * search engines read it: the required name and description (50 to 5,000
 * characters), and well-formed optional fields.
 */
export function datasetIssues(data) {
  if (typeof data !== 'object' || data === null) return ['not an object'];
  const value = data;
  const issues = [];
  const allowed = new Set([
    '@context',
    '@type',
    'name',
    'description',
    'url',
    'temporalCoverage',
    'spatialCoverage',
    'dateModified',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`unexpected field ${key}`);
  }
  if (value['@context'] !== 'https://schema.org') issues.push('@context');
  if (value['@type'] !== 'Dataset') issues.push('@type');
  if (typeof value.name !== 'string' || value.name.trim() === '') {
    issues.push('name');
  }
  if (
    typeof value.description !== 'string' ||
    value.description.length < 50 ||
    value.description.length > 5000
  ) {
    issues.push('description');
  }
  if (value.url !== canonicalUrl('/price-index')) issues.push('url');
  const coverage = value.temporalCoverage;
  const [start, end, ...rest] =
    typeof coverage === 'string' ? coverage.split('/') : [];
  if (
    start === undefined ||
    !isoDate.test(start) ||
    (end !== undefined && (!isoDate.test(end) || end < start)) ||
    rest.length > 0
  ) {
    issues.push('temporalCoverage');
  }
  const places = value.spatialCoverage;
  if (
    !Array.isArray(places) ||
    places.length === 0 ||
    places.some(
      (place) =>
        typeof place !== 'object' ||
        place === null ||
        place['@type'] !== 'Country' ||
        typeof place.name !== 'string' ||
        !/^[A-Z]{2}$/u.test(String(place.identifier)) ||
        Object.keys(place).length !== 3,
    )
  ) {
    issues.push('spatialCoverage');
  }
  if (
    typeof value.dateModified !== 'string' ||
    !isoDate.test(value.dateModified)
  ) {
    issues.push('dateModified');
  }
  if (JSON.stringify(value).match(/:\s*-?\d/u)) issues.push('a number');
  return issues;
}

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Every way a BreadcrumbList JSON-LD object falls short of schema.org's
 * BreadcrumbList as search engines read it: an `@context` of schema.org, and
 * a non-empty `itemListElement` of ListItems numbered from 1 in order, each
 * with a non-empty `name` and an absolute `item` URL on the site. The last
 * item is the page itself (`pathname`'s canonical URL). Nothing else is
 * allowed.
 */
export function breadcrumbListIssues(data, pathname) {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return ['not an object'];
  const issues = [];
  for (const key of Object.keys(data)) {
    if (!['@context', '@type', 'itemListElement'].includes(key))
      issues.push(`unexpected field ${key}`);
  }
  if (data['@context'] !== 'https://schema.org') issues.push('@context');
  if (data['@type'] !== 'BreadcrumbList') issues.push('@type');
  const items = data.itemListElement;
  if (!Array.isArray(items) || items.length === 0) {
    issues.push('itemListElement is not a non-empty list');
    return issues;
  }
  items.forEach((item, index) => {
    const where = `itemListElement[${index}]`;
    if (typeof item !== 'object' || item === null) {
      issues.push(`${where} is not an object`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!['@type', 'position', 'name', 'item'].includes(key))
        issues.push(`${where} has an unexpected ${key}`);
    }
    if (item['@type'] !== 'ListItem') issues.push(`${where} is not a ListItem`);
    if (item.position !== index + 1) issues.push(`${where} is out of order`);
    if (!nonEmpty(item.name)) issues.push(`${where} has no name`);
    let url = null;
    try {
      url = new URL(item.item);
    } catch {
      issues.push(`${where} has no absolute item URL`);
    }
    if (url !== null && url.href !== canonicalUrl(url.pathname))
      issues.push(`${where} is not a canonical site URL`);
  });
  if (items.at(-1)?.item !== canonicalUrl(pathname))
    issues.push('the last item is not the page itself');
  return issues;
}
