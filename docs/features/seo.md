# Feature: SEO, social and the domain transition

## Summary
The pre-launch site sits on the **root domain**, and the trust and legal pages are built at their permanent URLs so they accumulate authority that survives the store launch. Everything here is in service of that transition (ADR-021).

## Feature flag
None for the trust-page link. The profile is claimed and linked now; no widget or rating appears pre-launch.

Founder-authorised 2026-10-10, superseding the widget decision of 2026-10-05: the plain `/legit` Reviews link points to `https://www.trustpilot.com/review/valstara.com` with `rel="noopener"` and no prefetch or preconnect. The "not yet" paragraph and no-purchased-reviews statement always render. No Trustpilot request, widget, rating, API, or key is used by the pre-launch site. A widget may return with the storefront's consent management platform.

## The route plan

| Route | Pre-launch role | At launch |
|---|---|---|
| `/` | Waitlist landing page | Storefront home. **Same URL, new content** |
| `/legit`, `/guarantee`, `/about` | Trust content | Ported to the storefront, same URLs |
| `/terms`, `/privacy` | Legal | Ported and revised in place |
| `/giveaway/rules` and `/giveaway/rules/<rules_version>` | The global rules page and its immutable revisions (ADR-026) | Public for 12 months after the final award, then `410` |
| `/waitlist`, `/leaderboard`, `/me` | Campaign mechanics | `301` to `/` and the account area |

## User flows
1. **Search** — trust pages rank; the landing page converts. Metadata, canonicals and structured data are per-page, not templated once and forgotten.
2. **Social** — a page-specific Open Graph image generated at build from the page title and brand tokens, with a page-kind fallback. The shared image is 1200×630. The title sits inside a centered safe area so it survives the Facebook/Meta and Slack 1200×630 preview, X's 1200×628 preview, and LinkedIn's 1200×627 preview.
3. **Machines** — `llms.txt` ships. **Expect nothing from it**: the largest study found no correlation with citation frequency and Google says it does not use it. One hour of cheap insurance, not a channel.

## Edge cases and error states
A page shipped without metadata → **the build fails**; a trust page with no description is a wasted ranking opportunity that nobody notices. OG image missing → a typed fallback per page kind, never a broken card. Route added without a sitemap entry → the sitemap is generated from the route set, so this cannot happen by omission.

