import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// The E11-05 rendered-page inventory: every `.astro` page under `src/pages`,
// with the rules-revision route expanded to every published revision. The
// privacy audit crawls it, and E11.5-12 asserts the enforced layout-check set
// equals it, so both read the one derivation.
//
// E11.6-10: a data route is a page file whose pages come from the price
// data, not from the file tree. The repository's data has none before the
// founder's first run and hundreds after it, so it is listed apart, as its
// route pattern, in `dataRoutes`; the E11-05 audit crawls each data route's
// page kinds on the price fixture site (test/helpers/price-fixture-site.mjs).
// E11.6-12: `/prices` and the hubs are price routes too: their content and
// whether they exist come from the price data.
export const dataRouteFiles = new Map([
  ['prices/[service]/[country].astro', '/prices/[service]/[country]'],
  ['prices/index.astro', '/prices'],
  ['prices/[service]/index.astro', '/prices/[service]'],
  ['prices/countries/[country].astro', '/prices/countries/[country]'],
]);

export async function sourcePagePaths() {
  const pages = await readdir(`${root}/src/pages`, { recursive: true });
  const astro = pages.filter((path) => path.endsWith('.astro')).sort();
  const revisionFiles = await readdir(`${root}/src/content/giveaway-rules`);
  const revisions = revisionFiles
    .filter((path) => path.endsWith('.md'))
    .map((path) => path.slice(0, -3))
    .sort();
  assert.ok(revisions.length > 0, 'rules revisions must be inventoried');
  const dataRoutes = astro
    .filter((path) => dataRouteFiles.has(path))
    .map((path) => dataRouteFiles.get(path));
  const routes = astro.flatMap((path) => {
    if (dataRouteFiles.has(path)) return [];
    const route =
      `/${path.replace(/\.astro$/u, '').replace(/(?:^|\/)index$/u, '')}`.replace(
        /\/$/u,
        '',
      ) || '/';
    if (path === 'giveaway/rules/[rulesVersion].astro') {
      return revisions.map((version) => `/giveaway/rules/${version}`);
    }
    assert.ok(!route.includes('['), `unexpanded page route: ${route}`);
    return [route];
  });
  return { astro, routes: [...new Set(routes)].sort(), dataRoutes };
}
