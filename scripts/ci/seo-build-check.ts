import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { dsrCopy } from '../../src/copy/dsr.ts';
import { errorPagesCopy } from '../../src/copy/error-pages.ts';
import { giveawayAwardCopy } from '../../src/copy/giveaway-award.ts';
import { landingCopy } from '../../src/copy/landing.ts';
import { leaderboardCopy } from '../../src/copy/leaderboard.ts';
import { legalPageCopy } from '../../src/copy/legal.ts';
import { memberStatusCopy } from '../../src/copy/member-status.ts';
import { partnerDashboardCopy } from '../../src/copy/partner-dashboard.ts';
import { partnersCopy } from '../../src/copy/partners.ts';
import { pricesCopy } from '../../src/copy/prices.ts';
import { seoCopy } from '../../src/copy/seo.ts';
import { unsubscribeCopy } from '../../src/copy/unsubscribe.ts';
import { verificationCopy } from '../../src/copy/verification.ts';
import { partnerProgrammeContent } from '../../src/server/partner/programme-content.ts';
import { readPriceSiteInputs } from '../../src/server/prices/files.ts';
import {
  createPriceSite,
  type PriceRoute,
} from '../../src/server/prices/site.ts';
import {
  childSitemaps,
  routeFromPageFile,
  canonicalUrl,
  rulesPageMetadata,
  sitemapIndexXml,
  urlsetXml,
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
  '/404': 'errorPagesCopy.notFound.meta',
  '/500': 'errorPagesCopy.serverError.meta',
  '/about': 'entry.data',
  '/dsr': 'dsrCopy',
  '/giveaway/award': 'copy.meta',
  '/guarantee': 'entry.data',
  '/leaderboard': 'leaderboardCopy.meta',
  '/legit': 'entry.data',
  '/me': 'memberStatusCopy.meta',
  // E11.7-05: the programme page from its content file, and the application.
  '/partners': 'programme',
  '/partners/apply': 'pageCopy',
  '/partners/dashboard': 'copy',
  // E11.7-11: the print flyer, behind the same private link.
  '/partners/dashboard/flyer': 'copy.flyer',
  '/privacy': 'legalPageCopy.privacy',
  '/privacy/storage': 'legalPageCopy.storage',
  '/terms': 'legalPageCopy.terms',
  '/unsubscribe': 'unsubscribeCopy.meta',
  '/verify': 'verificationCopy.meta',
  // E11.6-10: one binding for every service × market page, generated or
  // unavailable; its metadata comes from the price site's view model.
  '/prices/[service]/[country]': 'view.meta',
  // E11.6-12: `/prices` and the hubs, from the same view model.
  '/prices': 'view.meta',
  '/prices/[service]': 'view.meta',
  '/prices/countries/[country]': 'view.meta',
  // E11.6-13: the methodology from its content file, and each monthly report
  // from the same view model.
  '/price-index': 'entry.data',
  '/price-index/[month]': 'view.meta',
  // E11.8-01: the Trust Ledger, from its "How we count" content file.
  '/trust-ledger': 'entry.data',
};

// The page files whose routes are expanded from data rather than the file
// tree: each published rules revision, each price page the bundled data
// generates or the published-URL ledger holds (E11.6-10), and each service
// and market hub the data makes (E11.6-12), and each monthly report file
// (E11.6-13).
const expandedRouteFiles = new Set([
  'giveaway/rules/[rulesVersion].astro',
  'prices/[service]/[country].astro',
  'prices/[service]/index.astro',
  'prices/countries/[country].astro',
  'price-index/[month].astro',
]);

/**
 * Every price route of the data under `root`, with its metadata: the pages,
 * the hubs and `/prices` (E11.6-12), and the monthly reports (E11.6-13). A
 * retired URL that generates no page answers 301 and has none.
 */
