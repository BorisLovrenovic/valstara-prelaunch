import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dsrCopy } from '../../src/copy/dsr.ts';
import { giveawayAwardCopy } from '../../src/copy/giveaway-award.ts';
import { landingCopy } from '../../src/copy/landing.ts';
import { leaderboardCopy } from '../../src/copy/leaderboard.ts';
import { legalPageCopy } from '../../src/copy/legal.ts';
import { memberStatusCopy } from '../../src/copy/member-status.ts';
import { unsubscribeCopy } from '../../src/copy/unsubscribe.ts';
import { verificationCopy } from '../../src/copy/verification.ts';
import {
  routeFromPageFile,
  canonicalUrl,
  rulesPageMetadata,
  sitemapPaths,
  validatePageMetadata,
  type PageMetadata,
} from '../../src/server/seo.ts';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const pageBindings: Record<string, string> = {
  '/': 'landingCopy.meta',
  '/about': 'entry.data',
  '/dsr': 'dsrCopy',
  '/giveaway/award': 'copy.meta',
  '/guarantee': 'entry.data',
  '/leaderboard': 'leaderboardCopy.meta',
  '/legit': 'entry.data',
  '/me': 'memberStatusCopy.meta',
  '/privacy': 'legalPageCopy.privacy',
  '/privacy/storage': 'legalPageCopy.storage',
  '/terms': 'legalPageCopy.terms',
  '/unsubscribe': 'unsubscribeCopy.meta',
  '/verify': 'verificationCopy.meta',
};

function frontmatterField(source: string, name: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source)?.[1] ?? '';
  const value =
    new RegExp(`^${name}:\\s*(.*)$`, 'mu').exec(frontmatter)?.[1]?.trim() ?? '';
  return value.replace(/^['"]|['"]$/gu, '');
}

function page(
  pathname: string,
  metadata: { title: string; description: string },
): PageMetadata {
  return { pathname, ...metadata };
}

export async function checkSeoBuild(root = projectRoot): Promise<void> {
  const pageDirectory = join(root, 'src/pages');
  const files = (await readdir(pageDirectory, { recursive: true })).filter(
    (file) => file.endsWith('.astro'),
  );
  const routes = files
    .map((file) => routeFromPageFile(`src/pages/${file}`))
    .filter((route): route is string => route !== null && !route.includes('['));
  const trustPaths = ['legit', 'guarantee', 'about'] as const;
  const trust = await Promise.all(
    trustPaths.map(async (name) => {
      const source = await readFile(
        join(root, `src/content/${name}.md`),
        'utf8',
      );
      return page(`/${name}`, {
        title: frontmatterField(source, 'title'),
        description: frontmatterField(source, 'description'),
      });
    }),
  );
  const rulesDirectory = join(root, 'src/content/giveaway-rules');
  const ruleFiles = (await readdir(rulesDirectory)).filter((file) =>
    file.endsWith('.md'),
  );
  const revisions = await Promise.all(
    ruleFiles.map(async (file) => {
      const source = await readFile(join(rulesDirectory, file), 'utf8');
      return {
        rulesVersion: frontmatterField(source, 'rulesVersion'),
        title: frontmatterField(source, 'title'),
        description: frontmatterField(source, 'description'),
        publishedOn: frontmatterField(source, 'publishedOn'),
      };
    }),
  );
  const current = revisions
    .toSorted((a, b) => a.publishedOn.localeCompare(b.publishedOn))
    .at(-1);
  if (!current) throw new Error('SEO metadata is missing for /giveaway/rules');
  const pages: PageMetadata[] = [
    page('/', landingCopy.meta),
    ...trust,
    page('/terms', legalPageCopy.terms),
    page('/privacy', legalPageCopy.privacy),
    page('/privacy/storage', legalPageCopy.storage),
    page('/leaderboard', leaderboardCopy.meta),
    page('/me', memberStatusCopy.meta),
    page('/verify', verificationCopy.meta),
    page('/unsubscribe', unsubscribeCopy.meta),
    page('/dsr', dsrCopy),
    page('/giveaway/award', giveawayAwardCopy.meta),
    page('/giveaway/rules', rulesPageMetadata(current, true)),
    ...revisions.map((revision) =>
      page(
        `/giveaway/rules/${revision.rulesVersion}`,
        rulesPageMetadata(revision, false),
      ),
    ),
  ];
  const publishedRoutes = revisions.map(
    (revision) => `/giveaway/rules/${revision.rulesVersion}`,
  );
  validatePageMetadata([...routes, ...publishedRoutes], pages);

  for (const file of files) {
    if (file.includes('[') && file !== 'giveaway/rules/[rulesVersion].astro') {
      throw new Error(`SEO route expansion is missing for ${file}`);
    }
    if (file.startsWith('api/') || file.startsWith('giveaway/rules/')) continue;
    const source = await readFile(join(pageDirectory, file), 'utf8');
    const pathname = routeFromPageFile(`src/pages/${file}`);
    const binding = pathname === null ? undefined : pageBindings[pathname];
    if (
      !binding ||
      !source.includes(`title={${binding}.title}`) ||
      !source.includes(`description={${binding}.description}`)
    ) {
      throw new Error(`SEO layout metadata binding is missing in ${file}`);
    }
  }
}

export async function generateSitemap(root = projectRoot): Promise<void> {
  const files = (await readdir(join(root, 'src/pages'), { recursive: true }))
    .filter((file) => file.endsWith('.astro'))
    .map((file) => `src/pages/${file}`);
  const versions = (await readdir(join(root, 'src/content/giveaway-rules')))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -3));
  const urls = sitemapPaths(files, versions)
    .map((path) => `  <url><loc>${canonicalUrl(path)}</loc></url>`)
    .join('\n');
  await writeFile(
    join(root, 'public/sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(`file://${process.argv[1]}`))
) {
  if (process.argv.includes('--check')) await checkSeoBuild();
  else if (process.argv.includes('--sitemap')) await generateSitemap();
}
