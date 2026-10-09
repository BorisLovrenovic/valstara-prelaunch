# Feature: Trust pages

## Summary
`/legit`, `/guarantee` and `/about` — the content that answers "is this a scam", built here at their **permanent URLs** so they never move, and written as **content files** so porting them into the storefront at launch is a copy operation rather than a rewrite (ADR-017).

These pages have the longest lead time, the highest conversion value, and are the only content on this site that survives into the store. They are on the **never cut** list.

## Feature flag
The pages and `/legit` Reviews profile link have no flag. They remain available as trust content. The founder removed the pre-launch TrustBox and retired its flag on 2026-10-10.

## User flows
1. **From the landing page** — a prominent, non-defensive link. The question is being asked whether or not the page exists.
2. **From search** — these pages are the site's real SEO surface; the landing page converts, these pages rank.
3. **From email** — linked in the welcome mail, where the recipient is deciding whether to stay.

## Content sourcing — a named dependency
**The prose is a founder input, not an engineering decision.** The guarantee's terms, the sourcing explanation and the company details come from the brand and store documentation, and this repository must not invent them. The build delivers: the content pipeline, the routes, the schema markup, the styling and the porting contract. **A page shell with placeholder prose is a blocker, not a deliverable** — see the founder prerequisites in the development plan.

The founder-approved page copy and claim-by-claim source notes are in `docs/prerequisites/p3b-trust-pages-copy.md`. E9-02 transcribes the page sections into `src/content/legit.md`, `guarantee.md` and `about.md`; E9-08 keeps the plain Reviews profile link. The source notes remain in the prerequisite so visitors see only page copy. The pre-launch sentence on `/guarantee` is retained without its editorial label and is removed at the storefront port. The 2026-10-01 founder revision makes these pages independent of the later privacy notice and Trustpilot link tickets.

| Content file | Permanent storefront target |
|---|---|
| `src/content/legit.md` | `/legit` |
| `src/content/guarantee.md` | `/guarantee` |
| `src/content/about.md` | `/about` |

`/guarantee` and `/about` are prerendered. `/legit` remains server-rendered and always shows the original Reviews paragraph and plain profile link. It emits no Trustpilot script. The shared trust-page layout has only the first-party page-view emitter; the light and dark palettes follow the visitor's colour-scheme preference through `src/styles/tokens.css`.

## Edge cases and error states
Content file missing or failing frontmatter validation → **the build fails.** A trust page that 404s in production is worse than a slow build. A claim that cannot be substantiated → it does not ship; `docs/brand/copy-rules.md` governs. Content changed after the storefront port has begun → **reconcile in this repository first**, then re-port, and record the checkpoint.

## Acceptance criteria
- [ ] Pages live at `/legit`, `/guarantee`, `/about` — **the exact URLs the storefront will keep**
- [ ] All prose is in `src/content/`, **not inline in markup** — asserted by a scan for prose blocks in `.astro` files
- [ ] Frontmatter is schema-validated; **a validation failure fails the build**
- [ ] `/guarantee` and `/about` are static with only the approved first-party page-view emitter; `/legit` emits no Trustpilot loader and always shows the "not yet" Reviews paragraph and profile link
- [ ] Every claim is checkable and traceable to a source document
- [ ] The pages read correctly in both themes and at every breakpoint
- [ ] A **port checklist** exists recording which content files map to which storefront routes

## Telemetry
Page views by entry source, scroll depth, signup rate for visitors who read a trust page versus those who do not — the number that justifies the effort.
