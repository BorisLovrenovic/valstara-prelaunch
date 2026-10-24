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

E9-06 runs `scripts/ci/seo-build-check.ts` at build time. Its prebuild step writes `public/sitemap.xml` from the page files plus the current rules revision's permanent URL; its postbuild step validates metadata sources for every HTML route and static page bindings, then checks the emitted heads of prerendered pages for a unique title, description and self-canonical URL. `/me` and `/verify` are excluded from the sitemap in line with `robots.txt`; API routes are not HTML pages. Canonicals use the permanent `https://valstara.com` URLs without query parameters. The rules article bytes and recorded SHA-256 remain unchanged: only page metadata and the archive notice outside the article differ between current and superseded revisions.

**Branded error pages (E11.5-10).** `src/pages/404.astro` and `src/pages/500.astro` are prerendered on the shell, carry `<meta name="robots" content="noindex">`, and are excluded from the sitemap by `sitemapPaths`. `robots.txt` does not disallow them, so a crawler can read the `noindex`. Their titles and descriptions are bound like every other page's. The Node adapter serves the built `404.html` with status 404 for an unknown route, and the built `500.html`, byte for byte, with status 500 for a render that fails; neither renders anything from the request or the failure.

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

The build emits one PNG per HTML page at `/images/og/<page-key>.png`, using that page's own SEO title and the colour and font-family tokens in `src/styles/tokens.css`. The renderer loads the local WOFF source declared for the `--font-sans` family before rasterising the cards. It also emits a typed fallback PNG for each page kind: landing, trust, legal, campaign and rules. Open Graph lists the page-specific image first and its page-kind fallback second; X uses the page-specific image URL. If a page PNG is absent at postbuild, the typed fallback is copied to that URL, so both card formats resolve to a served image. No image service or third-party request is used.

The supported preview crops are:

| Platform preview | Crop dimensions | Evidence basis |
|---|---:|---|
| Facebook/Meta and Slack Open Graph | 1200×630 | Shared Open Graph canvas |
| X large summary card | 1200×628 | Near-1.91:1 landscape crop |
| LinkedIn link preview | 1200×627 | [LinkedIn's stated link-preview frame](https://www.linkedin.com/help/linkedin/answer/a525301) |

The generator preserves the full image canvas and keeps the title and wordmark within the central safe area. Long titles retain their final suffix, including the rules revision identifier. `scripts/ci/seo-build-check.ts` renders images during the prebuild step and the postbuild check verifies page-specific metadata and the fallback reference. `test/seo.test.ts` checks every route image, all typed fallbacks, PNG dimensions and the three platform crops.
