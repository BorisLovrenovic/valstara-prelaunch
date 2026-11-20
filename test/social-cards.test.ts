import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  generateOpenGraphImages,
  priceCardLine,
  priceLineFontSize,
  priceSocialCard,
  renderSocialCards,
  socialCardCacheDirectory,
  socialCardManifestFile,
  socialCardSvg,
  type SocialCard,
} from '../scripts/ci/seo-build-check.ts';
import { pricesCopy } from '../src/copy/prices.ts';
import { seoCopy } from '../src/copy/seo.ts';
import { readPriceSiteInputs } from '../src/server/prices/files.ts';
import { createPriceSite } from '../src/server/prices/site.ts';
import {
  socialFallbackImageUrl,
  socialImageUrl,
  socialPageKinds,
} from '../src/server/seo.ts';

// E11.6-14: the price pages' social cards, their content-hash cache
// (D-038 Q3) and the 60-second cold-render budget (D-038 Q2). The price
// equality against a served page is in test/price-pages-rendered.test.mjs.

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const outputOf = (pathname: string) =>
  new URL(socialImageUrl(pathname)).pathname.slice(1);

// The price-page fixture dataset (test/fixtures/price-index/pages/), and
// where each file goes in a checkout.
const fixtureData = join(root, 'test/fixtures/price-index/pages');
const fixtureFiles: Record<string, string> = {
  'catalogue.json': 'config/catalogue.json',
  'markets.json': 'config/markets.json',
  'latest.json': 'data/price-index/latest.json',
  'published-urls.json': 'data/price-index/published-urls.json',
  'changes.json': 'data/price-index/changes.json',
  'valstara-prices.json': 'config/valstara-prices.json',
  'monthly/2026-09.json': 'data/price-index/monthly/2026-09.json',
  'monthly/2026-10.json': 'data/price-index/monthly/2026-10.json',
};

/** A checkout with the card inputs only: tokens, fonts. */
async function cardRoot(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), 'valstara-cards-'));
  await mkdir(join(fixture, 'src/styles'), { recursive: true });
  await cp(
    join(root, 'src/styles/tokens.css'),
    join(fixture, 'src/styles/tokens.css'),
  );
  await cp(join(root, 'public/fonts'), join(fixture, 'public/fonts'), {
    recursive: true,
  });
  return fixture;
}

/** A checkout the generator builds every card of, over the fixture data. */
async function priceCardRoot(): Promise<string> {
  const fixture = await cardRoot();
  await cp(join(root, 'src/pages'), join(fixture, 'src/pages'), {
    recursive: true,
  });
  await cp(join(root, 'src/content'), join(fixture, 'src/content'), {
    recursive: true,
  });
  for (const [name, target] of Object.entries(fixtureFiles)) {
    await mkdir(dirname(join(fixture, target)), { recursive: true });
    await cp(join(fixtureData, name), join(fixture, target));
  }
  return fixture;
}

/** Every file under `public/images/og`, by path, as a digest. */
async function placedCards(fixture: string): Promise<Map<string, string>> {
  const directory = join(fixture, 'public/images/og');
  const files = (await readdir(directory, { recursive: true })).filter((file) =>
    file.endsWith('.png'),
  );
  const cards = new Map<string, string>();
  for (const file of files.sort()) {
    cards.set(
      `images/og/${file}`,
      digest(await readFile(join(directory, file))),
    );
  }
  return cards;
}

const tokens = {
  paper: '#fafafa',
  ink: '#101014',
  coral: '#e8654a',
  font: "'Instrument Sans', sans-serif",
  mono: "'JetBrains Mono', monospace",
};