E9-06 runs `scripts/ci/seo-build-check.ts` at build time. Its prebuild step writes the sitemaps: since E11.6-10, `public/sitemap.xml` is a sitemap index over `/sitemaps/pages.xml`, which holds exactly the entries `/sitemap.xml` held before (the page files plus the current rules revision's permanent URL), and `/sitemaps/prices-service-market.xml`, the generated service × market price pages from the price data, each with its verification date as `lastmod` (never the build date), and since E11.6-12 one child sitemap per kind of price hub (`/sitemaps/prices-index.xml`, `/sitemaps/prices-service-hubs.xml`, `/sitemaps/prices-market-hubs.xml`), each hub dated from the newest verification it shows, and since E11.6-13 `/sitemaps/price-index-monthly.xml`, the monthly price reports, each dated by the build of the snapshot it reports; all written by every build and git-ignored; its postbuild step validates metadata sources for every HTML route and static page bindings, then checks the emitted heads of prerendered pages for a unique title, description and self-canonical URL. `/me` and `/verify` are excluded from the sitemap in line with `robots.txt`; API routes are not HTML pages. Canonicals use the permanent `https://valstara.com` URLs without query parameters. The rules article bytes and recorded SHA-256 remain unchanged: only page metadata and the archive notice outside the article differ between current and superseded revisions.

**Branded error pages (E11.5-10).** `src/pages/404.astro` and `src/pages/500.astro` are prerendered on the shell, carry `<meta name="robots" content="noindex">`, and are excluded from the sitemap by `sitemapPaths`. `robots.txt` does not disallow them, so a crawler can read the `noindex`. Their titles and descriptions are bound like every other page's. The Node adapter serves the built `404.html` with status 404 for an unknown route, and the built `500.html`, byte for byte, with status 500 for a render that fails; neither renders anything from the request or the failure. The adapter's static handler also serves a direct request for `/404.html` or `/500.html` with status 200; both files are `noindex` and absent from the sitemap, so nothing crawlable is affected. Like every page, each keeps the self-canonical (`https://valstara.com/404`, `/500`) and per-page OG image that the build check requires; the canonical URL answers 404 by design, and a crawler ignores it under `noindex`.

**Price pages (E11.6-10).** The price route's pages come from the price data, not the file tree, so the check expands `prices/[service]/[country].astro` from the data the build bundles (`createPriceSite`): every generated page and every unavailable ledger URL joins the metadata set, with a unique title and description, and its binding is `view.meta`. They are server-rendered, so `checkRenderedHead`, the same per-page head check the postbuild step runs on every prerendered page, runs on their served HTML in `test/price-pages-rendered.test.mjs`. Their social-card kind is `prices`: from E11.6-14 every generated page has its own card, and a ledger URL that publishes no page takes the typed `prices` fallback, copied to its card URL at postbuild (`#social-card-contract-e9-07`). Unavailable ledger URLs and the `prices.pages` off state carry `noindex`. **The hubs and `/prices` (E11.6-12)** are price routes too: the check expands `prices/[service]/index.astro` and `prices/countries/[country].astro` from the same view model (every service and market hub the data makes), binds all three hub files to `view.meta`, and `/prices` takes its metadata from the view model rather than the page files' route set, so it is left out of `pages.xml` and listed in its own child sitemap only while a page is live (it is `noindex` while empty). Each has BreadcrumbList JSON-LD (Valstara → Prices → the hub) mirrored by a visible breadcrumb, and its own title-only card, with the typed `prices` card as fallback (E11.6-14). A retired price URL answers 301 to a hub, and has no metadata entry, while it generates no page; if its data publishes again it is a generated page with its metadata (D-037 Q2). `test/price-hubs-rendered.test.mjs` runs `checkRenderedHead` on every served hub. **A generated price page also carries `FAQPage` JSON-LD (E11.6-11)**, built from the same entries as its visible FAQ, so it appears only with a visible FAQ and states only what the page states; an unavailable page carries none. `test/price-pages-rendered.test.mjs` validates it on every generated page with a strict FAQPage check (`test/helpers/faq-page-data.mjs`) and compares it with the visible questions and answers. **`/price-index` and the monthly reports (E11.6-13)** are price routes for the social card (kind `prices`). `/price-index` takes its metadata from its content file's frontmatter (binding `entry.data`) and is listed in `pages.xml`; `price-index/[month].astro` is expanded from the monthly report files, bound to `view.meta`, and listed in its own child sitemap. Both have BreadcrumbList JSON-LD mirrored by a visible breadcrumb, and `/price-index` carries `Dataset` JSON-LD while a price is published (`docs/features/price-index.md#pages`). `test/price-index-rendered.test.mjs` runs `checkRenderedHead` on each served page.

**Founder-authorised 2026-10-09:** Superseded rules revisions remain reachable and self-canonical, but carry `noindex` and the approved archive notice outside the hashed article. They are absent from the sitemap. `/giveaway/rules` and the current revision's permanent URL remain indexable and have no archive notice.

## Acceptance criteria
- [ ] Every page has a unique title, description and canonical — **build-time enforced**
- [ ] The sitemap is **generated from the route set**, not hand-maintained
- [ ] `robots.txt` allows indexing of the trust and legal pages and excludes `/me`, `/verify` and `/api`
- [ ] The 404 and 500 pages are `noindex`, absent from the sitemap and not disallowed by `robots.txt` (E11.5-10)
- [ ] Structured data validates for the organisation and for each rules page
- [ ] Rules-page structured data is schema.org WebPage JSON-LD generated from validated revision frontmatter. The current page and every immutable revision have their own permanent URL and self-canonical; each records its `rules_version` and `datePublished` and points to the Organisation publisher. It carries no Event, Offer, Product, prize, odds or date claims (E9-06, founder-authorised 2026-10-03).
- [ ] OG images exist per page type and render correctly at the major platforms' crops
- [ ] **No Trustpilot host is requested on any rendered page;** the plain `/legit` profile link and "not yet" Reviews paragraph render
- [ ] `llms.txt` ships
- [ ] **No trust or legal URL differs from the URL the storefront will keep** — checked against the port checklist

## Telemetry
Organic entries by landing page, trust-page-to-signup rate, social card click-through, index coverage.

## Social card contract (E9-07)

The build emits one PNG per HTML page at `/images/og/<page-key>.png`, using that page's own SEO title and the colour and font-family tokens in `src/styles/tokens.css`. The renderer loads the local WOFF source declared for the `--font-sans` family before rasterising the cards. It also emits a typed fallback PNG for each page kind: landing, trust, legal, campaign, rules and, from E11.6-10, prices. Open Graph lists the page-specific image first and its page-kind fallback second; X uses the page-specific image URL. If a page PNG is absent at postbuild, the typed fallback is copied to that URL, so both card formats resolve to a served image. No image service or third-party request is used.

The supported preview crops are:

| Platform preview | Crop dimensions | Evidence basis |
|---|---:|---|
| Facebook/Meta and Slack Open Graph | 1200×630 | Shared Open Graph canvas |
| X large summary card | 1200×628 | Near-1.91:1 landscape crop |
| LinkedIn link preview | 1200×627 | [LinkedIn's stated link-preview frame](https://www.linkedin.com/help/linkedin/answer/a525301) |

The generator preserves the full image canvas and keeps the title and wordmark within the central safe area. Long titles retain their final suffix, including the rules revision identifier. `scripts/ci/seo-build-check.ts` renders images during the prebuild step and the postbuild check verifies page-specific metadata and the fallback reference. `test/seo.test.ts` checks every route image, all typed fallbacks, PNG dimensions and the three platform crops.

### Price page cards (E11.6-14)

Every price page with metadata has its own card: each service × market page that publishes, each service and market hub, `/prices`, `/price-index` and each monthly report. A card holds the page's own SEO title. **A service × market card also holds one price line: the page's first plan row, word for word as its plan table shows it** — the plan name, the price and the period, for example "Basic · 7.99 EUR per month" — composed by `pricesCopy.page.socialCardLine` and set in the `--font-mono` token below the title (D-038 Q1). The first row is the first catalogue plan with a publishable record in that market, so a single-plan page shows its only row. No card says "from", "cheapest" or any other comparative word. The line is taken from the same view-model row the page renders (`priceCardLine` in `scripts/ci/seo-build-check.ts`), never derived a second time; its font size is 36 px, set smaller only when a long line would leave the 830 px safe width, because the rasteriser ignores `textLength`. The hubs, `/prices`, `/price-index` and the reports have title-only cards. **A ledger URL that publishes no page (kind `unavailable`) has no card of its own**: the postbuild step copies the typed `prices` card to its card URL, as it does for any page whose card is missing.

The card is rendered from the build-bundled data, so it shows the price of the build that served it. Social platforms cache a card by its URL, so a link shared before a price change can keep showing the earlier card; the card's title carries the month of the last verification. (Long titles are shortened by the generator's three-line rule, which keeps the final suffix; on the longest titles the month can be cut.)

**The cache (D-038 Q3).** Rendered PNGs are kept in `.cache/social-cards/` at the checkout root, with `manifest.json`. Each image is keyed by a sha-256 content hash of everything that changes its pixels: the card's title and price line, the colour and font token values it uses (`--font-mono` only for a card with a price line), the bytes of the WOFF files it uses, the source of `scripts/ci/seo-build-check.ts` (the card template) and the rasteriser's version. The manifest records each placed card's file, key, title and price line, and the sha-256 of each cached PNG; a cached PNG whose bytes no longer match is rendered again. A rebuild with unchanged inputs renders no card and still places every card at its `/images/og/` URL; a changed page re-renders its own card only, and a brand token or font change re-renders every card that uses it. Images no card uses are dropped, so the cache holds one build. The directory is outside `public/`, so the manifest is never served, and it is git-ignored and listed in `.dockerignore`, so the image build is always cold. `.github/workflows/pr.yml` does not keep it: every CI build starts cold. The prebuild step prints how many cards it rendered and reused.

**The build-time budget (D-038 Q2).** Rendering every card from a cold cache adds at most **60 seconds** to the build. (E1-05 sets no build-time budget; this figure replaces it, and the E1-05 per-fixture timeout is unchanged.) `test/social-cards.test.ts` renders, from an empty cache, every card of a synthetic full-scale set built from `config/catalogue.json` and `config/markets.json` — every catalogue service in every configured market with its first plan's price line, every service and market hub, `/prices`, `/price-index`, twelve monthly reports and the six typed fallbacks — and fails above 60 s.

| Measured | Cards | Cold render | Machine |
|---|---:|---:|---|
| 2026-11-20 | 439 (19 services × 20 markets, 19 + 20 hubs, `/prices`, `/price-index`, 12 reports, 6 fallbacks) | 15.3 s | 20 × Intel Core Ultra 7 155H, Linux x64 (WSL2), local |

No card loads anything from the network: the SVG references no image, font or URL beyond its namespace, and the fonts are the repository's own WOFF files. `test/seo.test.ts` checks per-page presence, the unavailable-URL and missing-card fallback; `test/social-cards.test.ts` checks the price line, the cache and the budget; `test/price-pages-rendered.test.mjs` checks that each served card's price line equals the first plan row of the served page and that the served PNG is the image rendered from it.
