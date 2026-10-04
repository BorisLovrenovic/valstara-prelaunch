import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { dsrCopy } from '../../src/copy/dsr.ts';
import { giveawayAwardCopy } from '../../src/copy/giveaway-award.ts';
import { landingCopy } from '../../src/copy/landing.ts';
import { leaderboardCopy } from '../../src/copy/leaderboard.ts';
import { legalPageCopy } from '../../src/copy/legal.ts';
import { memberStatusCopy } from '../../src/copy/member-status.ts';
import { seoCopy } from '../../src/copy/seo.ts';
import { unsubscribeCopy } from '../../src/copy/unsubscribe.ts';
import { verificationCopy } from '../../src/copy/verification.ts';
import {
  routeFromPageFile,
  canonicalUrl,
  rulesPageMetadata,
  socialFallbackImageUrl,
  socialImageUrl,
  socialPageKind,
  socialPageKinds,
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

export async function collectSeoPages(
  root = projectRoot,
  requireAllRoutes = true,
): Promise<{
  routes: string[];
  pages: PageMetadata[];
}> {
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
  validatePageMetadata(
    requireAllRoutes
      ? [...routes, ...publishedRoutes]
      : pages.map((metadata) => metadata.pathname),
    pages,
  );
  return { routes, pages };
}

function tokenValue(tokens: string, name: string): string {
  const value = new RegExp(`--${name}:\\s*([^;]+);`, 'u').exec(tokens)?.[1];
  if (!value) throw new Error(`Social card token is missing: ${name}`);
  return value.trim();
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function titleLines(title: string): string[] {
  const lines: string[] = [];
  let line = '';
  const words = title.trim().split(/\s+/u);
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 20 && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 3) {
    const remainder = lines.slice(2).join(' ');
    const suffix = words.at(-1) ?? '';
    lines.splice(
      2,
      lines.length - 2,
      suffix.length > 20
        ? `…${suffix}`
        : `…${remainder.slice(-17).trimStart()}`,
    );
  }
  return lines;
}

export function socialCardSvg(
  title: string,
  tokens: { paper: string; ink: string; coral: string; font: string },
): string {
  const lines = titleLines(title);
  const titleMarkup = lines
    .map(
      (line, index) =>
        `<tspan x="112" y="${252 + index * 82}" textLength="${Math.min(830, line.length * 34)}" lengthAdjust="spacingAndGlyphs">${xml(line)}</tspan>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${xml(tokens.paper)}"/><path d="M944 0h256v150z" fill="${xml(tokens.coral)}"/><circle cx="1120" cy="518" r="80" fill="${xml(tokens.coral)}"/><rect x="104" y="88" width="128" height="12" rx="6" fill="${xml(tokens.coral)}"/><text x="112" y="${252 + (lines.length - 1) * 82}" fill="${xml(tokens.ink)}" font-family="${xml(tokens.font)}" font-size="64" font-weight="650">${titleMarkup}</text><text x="112" y="548" fill="${xml(tokens.ink)}" font-family="${xml(tokens.font)}" font-size="30" font-weight="600">${xml(seoCopy.organisationName)}</text></svg>`;
}

function sfntFromWoff(woff: Buffer): Buffer {
  if (woff.toString('ascii', 0, 4) !== 'wOFF') {
    throw new Error('Social card font must be a WOFF file');
  }
  const tableCount = woff.readUInt16BE(12);
  const sfnt = Buffer.alloc(woff.readUInt32BE(16));
  woff.copy(sfnt, 0, 4, 8);
  sfnt.writeUInt16BE(tableCount, 4);
  const entrySelector = Math.floor(Math.log2(tableCount));
  const searchRange = 16 * 2 ** entrySelector;
  sfnt.writeUInt16BE(searchRange, 6);
  sfnt.writeUInt16BE(entrySelector, 8);
  sfnt.writeUInt16BE(tableCount * 16 - searchRange, 10);
  let outputOffset = 12 + tableCount * 16;
  for (let index = 0; index < tableCount; index += 1) {
    const inputOffset = 44 + index * 20;
    const offset = woff.readUInt32BE(inputOffset + 4);
    const compressedLength = woff.readUInt32BE(inputOffset + 8);
    const originalLength = woff.readUInt32BE(inputOffset + 12);
    const compressed = woff.subarray(offset, offset + compressedLength);
    const table =
      compressedLength === originalLength
        ? compressed
        : inflateSync(compressed);
    if (table.length !== originalLength)
      throw new Error('Social card font table is invalid');
    woff.copy(sfnt, 12 + index * 16, inputOffset, inputOffset + 4);
    sfnt.writeUInt32BE(woff.readUInt32BE(inputOffset + 16), 16 + index * 16);
    sfnt.writeUInt32BE(outputOffset, 20 + index * 16);
    sfnt.writeUInt32BE(originalLength, 24 + index * 16);
    table.copy(sfnt, outputOffset);
    outputOffset += Math.ceil(originalLength / 4) * 4;
  }
  if (outputOffset !== sfnt.length)
    throw new Error('Social card font size is invalid');
  return sfnt;
}

async function loadSocialCardFont(
  root: string,
  tokenSource: string,
  font: string,
  directory: string,
): Promise<void> {
  const family = /^['"]([^'"]+)['"]/u.exec(font)?.[1];
  const face = [...tokenSource.matchAll(/@font-face\s*\{([^}]+)\}/gu)]
    .map((match) => match[1])
    .find((block) => block.includes(`font-family: '${family}'`));
  const path =
    face && /url\(['"]?(\/fonts\/[^'")]+\.woff)['"]?\)/u.exec(face)?.[1];
  if (!family || !path)
    throw new Error('Social card brand font source is missing');
  const fontfile = join(directory, 'brand-font.ttf');
  await writeFile(
    fontfile,
    sfntFromWoff(await readFile(join(root, 'public', path.slice(1)))),
  );
  await sharp({
    text: { text: seoCopy.organisationName, font: `${family} 30`, fontfile },
  })
    .png()
    .toBuffer();
}

export async function generateOpenGraphImages(
  root = projectRoot,
): Promise<void> {
  // Invalid/new route fixtures are left for Astro's parser during the build;
  // the strict postbuild metadata check still requires coverage for every route.
  const { pages } = await collectSeoPages(root, false);
  const outputDirectory = join(root, 'public/images/og');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(join(outputDirectory, 'fallback'), { recursive: true });
  const tokenSource = await readFile(
    join(root, 'src/styles/tokens.css'),
    'utf8',
  );
  const tokens = {
    paper: tokenValue(tokenSource, 'paper'),
    ink: tokenValue(tokenSource, 'ink'),
    coral: tokenValue(tokenSource, 'coral'),
    font: tokenValue(tokenSource, 'font-sans'),
  };
  const fontDirectory = await mkdtemp(join(tmpdir(), 'valstara-og-font-'));
  try {
    await loadSocialCardFont(root, tokenSource, tokens.font, fontDirectory);
    const generatedKinds = new Set<string>();
    for (const page of pages) {
      const imagePath = new URL(socialImageUrl(page.pathname)).pathname;
      const outputPath = join(root, 'public', imagePath.slice(1));
      await sharp(Buffer.from(socialCardSvg(page.title, tokens)))
        .png({ compressionLevel: 9 })
        .toFile(outputPath);
      generatedKinds.add(socialPageKind(page.pathname));
    }
    for (const kind of socialPageKinds) {
      const fallbackTitle = seoCopy.socialCardFallbacks[kind];
      if (!fallbackTitle)
        throw new Error(`Social card fallback is missing: ${kind}`);
      const outputPath = join(outputDirectory, 'fallback', `${kind}.png`);
      await sharp(Buffer.from(socialCardSvg(fallbackTitle, tokens)))
        .png({ compressionLevel: 9 })
        .toFile(outputPath);
    }
    if (generatedKinds.size !== socialPageKinds.length) {
      throw new Error('Social card generation is missing a page kind');
    }
  } finally {
    await rm(fontDirectory, { recursive: true, force: true });
  }
}

export async function checkSeoBuild(
  root = projectRoot,
  checkRendered = false,
): Promise<void> {
  const { pages } = await collectSeoPages(root);
  const pageDirectory = join(root, 'src/pages');
  const files = (await readdir(pageDirectory, { recursive: true })).filter(
    (file) => file.endsWith('.astro'),
  );

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

  if (checkRendered) {
    const renderedDirectory = join(root, 'dist/client');
    const renderedFiles = (
      await readdir(renderedDirectory, { recursive: true })
    ).filter((file) => file.endsWith('/index.html'));
    if (renderedFiles.length === 0) {
      throw new Error('SEO rendered pages are missing');
    }
    const renderedTitles = new Set<string>();
    const renderedDescriptions = new Set<string>();
    for (const file of renderedFiles) {
      const pathname = `/${file.slice(0, -'/index.html'.length)}`;
      if (!pages.some((metadata) => metadata.pathname === pathname)) {
        throw new Error(`SEO rendered route is unknown: ${pathname}`);
      }
      const html = await readFile(join(renderedDirectory, file), 'utf8');
      const head = /<head\b[^>]*>([\s\S]*?)<\/head>/u.exec(html)?.[1] ?? '';
      const titles = [...head.matchAll(/<title>([^<]*)<\/title>/gu)];
      const descriptions = [
        ...head.matchAll(
          /<meta\s+name="description"\s+content="([^"]*)"\s*\/?>/gu,
        ),
      ];
      const canonicals = [
        ...head.matchAll(/<link\s+rel="canonical"\s+href="([^"]*)"\s*\/?>/gu),
      ];
      const title = titles[0]?.[1].trim();
      const description = descriptions[0]?.[1].trim();
      if (titles.length !== 1 || !title || renderedTitles.has(title)) {
        throw new Error(
          `SEO rendered title is missing or duplicated for ${pathname}`,
        );
      }
      if (
        descriptions.length !== 1 ||
        !description ||
        renderedDescriptions.has(description)
      ) {
        throw new Error(
          `SEO rendered description is missing or duplicated for ${pathname}`,
        );
      }
      if (
        canonicals.length !== 1 ||
        canonicals[0][1] !== canonicalUrl(pathname)
      ) {
        throw new Error(
          `SEO rendered canonical is missing or invalid for ${pathname}`,
        );
      }
      const socialImages = [
        ...head.matchAll(
          /<meta\s+property="og:image"\s+content="([^"]+)"\s*\/?>/gu,
        ),
      ].map((match) => match[1]);
      const twitterCard =
        /<meta\s+name="twitter:card"\s+content="([^"]+)"\s*\/?>/u.exec(
          head,
        )?.[1];
      if (
        socialImages[0] !== socialImageUrl(pathname) ||
        socialImages[1] !== socialFallbackImageUrl(socialPageKind(pathname)) ||
        twitterCard !== 'summary_large_image'
      ) {
        throw new Error(`SEO social card metadata is missing for ${pathname}`);
      }
      renderedTitles.add(title);
      renderedDescriptions.add(description);
    }
    for (const page of pages) {
      const imagePath = join(
        root,
        'dist/client',
        new URL(socialImageUrl(page.pathname)).pathname.slice(1),
      );
      try {
        await access(imagePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const fallbackPath = join(
          root,
          'dist/client',
          new URL(
            socialFallbackImageUrl(socialPageKind(page.pathname)),
          ).pathname.slice(1),
        );
        await copyFile(fallbackPath, imagePath);
      }
    }
    const assets = new Set<string>();
    for (const page of pages) {
      assets.add(socialImageUrl(page.pathname));
      assets.add(socialFallbackImageUrl(socialPageKind(page.pathname)));
    }
    for (const asset of assets) {
      const imagePath = new URL(asset).pathname;
      const image = await sharp(
        join(root, 'dist/client', imagePath.slice(1)),
      ).metadata();
      if (
        image.format !== 'png' ||
        image.width !== 1200 ||
        image.height !== 630
      ) {
        throw new Error(
          `SEO social card image is missing or invalid: ${imagePath}`,
        );
      }
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
  if (process.argv.includes('--check')) await checkSeoBuild(projectRoot, true);
  else if (process.argv.includes('--sitemap')) {
    await generateSitemap();
    await generateOpenGraphImages();
  }
}
