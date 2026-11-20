# E11.6-16 — Price-page audit and founder sign-off

Date: 2026-11-20. Scope: every price route the build generates from the committed data of the founder's first monthly run (E11.6-15, pull request #173), served by the repository's own build. The browser checks ran in the version-pinned Playwright Chromium container (`mcr.microsoft.com/playwright:v1.62.1-noble`) against a disposable migrated PostgreSQL on the local Compose stack. **Status: the audit has run and its gates pass. The founder decided findings L2, L3, V2 and P1 on 2026-11-20 (D-040, on the ticket's plan entry), and completed V2 on 2026-11-21 (D-041). L1, L2, V2 and P1 are fixed, and L3 is recorded as a known false positive. The contact sheet is regenerated for the founder's sign-off, which is the one item left (§11).**

## 1. The data and the routes

`data/price-index/latest.json` (built 2026-11-20T14:13:42Z, identical to `snapshots/2026-11-20.json`) holds 460 records: 158 `ok`, 3 `needs_review` (Netflix Basic, Standard and Premium in Romania, which the source listed in EUR, not RON) and 299 `missing`. From them, the build generates **158 price routes**:

| Kind | Routes |
|---|---|
| Service × market page | 128 (19 catalogue services, 20 markets; 158 plan rows) |
| Ledger URL with lost data ("temporarily unavailable") | 0 |
| Service hub, `/prices/{service}` | 7 |
| Market hub, `/prices/countries/{country}` | 20 |
| `/prices` | 1 |
| `/price-index` | 1 |
| Monthly report, `/price-index/2026-11` | 1 |

The audit derives what each route must show from the raw files, never from the page view model the pages render from. It uses the generation rule (`generatedPages`), the publish gate (`publishedView`), `rankMarkets`, `changes.json`, the monthly file and the snapshot it names. Every route kind is listed once in `test/helpers/price-audit.mjs` (`committedPriceData`), which all four parts of the audit read: the HTTP audit, the browser audit, the privacy crawl and the contact sheet. The unavailable state has no route in the committed data. It is crawled on the price fixture site by E11-05's existing test, and captured on the contact sheet from the fixture site (§8).

## 2. The internal-link graph

`test/e11-6-16-price-routes.test.mjs`, the "link graph" tests, reading the served HTML of every route:

| Check | Result |
|---|---|
| No link on any route goes to a price route the data does not generate, or to a page the site does not have | Pass, 158 routes (`sourcePagePaths()` is the site's page set) |
| Every service × market page links its service hub, and each service hub links exactly the pages of its service | Pass, 128 pages, 7 hubs. A service with no page has no hub |
| Every service × market page links its market hub, and each market hub links exactly the pages in its market | Pass, 128 pages, 20 hubs |
| Category neighbours: each page links exactly the generated pages of the same category in its market, in catalogue order, and shows the block only when there is one | Pass, 105 pages with neighbours |
| `/prices` links every hub. `/price-index` links every monthly report and `/prices`. Every service × market page and report links the methodology | Pass |
| Each monthly report links exactly the generated pages and hubs it mentions and names the rest without a link | Pass. 2026-11 has no changes; its nine extreme sentences link 7 service hubs and 14 distinct pages |
| Every price route is reachable by links from the landing page (the footer's "Price index" link, D5) | Pass, all 158 |

## 3. Structured data

"structured data validates on every price route": every route carries exactly the JSON-LD its kind should, and each block validates.

- **Organization** equals `organisationData()` on every route.
- **BreadcrumbList** passes a strict schema.org check (`breadcrumbListIssues` in `test/helpers/structured-data.mjs`: ListItems numbered from 1, names, canonical site URLs, the last item the page itself). It mirrors the visible breadcrumb name for name and link for link. Its trail is the documented one: Valstara → the page for a service × market page; Valstara → Prices → the hub; Valstara → Price index → the report.
- **FAQPage** is on all 128 generated pages and nowhere else. It passes `faqPageIssues`, and its questions and answers equal the visible FAQ exactly.
- **Dataset** is on `/price-index` only. It passes `datasetIssues` (moved from `test/price-index/price-index-pages.test.ts` to `test/helpers/structured-data.mjs` so both tests read one check). Its `temporalCoverage` (2026-10-28/2026-11-19) and `dateModified` are the oldest and newest verification dates of the published records, and its `spatialCoverage` is exactly the 20 enabled markets.
- The E9-06 and E9-07 head check (`checkRenderedHead`) passes on every route: a unique title and description, a self-canonical and the social cards.

## 4. The privacy gates over a crawl of every price route

`test/e11-05-page-inventory.test.mjs`, "E11.6-16 crawls every price route of the committed data". It is the E11-05 `crawl()` itself, unchanged except that a caller can now say a path in `notFoundPaths` is expected to answer (the fixture crawl's `/price-index/2026-11` is a real report in the committed data). It crawls all 158 routes, eight at a time.

- **No cookie** is set or read on any route.
- **No storage identifier.** The only storage access is the theme preference and, on a page with the signup form, Cloudflare's `cf.turnstile.u` in its own origin.
- **No third-party request beyond Turnstile.** On each of the 128 service × market pages the crawl types into the signup field and waits for the real Turnstile token. Turnstile is loaded on exactly those 128 pages and on no hub or report.

Result: **pass, 158 of 158**, in 143 s on 2026-11-20. The privacy allowlist is still exactly `challenges.cloudflare.com`. No page requested `static.cloudflareinsights.com`.

## 5. The accessibility gate

`test/e11-6-16-price-browser.test.mjs`, "accessibility: every price route of the committed data has zero WCAG 2.2 AA violations at every design width in both themes". It is the same axe-core run (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) as `test/accessibility.test.mjs`, on the page at rest. It covers every route at all eight design widths (320, 360, 390, 768, 1024, 1280, 1440 and 1920) in both themes: **2,528 axe runs, zero violations**. "the price-route runner fails on a planted violation" proves the runner: an image without alternative text, planted in a real price page, is reported as `image-alt`.

## 6. Performance

`test/e11-6-16-price-browser.test.mjs`, "performance: each price page kind holds LCP < 2.5 s, CLS < 0.1 and INP < 200 ms in the lab harness". The E11.5-12 harness (`scripts/design/landing-performance.mjs`) gains `measurePagePerformance`, which measures any path in the same way. That means a 390 × 844 mobile context (device scale 3, touch) with the CPU slowed four times. Turnstile's loader is answered by a stand-in whose widget never calls back, so the figures are the site's own.

INP is read from the browser's Event Timing entries for the interactions performed after the page settles:

- on every page, tapping the theme toggle twice and pressing Tab;
- on a service × market page, also tapping the signup field and typing a character.

INP is the worst interaction's duration, which is INP for a page with fewer than 50 interactions. `performance.interactionCount` must count every interaction performed. "performance: the INP measurement reports a planted slow interaction" proves the reading: a click handler that holds the main thread for 300 ms is measured at 300 ms or more.

The representative of each kind is its largest page by served HTML. Figures from the run on 2026-11-20, after L1's fix:

| Kind | Page measured | LCP | Its element | CLS at load / after interaction | Interactions | INP | First-party JavaScript |
|---|---|---|---|---|---|---|---|
| Service × market page | `/prices/netflix/netherlands` | 176 ms | H1 | 0 / 0 | 5 | 40 ms | 15,627 bytes |
| Service hub | `/prices/netflix` | 120 ms | H1 | 0 / 0 | 3 | 64 ms | 1,112 bytes |
| Market hub | `/prices/countries/netherlands` | 128 ms | H1 | 0 / 0 | 3 | 40 ms | 1,112 bytes |
| `/prices` | `/prices` | 104 ms | P | 0 / 0 | 3 | 72 ms | 1,112 bytes |
| `/price-index` | `/price-index` | 116 ms | P | 0 / 0 | 3 | 40 ms | 1,112 bytes |
| Monthly report | `/price-index/2026-11` | 124 ms | LI | 0 / 0 | 3 | 40 ms | 1,112 bytes |

First-party JavaScript is uncompressed bytes of the page's own script files: the signup island and `page-view.js` on a service × market page, and `page-view.js` alone elsewhere. The run before L1's fix measured the same targets (LCP 108–192 ms, CLS 0, INP 40–112 ms).

The budget is LCP < 2,500 ms, CLS < 0.1 and INP < 200 ms. Every kind is well within it, with no layout shift at load or after the interactions.

## 7. Copy and claims, and the number-trace sweep

`test/e11-6-16-price-routes.test.mjs`, over the rendered text of every route:

- **Forbidden and placeholder copy.** No term of `scripts/forbidden-copy.json` (word-bounded, as the gate matches) appears, and no placeholder or broken copy ("TODO", "undefined", "NaN" and the like).
- **No source credit**, anywhere in any route's HTML, attributes and JSON-LD included. The names checked are the fetcher's source origin, every record's source and source-URL host, and their bare names.
- **Independence and names.** Every route states its independence. Each service × market page and service hub names its service exactly as the catalogue does, and each page names every plan it shows.
- **No Valstara price.** None renders with `prices.valstara_comparison` off (the default), and `config/valstara-prices.json` has no entry.

**The number-trace sweep** ("number trace" tests) asserts that every price on every route equals its published record:

- **Service × market pages.** The plan table is the page's published records exactly: plan, period, amount, currency, the displayed text and the verification date. The "Prices verified on" line is the newest of them. Each comparison is `rankMarkets()`'s rank, M and both extremes. History is exactly `changes.json`'s entries for the shown plans (none this month). Every "amount currency" and every other number in the page's own content traces to one of those. No value the gate holds back shows: Netflix in Romania, whose three values are all `needs_review`, has no page.
- **Hubs.** Every row is its market's published record in its market's currency. A service hub's rows are in `rankMarkets()` order, unranked markets last by name, with each row's rank attribute.
- **`/prices` and `/price-index`.** They state only the data's oldest and newest verification dates, plus the methodology's settings (40%, 45 and 90 days), which E11.6-13's reconciliation test ties to the configuration.
- **The monthly report.** Every figure is its file's. Each extreme equals the published record of the snapshot it names, at rank 1 and the last rank. The market count is the enabled markets. Each spread ratio in the feed is recomputed from the two named records, and no report page shows one: the spread is not a number the page may show, and no report page contains "times the cheapest" (D-040 item 2).
- **Everywhere.** No `$`, `€`, `£`, `¥`, `≈` or "approx" appears, and every USD amount on any route is a US list price.

Result: pass, with no unpublished, mismatched or converted price. **Finding P1** concerned the one number on a page computed from the source's USD figures, the monthly report's spread ratio. The page no longer shows it (§9).

**Red paths.** Each check above, run on a real served page with a planted defect, fails:

- a plan price changed by one unit fails "shows exactly its published records";
- "About 13.22 USD a month." fails as an untraced amount, and "≈" as a converted figure;
- "Save 20% today." fails as an untraced number;
- a held-back value (Netflix Romania's 5.99 EUR) planted on a EUR page fails as unpublished;
- a link to an ungenerated pair fails the link check, and so does a link to an unknown page;
- each source name, planted in any case, fails the source check;
- seven malformed BreadcrumbList variants each fail `breadcrumbListIssues`.

The first red-path run caught a defect in the sweep itself: the plan-table check read the cached served page instead of the document passed to it. It was fixed before any result here was recorded.

## 8. The contact sheet

`node --import tsx scripts/design/price-contact-sheet.mjs` generates it through E11.5-01's `captureContactSheet`. Every capture is at rest under reduced motion, and the layout checks run on each capture. It covers all eight design widths in both themes, **12 states and 192 captures**, in 81 s. The script refuses to run if any route kind of the committed data has no state. It is not committed: the images are in `.design-contact-sheets/e11-6-16/` (`committed/`, `paused/` and `fixture/…`, each with an `index.html`), with `summary.json`.

| State | Source |
|---|---|
| The largest service × market page (`/prices/netflix/netherlands`, three plans, comparisons, related services, FAQ) | Committed data |
| The smallest service × market page (`/prices/chatgpt/spain`) | Committed data |
| The largest service hub (`/prices/netflix`) and market hub (`/prices/countries/netherlands`) | Committed data |
| `/prices`, `/price-index` and the 2026-11 report | Committed data |
| `prices.pages` off: the 503 paused card on a page and on `/prices` | Committed data |
| A ledger URL whose data is lost (unavailable) | Price fixture site |
| A page with price history (`/prices/netflix/sweden`) | Price fixture site |
| A page with the Valstara comparison, `prices.valstara_comparison` on | Price fixture site |

After L1's fix, the layout checks flagged 100 of the 192 captures, all under findings L2 and L3 below. The paused states are clean. The full contact sheet (`scripts/design/full-contact-sheet.mjs`) leaves the price pages to this sheet, as its flag analysis says.

**Regenerated 2026-11-20, after D-040 items 2 and 3 and the first build of item 5.** 192 captures in 86 s, 54 with layout issues. This sheet is **not for sign-off**: item 5 is not finished (§9, V2), and D-040 item 1 says a sheet generated before items 2, 3 and 5 are built is never signed off.

| Layout issue | Captures | Finding |
|---|---|---|
| "overflowing text: div / label" on the price call to action, 1024px and up, both themes | 40: the five states with the call to action (two committed, three fixture) × four widths × two themes | L3, a known false positive (§9) |
| "overflowing text: div" (and "article" on the service hub), 320px, both themes | 8: the largest service × market page, both hubs, the fixture history page | V2: a table is 2–26px wider than the 240px column |
| "horizontal overflow", "overflowing text: main / article / div", 320, 360 and 390px, both themes | 6: the fixture Valstara comparison | V2: the five-column table needs 513px |
| "small target" | 0 (was 596) | L2 fixed |

**Regenerated 2026-11-21, after D-041. This is the sheet for the founder's sign-off** (D-040 item 1: items 2, 3 and 5 are built). It has 192 captures, taken in 79 s, and 40 have layout issues. Every one is L3's known false positive (§9). There is no V2 width issue at any width, and no other issue.

| Layout issue | Captures | Finding |
|---|---|---|
| "overflowing text: div / label" on the price call to action, 1024px and up, both themes | 40: the five states with the call to action (two committed, three fixture) × four widths × two themes | L3, a known false positive (§9) |
| Any other | 0. That includes the fixture Valstara comparison at 320, 360 and 390px, which fits by wrapping (§9, V2) | — |

## 9. Findings

| # | Finding | Status |
|---|---|---|
| **L1** | **Every price heading overflowed its line box.** The service × market page, hub and report layouts set their H1 at `--step-4` (24px), and from 48rem at `--step-5` (32px), on `--leading-1` (a 20px line), so a wrapped heading's lines nearly touched. The layout checks flagged "overflowing text: h1" on every route at every width. | **Fixed.** Each H1 now takes its step's own leading: `--leading-4`, then `--leading-5` from 48rem. "L1: no price page heading overflows its line box, at every design width in both themes" fails before the fix (320 to 1920px) and passes after |
| **L2** | **Price-page links were not the site's text links.** Below 48rem, every standalone link on a price page is under the 44px target the rest of the site gives its links (`docs/brand/page-design.md`: text links, document prose). That covers the breadcrumb, the methodology link, the related and "More prices" links, the hub table and list links, the report links and `/price-index`'s report list, measured at 16–40px tall. Most of them also draw in the browser's default link colour (blue in light, lavender in dark), not ink with the coral underline. The price pages were never given a page design or added to `enforcedPages`, so no check required this. Axe's WCAG 2.2 target-size rule (24px, with its spacing exception) passes | **Fixed (D-040 item 3).** Every such link is the `TextLink` component (`src/components/text-link.astro`): ink at 500 with the 2px coral underline offset 3px. Below 48rem it is an inline-flex box at least `--tap-min` each way around the text link's own 12px vertical padding, and from 48rem inline text again. A hub or report table link is a block that fills its cell (a stretched `::after`), so the cell is the target. Tokens only. "L2: every price page link is a 44px text link below 48rem, in both themes" covers every route at 320, 360 and 390px in both themes, and fails on the old styling (42,402 issues: 16–40px tall, the browser's link colours, weight 400, and cells the link does not fill). The regenerated sheet has no small target |
| **L3** | **The consent checkbox's 44px hit area overhangs a one-line label.** In the price-page call to action from 1024px, the signup form is wide enough for the marketing consent label to fit on one line (20px tall). The checkbox's transparent 44px input, centred on its 20px box by design, then reaches 12px below the label, and the layout checks report "overflowing text: div / label". Nothing is clipped, overlapped or visible. On `/` and below 1024px the label wraps to 40px and contains it | **Accepted as the component's intended hit area (D-040 item 4): a known false positive of the layout checks.** Confirmed on 2026-11-20 at 1024, 1280, 1440 and 1920px in both themes, on every state with the price call to action (`/prices/netflix/netherlands`, `/prices/chatgpt/spain`, and the fixture `/prices/apple-music/united-states` and `/prices/netflix/sweden`, measured with the Valstara comparison on; the history state is the same page without it). The input (`#signup-marketing`) is 44px tall and ends 12px below its 20px label and 12px inside the form. Its box overlaps no other control or link, no ancestor clips it, and the topmost element inside the overhang is the input itself. No check, gate, allowlist or component was changed |
| **V2** | **Narrow price tables break words.** At 320–390px the tables' `overflow-wrap: anywhere` breaks a market name mid-word ("Switzerla/nd" in the comparison table) and splits a price from its currency ("15.99 / EUR"). No check flags it. It shows on the contact sheet | **Fixed (D-040 item 5, D-041).** The three layouts drop `overflow-wrap: anywhere`, and a price (`.price-table__amount`) no longer wraps, so prices stay whole and names break only at spaces. With that alone, at 320px a table on 105 of the 158 committed routes was 242–266px wide in its 240px column. D-041 narrows the cells to fit. Below 48rem a cell's inline padding is `--space-0-5`, and the first and last cell of each row have none at the table's outer edge. From 48rem the padding is `--space-2` as built. Block padding, type size, the gutter and `Container` are unchanged, and there is no scroll container. Every committed table now fits at 320 and 390px. **The exception is the Valstara comparison** (`[data-valstara-comparison]`, behind `prices.valstara_comparison`, default off). Its five columns need about 295px of words and prices that cannot break, so no padding fits them. It alone keeps `overflow-wrap: anywhere`, and its amounts wrap as they did before D-040. It fits only by breaking them. **It has no narrow-screen layout, and `prices.valstara_comparison` must not be turned on until a narrow-screen layout for it is designed and built in its own ticket** (D-041, also in `docs/features/price-index.md`). "V2: at 320 and 390px every price table keeps prices whole, breaks no word and fits, and the Valstara comparison fits" covers every committed route. It also covers the three fixture pages with a Valstara comparison, served with the flag on, where it holds that table to fitting only. It passes. It fails on the pre-D-040 CSS (1,737 issues: broken words, split prices). Without the Valstara exception it fails with the comparison 266px wide in 240px. Without the zero edge padding it fails with six hub tables 2px over |
| **P1** | **The monthly report's spread ratio was computed from the source's USD figures.** "The most expensive market costs 3.9 times the cheapest" is the most and least expensive markets' `price_usd_source` divided (E11.6-09, `docs/features/price-index.md#change-log-and-monthly-report`). No USD figure is shown, but the ratio is a converted comparison, and it reads against the local prices beside it: "most expensive in the United States (14.99 USD), least expensive in Poland (15.50 PLN) … 3.9 times". It traces exactly to the documented computation | **Fixed (D-040 item 2).** Each extremes sentence on `/price-index/{yyyy-mm}` ends at the least expensive market's price. `src/server/prices/site.ts` no longer appends the ratio, and the page-only `spread` template is gone from `src/copy/prices.ts`. `spread_ratio` stays in `data/price-index/monthly/*.json` and in the founder's Markdown report, unchanged, and the November data did not change. The number trace no longer allows the ratio on a report page and asserts that none contains "times the cheapest". `test/price-index/price-index-pages.test.ts` drops the ratio from the two October sentences (the founder's named rewrite) |

Not a finding: a service × market page's breadcrumb is Valstara → the page, as `docs/features/price-index.md#pages` documents, while the hubs' run through Prices. The page links both its hubs under "More prices".

## 10. Commands run

All on branch `feat/E11.6-16-price-page-audit-and-founder-sign-off`, the local Compose stack up.

| Command | Date | Result |
|---|---|---|
| `npm test -- test/e11-6-16-price-routes.test.mjs` | 2026-11-20 | First run 19 of 19 pass. The red paths, added next, caught the sweep reading the cached page (§7). After that fix, 22 of 22 pass |
| `npm test -- --test-name-pattern="E11.6-16" test/e11-05-page-inventory.test.mjs` | 2026-11-20 | 1 of 1 passes, 158 routes in 143 s |
| `npm test -- test/e11-6-16-price-browser.test.mjs` | 2026-11-20 | 4 of 4 pass, in 245 s |
| `node --import tsx scripts/design/price-contact-sheet.mjs` | 2026-11-20 | 192 captures, 160 with layout issues (L1, L2, L3) |
| "L1: …" with the heading fix reverted, then restored | 2026-11-20 | Fails at 320–1920px before the fix and passes after |
| `node --import tsx scripts/design/price-contact-sheet.mjs`, after L1's fix | 2026-11-20 | 192 captures in 81 s, 100 with layout issues (L2, L3) |
| `npm run check` | 2026-11-20 | Passes: price-index validate, lint, format, typecheck, the security and privacy gates (with the new files tracked), the build |
| `npm run test:changed -- test/e11-6-16-price-routes.test.mjs test/e11-6-16-price-browser.test.mjs test/e11-05-page-inventory.test.mjs` | 2026-11-20 | The three named files plus the changed `test/helpers/price-audit.mjs`, `test/helpers/structured-data.mjs` and `test/price-index/price-index-pages.test.ts`: **43 tests, all pass**, in 518 s |
| `npm test -- --test-name-pattern="^(L2\|V2)" test/e11-6-16-price-browser.test.mjs`, with the three price layouts as they were before D-040 | 2026-11-20 | Both fail: L2 with 42,402 issues, V2 with 1,723 (broken words, split prices) |
| The same, after D-040 items 3 and 5 | 2026-11-20 | L2 passes. V2 fails on width alone: 271 issues, all at 320px (§9, V2) |
| `node --import tsx scripts/design/price-contact-sheet.mjs`, after D-040 items 2 and 3 and the first build of item 5 | 2026-11-20 | 192 captures in 86 s, 54 with layout issues (L3 and V2, §8). Not for sign-off |
| A diagnostic script (not committed) at 1024–1920px in both themes on the four price call-to-action states | 2026-11-20 | L3's overhang overlaps no control or link and is not clipped (§9) |
| `npm test -- --test-name-pattern="^V2" test/e11-6-16-price-browser.test.mjs`, after D-041 | 2026-11-21 | Passes: every committed route, and the three fixture Valstara pages with the flag on |
| The same, with the three price layouts as they were before D-040 | 2026-11-21 | Fails: 1,737 issues (broken words, split prices) |
| The same, without the Valstara table's `overflow-wrap: anywhere` | 2026-11-21 | Fails: the fixture comparison on `/prices/netflix/sweden` is 266px wide in 240px at 320px (28 issues) |
| The same, without the zero padding at the table's outer edges | 2026-11-21 | Fails: six hub tables are 242px wide in 240px at 320px (8 issues) |
| `node --import tsx scripts/design/price-contact-sheet.mjs`, after D-041 | 2026-11-21 | 192 captures in 79 s, 40 with layout issues, all L3's false positive (§8). The sheet for sign-off |
| `npm run check` | 2026-11-21 | Passes |
| `npm run test:changed -- test/e11-6-16-price-routes.test.mjs test/e11-6-16-price-browser.test.mjs test/e11-05-page-inventory.test.mjs test/price-index/price-index-pages.test.ts` | 2026-11-21 | The four named files plus the changed `test/helpers/price-audit.mjs` and `test/helpers/structured-data.mjs`: **45 tests, all pass**, in 557 s |

## 11. Founder sign-off

**Pending.** The founder decided findings L2, L3, V2 and P1 on 2026-11-20 (D-040), and V2's narrow tables on 2026-11-21 (D-041). Items 2, 3 and 5 are built and the sheet is regenerated (D-040 item 1, §8). The founder now reviews `.design-contact-sheets/e11-6-16/`, and either signs off or names changes. The sign-off is recorded here.

| Item | Status |
|---|---|
| Finding L1 | Fixed in this ticket |
| Finding L2 | Fixed (D-040 item 3) |
| Finding L3 | Accepted, a known false positive of the layout checks, confirmed (D-040 item 4) |
| Finding P1 | Fixed (D-040 item 2) |
| Finding V2 | Fixed (D-040 item 5, D-041). The Valstara comparison has no narrow-screen layout, so `prices.valstara_comparison` stays off until one is built in its own ticket |
| Contact-sheet review and sign-off | Waiting on the founder |