export async function priceSeoPages(root: string): Promise<PageMetadata[]> {
  const site = createPriceSite(await readPriceSiteInputs(root));
  return [...site.routes, ...site.hubs, site.index, ...site.monthlyReports].map(
    (route) => ({
      pathname: route.path,
      ...route.meta,
    }),
  );
}

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
  // E11.6-13: the methodology's metadata is its content file's frontmatter.
  const methodologySource = await readFile(
    join(root, 'src/content/price-index-methodology.md'),
    'utf8',
  );
  const methodology = page('/price-index', {
    title: frontmatterField(methodologySource, 'title'),
    description: frontmatterField(methodologySource, 'description'),
  });
  // E11.8-01: the Trust Ledger's metadata is its "How we count" content
  // file's frontmatter, whether or not an entry is committed yet.
  const trustLedgerSource = await readFile(
    join(root, 'src/content/trust-ledger-how-we-count.md'),
    'utf8',
  );
  const trustLedger = page('/trust-ledger', {
    title: frontmatterField(trustLedgerSource, 'title'),
    description: frontmatterField(trustLedgerSource, 'description'),
  });
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
    trustLedger,
    methodology,
    page('/terms', legalPageCopy.terms),
    page('/privacy', legalPageCopy.privacy),
    page('/privacy/storage', legalPageCopy.storage),
    page('/leaderboard', leaderboardCopy.meta),
    page('/me', memberStatusCopy.meta),
    page('/verify', verificationCopy.meta),
    page('/unsubscribe', unsubscribeCopy.meta),
    page('/dsr', dsrCopy),
    page('/giveaway/award', giveawayAwardCopy.meta),
    page('/partners', partnerProgrammeContent),
    page('/partners/apply', partnersCopy.apply),
    page('/partners/dashboard', partnerDashboardCopy),
    page('/partners/dashboard/flyer', partnerDashboardCopy.flyer),
    page('/404', errorPagesCopy.notFound.meta),
    page('/500', errorPagesCopy.serverError.meta),
    page('/giveaway/rules', rulesPageMetadata(current, true)),
    ...revisions.map((revision) =>
      page(
        `/giveaway/rules/${revision.rulesVersion}`,
        rulesPageMetadata(revision, false),
      ),
    ),
  ];
  // The price route's pages, from the data the build bundles (E11.6-10),
  // with the hubs and `/prices` (E11.6-12).
  const prices = files.includes('prices/[service]/[country].astro')
    ? await priceSeoPages(root)
    : [];
  pages.push(...prices);
  const publishedRoutes = [
    ...revisions.map((revision) => `/giveaway/rules/${revision.rulesVersion}`),
    ...prices.map((price) => price.pathname),
  ];
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

/**
 * A card title in lines of at most 20 characters. Beyond `maxLines`, the
 * last line is shortened to keep the title's final words (E9-07).
 */
function titleLines(title: string, maxLines = 3): string[] {
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
  if (lines.length > maxLines) {
    const remainder = lines.slice(maxLines - 1).join(' ');
    const suffix = words.at(-1) ?? '';
    lines.splice(
      maxLines - 1,
      lines.length - (maxLines - 1),
      suffix.length > 20
        ? `…${suffix}`
        : `…${remainder.slice(-17).trimStart()}`,
    );
  }
  return lines;
}

/** The token values a card is drawn with; `mono` sets a card's price line. */
export interface SocialCardTokens {
  readonly paper: string;
  readonly ink: string;
  readonly coral: string;
  readonly font: string;
  readonly mono?: string;
}

/** The price line's font size: 36 px, smaller only when the line needs it. */
export function priceLineFontSize(priceLine: string): number {
  return Math.min(36, Math.floor(830 / (Array.from(priceLine).length * 0.6)));
}

/** A title line's baseline step, and a card's first and last baselines. */
const titleLineStep = 82;
const titleFirstBaseline = 252;
/** A three-line title's last baseline: where every longer title ends too. */
const titleLastBaseline = titleFirstBaseline + 2 * titleLineStep;

/**
 * A price card's title (D-039 Q1): the page's SEO title without its
 * trailing brand suffix, because the card's wordmark carries the brand.
 */
export function priceCardTitle(seoTitle: string): string {
  const suffix = ` — ${seoCopy.organisationName}`;
  return seoTitle.endsWith(suffix)
    ? seoTitle.slice(0, -suffix.length)
    : seoTitle;
}

/**
 * Draws a card. A price card's title (`priceCard`, D-039 Q1) may take a
 * fourth line, which starts it one line higher, so its last line, the price
 * line and the wordmark keep a three-line card's positions.
 */
