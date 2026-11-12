import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// The E11-05 rendered-page inventory: every `.astro` page under `src/pages`,
// with the rules-revision route expanded to every published revision. The
// privacy audit crawls it, and E11.5-12 asserts the enforced layout-check set
// equals it, so both read the one derivation.
export async function sourcePagePaths() {
  const pages = await readdir(`${root}/src/pages`, { recursive: true });
  const astro = pages.filter((path) => path.endsWith('.astro')).sort();
  const revisionFiles = await readdir(`${root}/src/content/giveaway-rules`);
  const revisions = revisionFiles
    .filter((path) => path.endsWith('.md'))
    .map((path) => path.slice(0, -3))
    .sort();
  assert.ok(revisions.length > 0, 'rules revisions must be inventoried');
  const routes = astro.flatMap((path) => {
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
  return { astro, routes: [...new Set(routes)].sort() };
}