test('a service × market card line is the first plan row of its page, word for word', async () => {
  const fixture = await priceCardRoot();
  try {
    const site = createPriceSite(await readPriceSiteInputs(fixture));
    const generated = site.routes.filter((route) => route.kind === 'generated');
    assert.equal(generated.length, 8);
    // The fixture holds a page with more than one plan, so "first" matters.
    const multiPlan = generated.filter((route) => route.rows.length > 1);
    assert.ok(multiPlan.length > 0, 'a multi-plan page is covered');
    for (const route of generated) {
      const [first, ...others] = route.rows;
      const line = priceCardLine(route);
      assert.equal(
        line,
        `${first.planName} · ${first.priceText} ${first.periodText}`,
        route.path,
      );
      assert.ok(line?.includes(`${first.amount} ${first.currency}`));
      for (const other of others) {
        if (other.priceText !== first.priceText) {
          assert.ok(!line?.includes(other.priceText), route.path);
        }
      }
      assert.doesNotMatch(line ?? '', /\b(?:from|cheapest|only)\b/iu);
    }
    for (const route of site.routes.filter(
      (item) => item.kind === 'unavailable',
    )) {
      assert.equal(priceCardLine(route), null, route.path);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('the price line is set in the monospace token and makes no external reference', () => {
  const line = 'Premium (4K) · 24.99 USD per month';
  const svg = socialCardSvg('Netflix price in the United States', tokens, line);
  assert.match(
    svg,
    new RegExp(
      `<text [^>]*font-family="&apos;JetBrains Mono&apos;, monospace"[^>]*>${line.replace(/[()]/gu, '\\$&')}</text>`,
      'u',
    ),
  );
  const titleOnly = socialCardSvg('Valstara price index', tokens);
  assert.ok(!titleOnly.includes('JetBrains'));
  for (const card of [svg, titleOnly]) {
    // The only URL in a card is the SVG namespace: no image, font or link
    // is fetched while it is rasterised.
    assert.deepEqual(card.match(/https?:\/\/[^"]+/gu), [
      'http://www.w3.org/2000/svg',
    ]);
    assert.doesNotMatch(card, /href|url\(|<image|@import/u);
  }
  assert.throws(
    () => socialCardSvg('A price', { ...tokens, mono: undefined }, line),
    /font-mono/u,
  );
  // A long line is set smaller so it stays inside the 830 px safe width.
  assert.equal(priceLineFontSize(line), 36);
  const long = `${'Premium Individual Family Plan'} · 1299.99 SEK per month`;
  assert.ok(priceLineFontSize(long) < 36);
  assert.ok(priceLineFontSize(long) * 0.6 * long.length <= 830);
});

test('a rebuild with unchanged data renders no card, and a change renders only what it changes', async () => {
  const fixture = await priceCardRoot();
  try {
    const first = await generateOpenGraphImages(fixture);
    const placed = await placedCards(fixture);
    // 8 service × market pages, 8 hubs, `/prices`, `/price-index`, two
    // monthly reports, every other page with metadata, and the fallbacks.
    assert.equal(first.reused, 0);
    assert.equal(first.rendered, placed.size);
    assert.ok(placed.size > 20 + socialPageKinds.length);

    const second = await generateOpenGraphImages(fixture);
    assert.deepEqual(second, { rendered: 0, reused: placed.size });
    assert.deepEqual(
      await placedCards(fixture),
      placed,
      'every card is placed again, byte for byte',
    );
    // The cache and its manifest are outside public/, so never served.
    const manifest = JSON.parse(
      await readFile(
        join(fixture, socialCardCacheDirectory, socialCardManifestFile),
        'utf8',
      ),
    );
    assert.equal(Object.keys(manifest.cards).length, placed.size);
    assert.ok(![...placed.keys()].some((file) => file.includes('manifest')));
    assert.equal(
      (await readdir(join(fixture, 'public'), { recursive: true })).filter(
        (file) => file.endsWith('.json'),
      ).length,
      0,
    );

    // The monospace token changes only the cards that carry a price line.
    const tokensPath = join(fixture, 'src/styles/tokens.css');
    const original = await readFile(tokensPath, 'utf8');
    await writeFile(
      tokensPath,
      original.replace(
        "--font-mono:\n    'JetBrains Mono',",
        "--font-mono:\n    'JetBrains Mono', 'Courier New',",
      ),
    );
    const priced = Object.values(
      manifest.cards as Record<string, { priceLine: string | null }>,
    ).filter((card) => card.priceLine !== null).length;
    assert.equal(priced, 8);
    assert.deepEqual(await generateOpenGraphImages(fixture), {
      rendered: priced,
      reused: placed.size - priced,
    });

    // A brand colour changes every card.
    await writeFile(
      tokensPath,
      original.replace('--coral: #e8654a;', '--coral: #e8654b;'),
    );
    assert.deepEqual(await generateOpenGraphImages(fixture), {
      rendered: placed.size,
      reused: 0,
    });
    await writeFile(tokensPath, original);
    assert.deepEqual(await generateOpenGraphImages(fixture), {
      rendered: placed.size,
      reused: 0,
    });
    assert.deepEqual(await generateOpenGraphImages(fixture), {
      rendered: 0,
      reused: placed.size,
    });

    // A cached image whose bytes no longer match the manifest is rendered
    // again, never served as it stands.
    const cards = manifest.cards as Record<string, { key: string }>;
    const damaged = cards[outputOf('/prices/netflix/sweden')].key;
    await writeFile(
      join(fixture, socialCardCacheDirectory, `${damaged}.png`),
      'not a png',
    );
    assert.deepEqual(await generateOpenGraphImages(fixture), {
      rendered: 1,
      reused: placed.size - 1,
    });
    assert.deepEqual(await placedCards(fixture), placed);

    // Without its manifest the cache is empty: every card renders again.
    await rm(join(fixture, socialCardCacheDirectory, socialCardManifestFile));
    assert.deepEqual(await generateOpenGraphImages(fixture), {
      rendered: placed.size,
      reused: 0,
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('a changed page renders its own card only, and the cache keeps one build', async () => {
  const fixture = await cardRoot();
  try {
    const cards: SocialCard[] = [
      {
        output: outputOf('/prices/netflix/sweden'),
        title: 'Netflix price in Sweden (November 2026) — Valstara',
        priceLine: 'Basic · 99.00 SEK per month',
      },
      {
        output: outputOf('/prices/netflix'),
        title: 'Netflix prices by country (November 2026) — Valstara',
        priceLine: null,
      },
    ];
    assert.deepEqual(await renderSocialCards(fixture, cards), {
      rendered: 2,
      reused: 0,
    });
    const before = await placedCards(fixture);
    const changed = [
      { ...cards[0], priceLine: 'Basic · 109.00 SEK per month' },
      cards[1],
    ];
    assert.deepEqual(await renderSocialCards(fixture, changed), {
      rendered: 1,
      reused: 1,
    });
    const after = await placedCards(fixture);
    assert.notEqual(after.get(cards[0].output), before.get(cards[0].output));
    assert.equal(after.get(cards[1].output), before.get(cards[1].output));
    // The superseded image leaves the cache.
    const cached = (
      await readdir(join(fixture, socialCardCacheDirectory))
    ).filter((file) => file.endsWith('.png'));
    assert.equal(cached.length, 2);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

/** A card of the full-scale set, with the names its title must show. */
interface FullScaleCard {
  readonly card: SocialCard;
  readonly shows: readonly string[];
}

/** `YYYY-MM-DD` as "November 2026", derived apart from the copy layer. */
function monthOf(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Every card a full-scale price index would have (D-038 Q2): every
 * catalogue service in every configured market, with its first plan's price
 * line, every service and market hub, `/prices`, `/price-index`, a year of
 * monthly reports, and the typed fallbacks. The pages are dated `newest`.
 */
async function fullScaleEntries(
  newest = '2026-11-20',
): Promise<FullScaleCard[]> {
  const catalogue = JSON.parse(
    await readFile(join(root, 'config/catalogue.json'), 'utf8'),
  ) as {
    services: {
      service_id: string;
      name: string;
      plans: { name: string; billing_period: 'month' | 'year' }[];
    }[];
  };
  const { markets } = JSON.parse(
    await readFile(join(root, 'config/markets.json'), 'utf8'),
  ) as {
    markets: {
      name: string;
      name_in_sentence?: string;
      slug: string;
      currency: string;
    }[];
  };
  const month = monthOf(newest);
  const entries: FullScaleCard[] = [];
  for (const service of catalogue.services) {
    const plan = service.plans[0];
    for (const market of markets) {
      const marketName = market.name_in_sentence ?? market.name;
      entries.push({
        card: priceSocialCard(
          outputOf(`/prices/${service.service_id}/${market.slug}`),
          pricesCopy.page.title(service.name, marketName, newest),
          pricesCopy.page.socialCardLine(
            plan.name,
            pricesCopy.page.price('1299.99', market.currency),
            pricesCopy.page.period[plan.billing_period],
          ),
        ),
        shows: [service.name, marketName, month],
      });
    }
    entries.push({
      card: priceSocialCard(
        outputOf(`/prices/${service.service_id}`),
        pricesCopy.hubs.service.title(service.name, newest),
        null,
      ),
      shows: [service.name, month],
    });
  }
  for (const market of markets) {
    entries.push({
      card: priceSocialCard(
        outputOf(`/prices/countries/${market.slug}`),
        pricesCopy.hubs.market.title(market.name, newest),
        null,
      ),
      shows: [market.name, month],
    });
  }
  entries.push(
    {
      card: priceSocialCard(
        outputOf('/prices'),
        pricesCopy.hubs.index.title,
        null,
      ),
      shows: [],
    },
    {
      card: priceSocialCard(
        outputOf('/price-index'),
        'How the price index works — Valstara',
        null,
      ),
      shows: [],
    },
  );
  for (let report = 1; report <= 12; report += 1) {
    const key = `2026-${String(report).padStart(2, '0')}`;
    entries.push({
      card: priceSocialCard(
        outputOf(`/price-index/${key}`),
        pricesCopy.monthly.title(key),
        null,
      ),
      shows: [monthOf(`${key}-01`)],
    });
  }
  for (const kind of socialPageKinds) {
    entries.push({
      card: {
        output: new URL(socialFallbackImageUrl(kind)).pathname.slice(1),
        title: seoCopy.socialCardFallbacks[kind],
        priceLine: null,
      },
      shows: [],
    });
  }
  return entries;
}

async function fullScaleCards(): Promise<SocialCard[]> {
  return (await fullScaleEntries()).map((entry) => entry.card);
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** The title lines a card's SVG draws, with their baselines. */
function drawnTitle(svg: string): { y: number; text: string }[] {
  return Array.from(
    svg.matchAll(/<tspan x="112" y="(\d+)"[^>]*>([^<]*)<\/tspan>/gu),
    (match) => ({ y: Number(match[1]), text: unescapeXml(match[2]) }),
  );
}

test('every price card title shows its service, market and month in full, in every month', async () => {
  const brandSuffix = ` — ${seoCopy.organisationName}`;
  let fourLineCards = 0;
  for (let month = 1; month <= 12; month += 1) {
    const newest = `2026-${String(month).padStart(2, '0')}-28`;
    const entries = await fullScaleEntries(newest);
    for (const { card, shows } of entries) {
      const svg = socialCardSvg(
        card.title,
        tokens,
        card.priceLine,
        card.priceCard === true,
      );
      const lines = drawnTitle(svg);
      const text = lines.map((line) => line.text).join(' ');
      const where = `${card.output} (${newest}): ${text}`;
      assert.ok(lines.length >= 1 && lines.length <= 4, where);
      assert.ok(!text.includes('…'), where);
      for (const name of shows) assert.ok(text.includes(name), where);
      if (card.priceCard !== true) continue;
      assert.ok(!text.includes(brandSuffix), where);
      // The last title line, the price line and the wordmark keep a
      // three-line card's positions on a four-line card.
      const baselines = lines.map((line) => line.y);
      if (lines.length === 4) {
        fourLineCards += 1;
        assert.deepEqual(baselines, [170, 252, 334, 416], where);
      } else {
        assert.equal(baselines[0], 252, where);
      }
      if (card.priceLine !== null) {
        const priceY = Number(
          /<text x="112" y="(\d+)"[^>]*font-family="&apos;JetBrains Mono/u.exec(
            svg,
          )?.[1],
        );
        assert.equal(priceY, baselines.at(-1)! + 86, where);
        if (lines.length >= 3) assert.equal(priceY, 502, where);
      }
      assert.match(svg, /<text x="112" y="548"[^>]*>Valstara<\/text>/u);
    }
  }
  assert.ok(fourLineCards > 0, 'the set holds four-line price cards');
});

test('a price card is the SEO title without its brand suffix; other cards keep theirs', () => {
  const card = priceSocialCard(
    outputOf('/prices/amazon-prime/gb'),
    'Amazon Prime / Prime Video price in the United Kingdom (September 2026) — Valstara',
    'Monthly · 8.99 GBP per month',
  );
  assert.equal(
    card.title,
    'Amazon Prime / Prime Video price in the United Kingdom (September 2026)',
  );
  assert.equal(card.priceCard, true);
  const lines = drawnTitle(
    socialCardSvg(card.title, tokens, card.priceLine, true),
  );
  assert.deepEqual(
    lines.map((line) => line.text),
    [
      'Amazon Prime / Prime',
      'Video price in the',
      'United Kingdom',
      '(September 2026)',
    ],
  );
  // A non-price card keeps three lines and E9-07's shortening.
  const long = drawnTitle(socialCardSvg(`${card.title} — Valstara`, tokens));
  assert.equal(long.length, 3);
  assert.equal(long[2].text.startsWith('…'), true);
  // Beyond four lines, a price card falls back to the same shortening.
  const tooLong = drawnTitle(
    socialCardSvg(
      `${card.title} and a great deal more besides`,
      tokens,
      null,
      true,
    ),
  );
  assert.equal(tooLong.length, 4);
  assert.equal(tooLong[3].text.startsWith('…'), true);
});

const coldRenderBudgetMilliseconds = 60_000;

test(
  'every card of a full-scale price index renders cold within 60 seconds',
  { timeout: 3 * coldRenderBudgetMilliseconds },
  async (context) => {
    const cards = await fullScaleCards();
    const catalogue = JSON.parse(
      await readFile(join(root, 'config/catalogue.json'), 'utf8'),
    ) as { services: unknown[] };
    const { markets } = JSON.parse(
      await readFile(join(root, 'config/markets.json'), 'utf8'),
    ) as { markets: unknown[] };
    assert.ok(
      cards.filter((card) => card.priceLine !== null).length ===
        catalogue.services.length * markets.length,
    );
    const fixture = await cardRoot();
    try {
      const startedAt = process.hrtime.bigint();
      const stats = await renderSocialCards(fixture, cards);
      const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      assert.deepEqual(stats, { rendered: cards.length, reused: 0 });
      context.diagnostic(
        `cold render: ${cards.length} cards in ${(elapsed / 1000).toFixed(1)} s on ${cpus().length} × ${cpus()[0]?.model ?? 'unknown CPU'} (${platform()} ${arch()})`,
      );
      assert.ok(
        elapsed <= coldRenderBudgetMilliseconds,
        `${cards.length} cards took ${Math.round(elapsed)} ms, over the ${coldRenderBudgetMilliseconds} ms budget`,
      );
      for (const card of [cards[0], cards.at(-1) as SocialCard]) {
        const metadata = await sharp(
          join(fixture, 'public', card.output),
        ).metadata();
        assert.deepEqual([metadata.width, metadata.height], [1200, 630]);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
