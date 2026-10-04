# Feature: SEO, social and the domain transition

## Summary
The pre-launch site sits on the **root domain**, and the trust and legal pages are built at their permanent URLs so they accumulate authority that survives the store launch. Everything here is in service of that transition (ADR-021).

## Feature flag
`trustpilot.widget` — **default off.** The profile is claimed and linked now; **no rating is displayed until the review count justifies it**, because a three-review TrustScore signals "unproven" more loudly than no score at all.

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
A page shipped without metadata → **the build fails**; a trust page with no description is a wasted ranking opportunity that nobody notices. OG image missing → a typed fallback per page kind, never a broken card. Trustpilot script fails → **the page renders without it**; content never blocks on a third-party script. Route added without a sitemap entry → the sitemap is generated from the route set, so this cannot happen by omission.

E9-06 runs `scripts/ci/seo-build-check.ts` at build time. Its prebuild step writes `public/sitemap.xml` from the page files plus every published rules revision; its postbuild step validates metadata sources for every HTML route and static page bindings, then checks the emitted heads of prerendered pages for a unique title, description and self-canonical URL. `/me` and `/verify` are excluded from the sitemap in line with `robots.txt`; API routes are not HTML pages. Canonicals use the permanent `https://valstara.com` URLs without query parameters. The rules article bytes and recorded SHA-256 remain unchanged: only head metadata differs between the current page and each immutable revision.

## Acceptance criteria
- [ ] Every page has a unique title, description and canonical — **build-time enforced**
- [ ] The sitemap is **generated from the route set**, not hand-maintained
- [ ] `robots.txt` allows indexing of the trust and legal pages and excludes `/me`, `/verify` and `/api`
- [ ] Structured data validates for the organisation and for each rules page
- [ ] Rules-page structured data is schema.org WebPage JSON-LD generated from validated revision frontmatter. The current page and every immutable revision have their own permanent URL and self-canonical; each records its `rules_version` and `datePublished` and points to the Organisation publisher. It carries no Event, Offer, Product, prize, odds or date claims (E9-06, founder-authorised 2026-10-03).
- [ ] OG images exist per page type and render correctly at the major platforms' crops
- [ ] **The Trustpilot widget loads lazily and only when its flag is on**, and no Trustpilot request occurs while it is off
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