export function socialCardSvg(
  title: string,
  tokens: SocialCardTokens,
  priceLine: string | null = null,
  priceCard = false,
): string {
  const lines = titleLines(title, priceCard ? 4 : 3);
  const firstBaseline =
    lines.length > 3
      ? titleLastBaseline - (lines.length - 1) * titleLineStep
      : titleFirstBaseline;
  const lastBaseline = firstBaseline + (lines.length - 1) * titleLineStep;
  const titleMarkup = lines
    .map(
      (line, index) =>
        `<tspan x="112" y="${firstBaseline + index * titleLineStep}" textLength="${Math.min(830, line.length * 34)}" lengthAdjust="spacingAndGlyphs">${xml(line)}</tspan>`,
    )
    .join('');
  // E11.6-14: a service × market card's price line, set in the monospace
  // token below the title (D-038 Q1). A monospace glyph advances 0.6 em, so
  // the font size is chosen to keep the whole line inside the 830 px safe
  // width: the rasteriser does not honour `textLength`.
  let priceMarkup = '';
  if (priceLine !== null) {
    if (!tokens.mono)
      throw new Error('Social card token is missing: font-mono');
    // Placed from the last title baseline, so a four-line title's price
    // line sits where a three-line title's does (D-039 Q1).
    const y = lastBaseline + titleLineStep + 4;
    priceMarkup = `<text x="112" y="${y}" fill="${xml(tokens.ink)}" font-family="${xml(tokens.mono)}" font-size="${priceLineFontSize(priceLine)}" font-weight="600">${xml(priceLine)}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${xml(tokens.paper)}"/><path d="M944 0h256v150z" fill="${xml(tokens.coral)}"/><circle cx="1120" cy="518" r="80" fill="${xml(tokens.coral)}"/><rect x="104" y="88" width="128" height="12" rx="6" fill="${xml(tokens.coral)}"/><text x="112" y="${lastBaseline}" fill="${xml(tokens.ink)}" font-family="${xml(tokens.font)}" font-size="64" font-weight="650">${titleMarkup}</text>${priceMarkup}<text x="112" y="548" fill="${xml(tokens.ink)}" font-family="${xml(tokens.font)}" font-size="30" font-weight="600">${xml(seoCopy.organisationName)}</text></svg>`;
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

interface SocialCardFont {
  readonly family: string;
  readonly bytes: Buffer;
  readonly digest: string;
}

/** The local WOFF source `tokens.css` declares for a font token's family. */
async function socialCardFont(
  root: string,
  tokenSource: string,
  font: string,
): Promise<SocialCardFont> {
  const family = /^['"]([^'"]+)['"]/u.exec(font)?.[1];
  const face = [...tokenSource.matchAll(/@font-face\s*\{([^}]+)\}/gu)]
    .map((match) => match[1])
    .find((block) => block.includes(`font-family: '${family}'`));
  const path =
    face && /url\(['"]?(\/fonts\/[^'")]+\.woff)['"]?\)/u.exec(face)?.[1];
  if (!family || !path)
    throw new Error('Social card brand font source is missing');
  const bytes = await readFile(join(root, 'public', path.slice(1)));
  return {
    family,
    bytes,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

// The fonts this process has made available to the rasteriser, by digest.
const registeredSocialCardFonts = new Set<string>();

/**
 * Makes a font available to the SVG rasteriser for this process. The font
 * file is kept, named by its digest, because the rasteriser reads it again
 * for every later card: deleting it would leave a later render, in the same
 * process, without the brand font.
 */
async function registerSocialCardFont(font: SocialCardFont): Promise<void> {
  if (registeredSocialCardFonts.has(font.digest)) return;
  const directory = join(tmpdir(), 'valstara-og-fonts');
  await mkdir(directory, { recursive: true });
  const fontfile = join(directory, `${font.digest}.ttf`);
  // Written aside and renamed, so a concurrent build never reads half a file.
  const partial = `${fontfile}.${process.pid}.tmp`;
  await writeFile(partial, sfntFromWoff(font.bytes));
  await rename(partial, fontfile);
  await sharp({
    text: {
      text: seoCopy.organisationName,
      font: `${font.family} 30`,
      fontfile,
    },
  })
    .png()
    .toBuffer();
  registeredSocialCardFonts.add(font.digest);
}

/** One card to render: its file under `public/`, its title, its price line. */
export interface SocialCard {
  /** For example `images/og/<page-key>.png` or `images/og/fallback/prices.png`. */
  readonly output: string;
  readonly title: string;
  /** The page's first plan row (D-038 Q1), or null for a title-only card. */
  readonly priceLine: string | null;
  /**
   * A price page's card (E11.6-14): its title may take four lines
   * (D-039 Q1). Absent on E9-07's cards and the typed fallbacks.
   */
  readonly priceCard?: boolean;
}

/**
 * A price page's card (D-039 Q1): the SEO title without its brand suffix,
 * wrapped into at most four lines.
 */
export function priceSocialCard(
  output: string,
  seoTitle: string,
  priceLine: string | null,
): SocialCard {
  return {
    output,
    title: priceCardTitle(seoTitle),
    priceLine,
    priceCard: true,
  };
}

export interface SocialCardStats {
  /** Cards rasterised in this run. */
  readonly rendered: number;
  /** Cards copied from the cache unchanged. */
  readonly reused: number;
}

interface SocialCardManifest {
  readonly version: 1;
  /** Each cached image by content key, with the sha-256 of its PNG bytes. */
  readonly images: Record<string, string>;
  /** Each card file this cache last placed, with the key and text it holds. */
  readonly cards: Record<
    string,
    { key: string; title: string; priceLine: string | null }
  >;
}

/**
 * The card cache (D-038 Q3): rendered PNGs and their manifest, on the
 * building machine only. It sits outside `public/`, so it is never served,
 * and is git-ignored and Docker-ignored, so CI and the image build are cold.
 */
export const socialCardCacheDirectory = '.cache/social-cards';
export const socialCardManifestFile = 'manifest.json';

async function readSocialCardManifest(
  directory: string,
): Promise<SocialCardManifest> {
  try {
    const manifest = JSON.parse(
      await readFile(join(directory, socialCardManifestFile), 'utf8'),
    ) as SocialCardManifest;
    if (
      manifest?.version === 1 &&
      typeof manifest.images === 'object' &&
      typeof manifest.cards === 'object'
    ) {
      return manifest;
    }
  } catch (error) {
    // A missing or unreadable manifest is an empty cache: every card renders.
    if (
      !(error instanceof SyntaxError) &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error;
    }
  }
  return { version: 1, images: {}, cards: {} };
}

const sha256 = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Renders `cards` into `public/` under `root`, reusing every image whose
 * content key is unchanged. The key covers everything that changes a card's
 * pixels: its text, the token values and font file bytes it uses, the card
 * template's source and the rasteriser's version.
 */
export async function renderSocialCards(
  root: string,
  cards: readonly SocialCard[],
  // The card template's source; a test passes its own to change only that.
  templateSource?: Buffer | string,
): Promise<SocialCardStats> {
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
  const sans = await socialCardFont(root, tokenSource, tokens.font);
  const needsMono = cards.some((card) => card.priceLine !== null);
  const mono = needsMono ? tokenValue(tokenSource, 'font-mono') : undefined;
  const monoFont =
    mono === undefined
      ? undefined
      : await socialCardFont(root, tokenSource, mono);
  const template = sha256(
    templateSource ?? (await readFile(fileURLToPath(import.meta.url))),
  );
  const keyOf = (card: SocialCard) =>
    sha256(
      JSON.stringify({
        template,
        rasteriser: sharp.versions,
        organisationName: seoCopy.organisationName,
        title: card.title,
        priceLine: card.priceLine,
        priceCard: card.priceCard === true,
        tokens: card.priceLine === null ? tokens : { ...tokens, mono },
        fonts:
          card.priceLine === null
            ? [sans.digest]
            : [sans.digest, monoFont?.digest],
      }),
    );

  const cacheDirectory = join(root, socialCardCacheDirectory);
  await mkdir(cacheDirectory, { recursive: true });
  const previous = await readSocialCardManifest(cacheDirectory);
  const images: Record<string, string> = {};
  const placed: SocialCardManifest['cards'] = {};
  let fontsRegistered = false;
  let rendered = 0;
  let reused = 0;
  for (const card of cards) {
    const key = keyOf(card);
    const outputPath = join(root, 'public', card.output);
    await mkdir(join(outputPath, '..'), { recursive: true });
    const cachedPath = join(cacheDirectory, `${key}.png`);
    let image: Buffer | null = null;
    const expected = images[key] ?? previous.images[key];
    if (expected !== undefined) {
      try {
        const cached = await readFile(cachedPath);
        if (sha256(cached) === expected) image = cached;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (image === null) {
      if (!fontsRegistered) {
        await registerSocialCardFont(sans);
        if (monoFont !== undefined) await registerSocialCardFont(monoFont);
        fontsRegistered = true;
      }
      image = await sharp(
        Buffer.from(
          socialCardSvg(
            card.title,
            { ...tokens, mono },
            card.priceLine,
            card.priceCard === true,
          ),
        ),
      )
        .png({ compressionLevel: 9 })
        .toBuffer();
      await writeFile(cachedPath, image);
      rendered += 1;
    } else {
      reused += 1;
    }
    images[key] = sha256(image);
    placed[card.output] = {
      key,
      title: card.title,
      priceLine: card.priceLine,
    };
    await writeFile(outputPath, image);
  }
  const manifest: SocialCardManifest = { version: 1, images, cards: placed };
  const temporary = join(cacheDirectory, `${socialCardManifestFile}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, join(cacheDirectory, socialCardManifestFile));
  // Images no card uses any more are dropped, so the cache holds one build.
  for (const file of await readdir(cacheDirectory)) {
    if (file.endsWith('.png') && images[file.slice(0, -4)] === undefined) {
      await rm(join(cacheDirectory, file), { force: true });
    }
  }
  return { rendered, reused };
}

/**
 * A service × market card's price line: the page's first plan row, word for
 * word as its plan table shows it (D-038 Q1). Null for an unavailable URL.
 */
export function priceCardLine(route: PriceRoute): string | null {
  if (route.kind !== 'generated') return null;
  const first = route.rows[0];
  if (first === undefined)
    throw new Error(`Social card price row is missing for ${route.path}`);
  return pricesCopy.page.socialCardLine(
    first.planName,
    first.priceText,
    first.periodText,
  );
}

/** Every card the build serves: one per page with metadata, and fallbacks. */
export async function socialCardsFor(root: string): Promise<SocialCard[]> {
  // Invalid/new route fixtures are left for Astro's parser during the build;
  // the strict postbuild metadata check still requires coverage for every route.
  const { pages } = await collectSeoPages(root, false);
  const files = (
    await readdir(join(root, 'src/pages'), { recursive: true })
  ).filter((file) => file.endsWith('.astro'));
  const priceRoutes = files.includes('prices/[service]/[country].astro')
    ? createPriceSite(await readPriceSiteInputs(root)).routes
    : [];
  const routes = new Map(priceRoutes.map((route) => [route.path, route]));
  const cards: SocialCard[] = [];
  const kinds = new Set<string>();
  for (const page of pages) {
    const route = routes.get(page.pathname);
    // E11.6-14: a ledger URL that publishes no page keeps the typed prices
    // card, copied to its card URL at postbuild (D-038 Q1).
    if (route?.kind === 'unavailable') continue;
    const output = new URL(socialImageUrl(page.pathname)).pathname.slice(1);
    const kind = socialPageKind(page.pathname);
    // D-039 Q1: every price page's card (service × market, hubs, `/prices`,
    // `/price-index`, reports) drops the brand suffix and may take four
    // lines; E9-07's cards are unchanged.
    cards.push(
      kind === 'prices'
        ? priceSocialCard(
            output,
            page.title,
            route === undefined ? null : priceCardLine(route),
          )
        : { output, title: page.title, priceLine: null },
    );
    kinds.add(kind);
  }
  for (const kind of socialPageKinds) {
    const fallbackTitle = seoCopy.socialCardFallbacks[kind];
    if (!fallbackTitle)
      throw new Error(`Social card fallback is missing: ${kind}`);
    cards.push({
      output: new URL(socialFallbackImageUrl(kind)).pathname.slice(1),
      title: fallbackTitle,
      priceLine: null,
    });
  }
  if (socialPageKinds.some((kind) => !kinds.has(kind))) {
    throw new Error('Social card generation is missing a page kind');
  }
  return cards;
}

export async function generateOpenGraphImages(
  root = projectRoot,
): Promise<SocialCardStats> {
  const cards = await socialCardsFor(root);
  await rm(join(root, 'public/images/og'), { recursive: true, force: true });
  return renderSocialCards(root, cards);
}

/**
 * The E9-06 and E9-07 checks on one rendered page's head: exactly one
 * non-empty title and description, each unique among the pages already
 * checked into `seen`; a self-canonical permanent URL; and the page's own
 * social card first, its page kind's typed fallback second, as a large
 * summary card. The postbuild check runs it on every prerendered page;
 * server-rendered pages (the price pages, E11.6-10) run it on their served
 * HTML.
 */
export function checkRenderedHead(
  html: string,
  pathname: string,
  seen: { titles: Set<string>; descriptions: Set<string> },
): void {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/u.exec(html)?.[1] ?? '';
  const titles = [...head.matchAll(/<title>([^<]*)<\/title>/gu)];
  const descriptions = [
    ...head.matchAll(/<meta\s+name="description"\s+content="([^"]*)"\s*\/?>/gu),
  ];
  const canonicals = [
    ...head.matchAll(/<link\s+rel="canonical"\s+href="([^"]*)"\s*\/?>/gu),
  ];
  const title = titles[0]?.[1].trim();
  const description = descriptions[0]?.[1].trim();
  if (titles.length !== 1 || !title || seen.titles.has(title)) {
    throw new Error(
      `SEO rendered title is missing or duplicated for ${pathname}`,
    );
  }
  if (
    descriptions.length !== 1 ||
    !description ||
    seen.descriptions.has(description)
  ) {
    throw new Error(
      `SEO rendered description is missing or duplicated for ${pathname}`,
    );
  }
  if (canonicals.length !== 1 || canonicals[0][1] !== canonicalUrl(pathname)) {
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
    /<meta\s+name="twitter:card"\s+content="([^"]+)"\s*\/?>/u.exec(head)?.[1];
  if (
    socialImages[0] !== socialImageUrl(pathname) ||
    socialImages[1] !== socialFallbackImageUrl(socialPageKind(pathname)) ||
    twitterCard !== 'summary_large_image'
  ) {
    throw new Error(`SEO social card metadata is missing for ${pathname}`);
  }
  seen.titles.add(title);
  seen.descriptions.add(description);
}

/**
 * Copies each page's typed fallback to its card URL in `dist/client` where
 * the build placed no card of its own: a ledger URL that publishes no price
 * page (E11.6-14), or any card lost before postbuild.
 */
export async function copyMissingCardsFromFallback(
  root: string,
  pages: readonly PageMetadata[],
): Promise<string[]> {
  const copied: string[] = [];
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
      copied.push(page.pathname);
    }
  }
  return copied;
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
    if (file.includes('[') && !expandedRouteFiles.has(file)) {
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
      checkRenderedHead(html, pathname, {
        titles: renderedTitles,
        descriptions: renderedDescriptions,
      });
    }
    await copyMissingCardsFromFallback(root, pages);
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
  // E11.6-10: /sitemap.xml is an index over the child sitemaps. The site's
  // own routes keep exactly their previous entries, now in pages.xml. The
  // price sitemap lists the generated service × market pages only, each with
  // its verification date as lastmod: an unavailable ledger URL is noindex
  // and absent.
  const prices = createPriceSite(await readPriceSiteInputs(root));
  await mkdir(join(root, 'public/sitemaps'), { recursive: true });
  await writeFile(
    join(root, 'public', childSitemaps.pages),
    urlsetXml(sitemapPaths(files, versions).map((path) => ({ path }))),
  );
  await writeFile(
    join(root, 'public', childSitemaps.pricesServiceMarket),
    urlsetXml(prices.sitemap),
  );
  // E11.6-12: each kind of hub has its own child sitemap, every hub dated
  // from the newest verification it shows; `/prices` is listed only while a
  // page is live.
  await writeFile(
    join(root, 'public', childSitemaps.pricesIndex),
    urlsetXml(prices.hubSitemaps.index),
  );
  await writeFile(
    join(root, 'public', childSitemaps.pricesServiceHubs),
    urlsetXml(prices.hubSitemaps.services),
  );
  await writeFile(
    join(root, 'public', childSitemaps.pricesMarketHubs),
    urlsetXml(prices.hubSitemaps.markets),
  );
  // E11.6-13: the monthly reports have their own child sitemap, each dated
  // by the build of the snapshot it reports, never the site's build date.
  await writeFile(
    join(root, 'public', childSitemaps.priceIndexMonthly),
    urlsetXml(prices.monthlySitemap),
  );
  await writeFile(join(root, 'public/sitemap.xml'), sitemapIndexXml());
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(`file://${process.argv[1]}`))
) {
  if (process.argv.includes('--check')) await checkSeoBuild(projectRoot, true);
  else if (process.argv.includes('--sitemap')) {
    await generateSitemap();
    const { rendered, reused } = await generateOpenGraphImages();
    console.log(
      `Social cards: ${rendered} rendered, ${reused} reused from ${socialCardCacheDirectory}.`,
    );
  }
}
