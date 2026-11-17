# Feature: Price index and price pages

Founder-authorised 2026-11-17. Built by Epic E11.6 (`docs/plan/development-plan.md`). **This spec is the in-repository record of the founder's brief.** The brief has no other source, so every E11.6 ticket reads this file.

## Summary

Valstara sells subscriptions (AI, streaming, music, productivity) and later other digital goods below list price. The buyers assume the category is full of scams, so **every price Valstara publishes has to be precise, accurate and verifiable.** A wrong price on our own page damages the brand directly.

The **price index** records the official list prices of the subscriptions we track in every market we serve. It is refreshed once a month. It feeds:

1. **Programmatic price pages** on the pre-launch site: one template for each service and country (e.g. "Spotify Premium price in Sweden"), plus hubs. They rank for long-tail searches before launch and bring in waitlist signups.
2. **The monthly change report** the founder sends to journalists, newsletters and communities ("Spotify raised prices in 4 of our 18 markets this month"). It needs a reliable change log.
3. **Later, outside this repository:** the overpay calculator and the storefront's "official price vs Valstara price" comparison. They read the same data files, so the data must be framework-agnostic.

**What sets these pages apart:** other price-by-country sites show only official prices. Ours will eventually show the official price next to the Valstara price in each market. Before launch there is usually no Valstara price, so every page has to work without one.

### Two separate things: a tool and some pages

| | The price-index tool | The price pages |
|---|---|---|
| Where | `packages/price-index/` | `src/pages/prices/`, `src/pages/price-index/` |
| Runs | **Only when the founder types the command**, on the founder's machine, once a month | Inside the site, like every other page |
| Lifetime | Starts, fetches, writes files, **exits**. No daemon, no timer, no watcher | Always on |
| Network | One source site and the ECB rates file, politely | None at runtime |
| Writes | Files under `data/`, `reports/`, `config/` (overrides only) | Nothing |
| Reaches the browser | Never | Server-rendered HTML; the existing signup and theme islands only |

**The tool cannot affect the running site (founder requirement, 2026-11-17).** It is not started by `npm run dev`, `npm start`, Docker Compose or the production image. The site never reads the tool's working files. The pages read only the committed `data/price-index/` files, and only at build time. New prices go live only through the ordinary path: a pull request, CI, merge and deploy. A scraper crash, a block by the source, or bad data can therefore at worst leave the founder without a new data commit. Even then, the site keeps serving the last merged prices until they go stale.

## Feature flag

| Flag | Default | Off means |
|---|---|---|
| `prices.pages` | **on** | Every `/prices/**` and `/price-index/**` route answers `503` with `Retry-After` and `noindex`, and the sitemap is unchanged. **This is the lever for a wrong price that has gone live**: it pulls every price page at once without a deploy, and the 503 does not cost the URLs their index status |
| `prices.valstara_comparison` | **off** | No Valstara price renders anywhere, even where `config/valstara-prices.json` has an entry. A Valstara price shown before launch is a public price commitment, so it stays off until the founder turns it on |

The tool has no flag. It is never started by the site, so there is nothing to switch off.

## Markets, catalogue and data

### Markets (`config/markets.json`)

Each market has its ISO 3166-1 alpha-2 code, display name, URL slug, ISO 4217 currency and an `enabled` flag. Seed, all enabled: United Kingdom (GBP), Germany, Spain, France, Italy (EUR), Poland (PLN), Romania (RON), Sweden (SEK), Norway (NOK), Denmark (DKK), Finland (EUR), Switzerland (CHF), Netherlands, Croatia, Ireland, Austria, Portugal (EUR), and Canada (CAD). **The United States (USD) and Australia (AUD) are seeded with `enabled: false`** until the founder decides (open question Q4).

### Catalogue (`config/catalogue.json`)

Each service has a `service_id` (slug), display name, category (`ai`, `streaming`, `music`, `productivity`, `learning`, `fitness`), official website URL, `status` (`selling_now` | `launch` | `planned`), `plans[]` and `source_aliases`. Each plan has a `plan_id`, display name, `billing_period` (`month` | `year`), and `is_student` and `is_family` flags. `source_aliases` lists the names the source uses for the service and for each plan. They are used for matching, and nothing else.

**Products confirmed for sale (founder, 2026-11-17):** Adobe Creative Cloud · Amazon Prime Video (Amazon Prime) · Apple TV · Apple Music · Bolt.new Pro · Canva Pro · ChatGPT Plus · Crunchyroll Mega Fan · Duolingo Super · Duolingo Max · Figma Professional · LinkedIn Premium Career · LinkedIn Premium Business · Lovable · MyFitnessPal · n8n Starter · Netflix Basic, Standard and Premium (4K) · Notion Plus · Perplexity Pro · Spotify Premium Individual · YouTube Premium. The plan tiers still to confirm, with recommended defaults, are in open question Q2.

**Adding or removing a service or plan is a data change, never a code change.** Every layer reads the catalogue: matching, merge, coverage, the change log, reports and pages. Every E11.6 ticket that consumes the catalogue tests both an addition and a removal against its own layer.

- **Added:** the new combinations appear as `missing` until data arrives. No page exists for them until a plan passes the publish gate.
- **Removed:** the service's records leave `latest.json`. Snapshots and `changes.json` keep their history unchanged, since history is never rewritten. A URL that was ever published stays served, as described under "Edge cases".

**Each source country page lists a different number of services** (e.g. Sweden about 32, others 20–40). A combination the source does not list is a gap that gets flagged (`missing`). It is never an error.

### Valstara prices (`config/valstara-prices.json`)

Entered by hand by the founder for each service, plan, market and term (e.g. 12 months). Usually empty before launch. **No Valstara price is ever invented, estimated or derived.** The comparison block renders only when an entry exists and `prices.valstara_comparison` is on. The comparison is like for like: it compares against the official price for the same billing period where one is tracked. Otherwise it compares against the monthly list price multiplied by the term, and the page says so in words.

### The price record

One record per market × service × plan × billing period:

| Field | Rule |
|---|---|
| `market`, `service_id`, `plan_id`, `billing_period` | Identity |
| `price_local` | **An exact decimal string at the currency's minor-unit exponent** (`"149.00"`). Arithmetic is done in integer minor units. **A float never holds a price** |
| `currency` | Must equal the plan's expected currency (the market currency unless the catalogue says otherwise, see Q3). A mismatch is flagged |
| `price_usd_source` | The USD figure the source shows, if it shows one. Recorded and never displayed as our conversion |
| `fx` | `{ usd_rate, eur_rate, rate_date, provider }`: **our own conversion**, with the rate we used |
| `source` | `scraper:youfundceo.com` · `manual` · later `direct:<provider>` |
| `source_url`, `observed_at`, `source_verified_at` | Where and when; `source_verified_at` is the source's own "last updated" date, if it shows one |
| `status` | `ok` · `missing` · `needs_review` · `manual_override` · `stale` · `conflict` |
| `missing_reason` | When `missing`: `source_no_price` (listed in the source's "No price shown" section) · `not_listed` · `parse_failed` · `market_failed` |
| `notes` | Free text |

### Files

| Path | Committed | What |
|---|---|---|
| `config/markets.json`, `config/catalogue.json`, `config/valstara-prices.json`, `config/price-index.json` | yes | Configuration and tool settings (delays, thresholds, staleness, sample sizes, retention, source credit) |
| `data/price-index/latest.json` | yes | **The merged current view the pages build from** |
| `data/price-index/snapshots/YYYY-MM-DD.json` | yes | One per build, immutable. A second build on the same date takes a numeric suffix and never overwrites |
| `data/price-index/changes.json` | yes | **Append-only** log of real price changes |
| `data/price-index/manual-overrides.json` | yes | Hand-entered prices |
| `data/price-index/approvals.json` | yes | **Append-only** founder approvals of `needs_review` and `conflict` values, each with an actor |
| `data/price-index/fx/YYYY-MM-DD.json` | yes | The reference rates each build used |
| `data/price-index/monthly/YYYY-MM.json` | yes | The monthly report data that feeds `/price-index/{yyyy-mm}` |
| `data/price-index/published-urls.json` | yes | **Append-only** ledger of every price URL ever published |
| `data/raw/<run_id>/…` | **no** (gitignored) | Raw fetched pages, normalised observations, checkpoint. Rotated (keep the last N runs) |
| `reports/coverage-YYYY-MM-DD.{md,json}`, `reports/monthly/YYYY-MM.md`, `reports/runs/<run_id>.json` | yes | Gap reports, outreach summaries, one structured log per run |

**The JSON feed is a repository file, not a served endpoint.** A public API is permanently out of scope (`AGENTS.md`). The storefront imports the files.

## The source: youfundceo.com

The founder picked this source after comparing several. It was the only one that caught Spotify Sweden rising from 129 to 149 SEK (October 2026). It also correctly shows YouTube Premium Individual in Sweden at 169 SEK, where other sites and Google's AI answer still showed 149 SEK.

**What to read on each country page (founder, 2026-11-17):** `/countries` lists the countries, and `/countries/<country>` (e.g. `/countries/sweden`) is a country page.

- **The top section** lists every service with its current monthly price, in USD and in local currency. **This is the data.**
- **"What you get in <country>"** is not scraped.
- **"No price shown for <country>"** at the bottom **is scraped**. Each service listed there becomes a `missing` record with `missing_reason: source_no_price` for every tracked plan of that service, so it is flagged together with every other gap.

**What the 2026-11-17 check of `robots.txt` found (one request, before the spike):** the `*` group allows `/` and disallows only `/api/` and `/go/`. A separate group disallows the whole site to named AI agents, including `ClaudeBot`, `anthropic-ai`, `Claude-Web`, `GPTBot`, `CCBot` and `Scrapy`. The responses carry `ETag` and `Last-Modified`, and the site is served by Vercel. So:

- **No AI agent session fetches the site.** E11.6-01's fixtures are captured by the founder in a browser, and agents work on them offline.
- **The tool identifies itself honestly** with its own user-agent token and a contact URL, and obeys the group that applies to that token, otherwise `*`. It never sends a browser user agent, and never one from the disallowed list.
- **Nothing under `/api/` or `/go/` is requested**, however stable a JSON endpoint there looks.

**Fetching rules.** One request at a time. A randomised delay between requests (default 8–20 s, configurable), or the source's `Crawl-delay` if longer. It fetches only `/robots.txt`, `/countries` and the pages of enabled markets, and never crawls the whole site. It backs off exponentially on 429, 403 and 5xx, honouring `Retry-After`, and stops the run cleanly after repeated failures. **There is no proxy rotation, no CAPTCHA solving and no fingerprint evasion. If the source blocks us, that is a signal for the founder, never something to work around.** It makes conditional requests (`If-None-Match`, `If-Modified-Since`). It checkpoints after each market and resumes an interrupted run.

**Matching.** The source's service and plan names are matched to the catalogue through `source_aliases` only, after normalising case, whitespace, punctuation and diacritics. A source entry that matches nothing is listed in the run report as "untracked on source". A fuzzy matcher may *suggest* an alias, and **never accepts one**.

## Validation, merge and the publish gate

- **Precedence.** A manual override fills any gap. If the scraper agrees with the override, the record is `ok` and the coverage report marks the override as retirable. **If they disagree, the record is `conflict` and both values are shown. Neither silently replaces the other.**
- **Rules.**
  - The currency must equal the expected currency.
  - The price must be > 0.
  - The billing period must be known.
  - A change of more than ±40% (configurable) from the previous published value makes the record `needs_review`.
  - A record not refreshed or verified within 45 days (scraped) or 90 days (manual), both configurable, becomes `stale`.
  - **A plan that disappears from the source where it existed before becomes `needs_review`, and is never deleted silently.**
  - A market whose page failed to fetch or parse keeps its previous values, which go stale on schedule.
- **Human decisions.** `needs_review` and `conflict` resolve only by a founder action recorded in `approvals.json` with an actor. An approval binds to the exact value approved, so a different value later needs a new approval.
- **The publish gate.** **Only `ok` records and approved `manual_override` records ever reach a page, a hub, a sitemap entry, an FAQ answer, a comparison or the monthly report's published figures.** `needs_review`, `conflict`, `stale` and `missing` are left out and listed in the coverage report. There is one implementation of the gate, and every consumer calls it.

## Change log and monthly report

A **real change** is a published value replaced by a different published value for the same record and currency. It is not a first observation, a status change or a formatting difference. A `needs_review` change is logged only when approved, dated by its observation. `changes.json` is append-only, and CI fails a change that edits or removes an existing entry.

`price-index monthly-report --month YYYY-MM` writes `reports/monthly/YYYY-MM.md` for outreach and `data/price-index/monthly/YYYY-MM.json` for the page. It contains:

- every change that month, largest first;
- the most and least expensive market for each plan, by ≈ EUR and ≈ USD at a stated FX date;
- each plan's spread across markets;
- counts such as "Spotify Premium — Individual rose in 4 of 18 markets".

## Pages

| Route | What |
|---|---|
| `/prices` | Top-level index |
| `/prices/{service}` | Service hub: every enabled market with a publishable price, ranked, linking to each page |
| `/prices/{service}/{country}` | **The main programmatic page** |
| `/prices/countries/{country}` | Market hub: every tracked service in that market |
| `/price-index` | Landing page and methodology |
| `/price-index/{yyyy-mm}` | The monthly report |

**These URLs are permanent. They will be ported to the storefront at launch.** The slugs come from the catalogue and markets config, and a slug never changes once published (the ledger enforces it).

**The service × market page** carries data specific to that page, so it is never thin content:

- The H1 and title, e.g. "Spotify Premium price in Sweden (November 2026)", dated from the last verification.
- The plan table: local price in monospace, ≈ USD and ≈ EUR, the FX date, and "last verified".
- Price history from `changes.json`, hidden when there is none.
- The rank across markets ("Sweden is the 3rd most expensive of our 18 markets for Spotify Premium — Individual", by ≈ EUR on a stated date), with a mini-table of the cheapest and most expensive markets.
- Related services in the same category in that market.
- The Valstara comparison, or before launch the waitlist call to action through the existing signup island with server-side `?ref=` capture intact.
- An FAQ built only from data.
- A methodology link and a "Prices verified on …" line.
- The configurable source credit.
- A plain statement that Valstara is not affiliated with the services listed.

**Generation.** A service × market page exists only when at least one of its plans passes the publish gate. Hubs list only pages that exist. The sitemaps list only pages that exist and are indexable.

**Copy.** Every sentence is a template in `src/copy/prices.ts` or a content file, filled from data. Nothing is typed per page. The rules of `docs/brand/copy-rules.md` apply in full:

- sentence case;
- no exclamation marks and no hype — "below list price", never "insane deal";
- "digital goods", never "digital products";
- provider names used plainly ("Spotify Premium — Family");
- "≈" on every conversion;
- no countdowns or scarcity;
- **never a price we do not have.**

## User flows

1. **Monthly run (founder).**
   1. `npm run price-index -- scrape` fetches enabled markets politely, saves the raw pages and writes the observations. The tool exits.
   2. `npm run price-index -- build-data` merges and validates them, then writes `latest.json`, a snapshot, the changes, the coverage report and the run log.
   3. The founder reads the console summary and the coverage report, then fills gaps with `override add`.
   4. The founder resolves `needs_review` and `conflict` with `review approve|reject`, then rebuilds.
   5. `npm run price-index -- monthly-report --month YYYY-MM` writes the month's report.
   6. The founder commits the data on a data branch and opens a pull request. CI validates it, and the founder merges and deploys. The runbook is `docs/ops/runbook.md#price-index-monthly-run` (E11.6-16).
2. **Search visitor.** Lands on `/prices/spotify/sweden`, reads the plan table, history and rank, and joins the waitlist through the signup island. A visitor who arrived with `?ref=` is attributed exactly as on `/`.
3. **Journalist.** Opens the `/price-index/2026-12` link from the outreach email. It lists the month's changes and links to every page it mentions.

## Edge cases and error states

- **The source blocks us (403, 429, a challenge page).** The run backs off, stops cleanly, and reports. Nothing is retried around the block. Prices keep their last values and go `stale` on schedule.
- **The source changes its page structure.** That market's parse fails loudly (`parse_failed`). It never yields zero records silently. Its previous values are kept, and the run report names the market.
- **A crash mid-write.** Every write is atomic (temporary file, then rename), so the previous `latest.json` survives intact.
- **An interrupted run.** It resumes from the last market checkpoint.
- **A previously published page loses all publishable data.** The page keeps rendering with a "temporarily unavailable" note and no price, carries `noindex`, and leaves the sitemap until data returns. **It never becomes a 404**, so indexed URLs do not churn. The published-URL ledger is what lets the site know it was published.
- **A service or market removed from config.** Its URLs behave exactly like lost data until the founder retires a URL with a recorded 301 target in the ledger (open question D2).
- **The FX rates file is unavailable or lacks a currency.** The conversion is absent and the page omits the ≈ values for that record. A rate is never guessed or carried forward silently.
- **`prices.pages` is off.** Every price route answers 503, `noindex`, `Retry-After`.

## Acceptance criteria

- [ ] The tool runs only on an explicit command and exits when done. Nothing in `npm run dev`, `npm start`, Compose or the production image starts or contains it, which is asserted.
- [ ] A failed, blocked or interrupted run leaves `data/price-index/latest.json` byte-identical.
- [ ] The tool requests only allowlisted hosts, obeys `robots.txt` for its own honest user agent, makes one request at a time, and backs off and stops on repeated trouble.
- [ ] Every currency in `config/markets.json` has parser tests against founder-captured fixtures.
- [ ] Prices are exact decimals end to end, and no float holds a price.
- [ ] Override precedence, conflict detection, staleness, disappearance and the ±40% threshold behave as specified. **Only `ok` and approved `manual_override` records reach any page.**
- [ ] `changes.json`, `approvals.json` and `published-urls.json` are append-only, and CI enforces it.
- [ ] Adding or removing a service, plan or market needs no code change, and every layer tests it.
- [ ] Pages exist only with publishable data. A previously published URL never 404s. Sitemaps list only indexable pages, with `lastmod` from the verification date.
- [ ] Price routes load no JavaScript beyond the signup and theme islands, and make no third-party request.
- [ ] Every number on a page traces to `latest.json` or `changes.json`, which a render test asserts.
- [ ] No Valstara price renders unless it exists in `config/valstara-prices.json` and `prices.valstara_comparison` is on.

## Telemetry

Organic entries and signups by price-page type (from Umami's page views and the existing server-side funnel events: no new event, and no property carrying personal data). Each run's counts are logged to `reports/runs/<run_id>.json`: fetched, not-modified, matched, unmatched, changed, flagged by status, and failed markets.

## Repository layout

```
config/
  markets.json  catalogue.json  valstara-prices.json  price-index.json
packages/price-index/            framework-agnostic TypeScript; imports nothing from Astro or src/
  src/
    schema/       Zod schemas for every config and data file
    money/        exact decimals, minor units, local number formats
    http/         the polite fetcher: robots, single flight, jitter, backoff, conditional requests, raw store
    sources/      the SourceAdapter interface; youfundceo/ (the first adapter); direct:<provider> later
    fx/           the FxProvider interface; the ECB adapter; conversion
    storage/      the PriceStore interface; the JSON-file implementation (atomic writes)
    pipeline/     matching, merge, validation, staleness, the publish gate, change detection
    reports/      coverage, run log, monthly report
    publish/      the read-only published view: the only entry the site and the storefront import
    cli/          the price-index command
  copy/           report sentence templates (forbidden-copy scanned)
  test/fixtures/youfundceo/   founder-captured pages, unmodified, with SHA-256s
data/price-index/…  data/raw/ (gitignored)  reports/…
src/server/prices/  page view models, built from packages/price-index/src/publish
src/pages/prices/…  src/pages/price-index/…
src/copy/prices.ts  src/content/price-index-methodology.md
test/price-index/   the tool's and the pages' tests, run by the existing runner
```

**The direction of dependencies is one way.** `src/` may import only `packages/price-index/src/publish` and `src/schema`, and a scan enforces it. The package imports nothing from `src/`. Storage and sources are interfaces. A database store or a `direct:<provider>` source (fetching official pricing pages through an in-country route) plugs in later without changing the pipeline. **Neither is built now.**

## Open questions for the founder

Each one names the ticket it blocks. That ticket reports `BLOCKED:` until the answer is recorded on it by the decision procedure (`docs/engineering/prompts/00-USAGE.md#decisions`). A recommended default is a recommendation, not a decision.

| # | Question | Recommended default | Blocks |
|---|---|---|---|
| Q1 | The source domain | **Answered 2026-11-17:** `https://www.youfundceo.com/`. Still to confirm: that the tool should operate under the `*` group with an honest user agent, given the AI-agent disallow group | E11.6-04 |
| Q2 | Plan tiers to track for the confirmed products | Adobe Creative Cloud: the all-apps individual plan. Amazon Prime: the Prime membership. Apple TV, Apple Music, Crunchyroll Mega Fan, Figma Professional, Notion Plus, Perplexity Pro, ChatGPT Plus, Canva Pro, Bolt.new Pro, Lovable Pro, MyFitnessPal Premium, n8n Starter: individual. Duolingo Super and Max as two plans of `duolingo`. LinkedIn Premium Career and Business as two plans of `linkedin-premium`. Netflix Basic, Standard and Premium, without the ads tier. Spotify Premium Individual. YouTube Premium Individual. **Also track the Spotify, YouTube Premium and Apple Music student plans** as comparison plans, because students compare against student pricing. All `status: launch`. All monthly; yearly plans only by manual override. The brief's other provisional services (Gemini, Disney+, HBO Max, Deezer, YouTube Music, Duo and Family plans) are not tracked until confirmed | E11.6-02 |
| Q3 | Services billed in USD or EUR everywhere (many AI and productivity tools) | A per-plan `expected_currency` in the catalogue, defaulting to the market currency. A mismatch against *that* is flagged, so a correctly USD-priced service is not permanently `needs_review`. Confirm after the spike shows how the source displays them | E11.6-02 |
| Q4 | Include the United States and Australia? | Keep `enabled: false` until the storefront confirms it will sell there. Enabling one later is a config change | E11.6-02 |
| Q5 | How often to run | **Answered 2026-11-17:** monthly, started by hand. Scheduled runs are designed in E11.6-16 and not built | — |
| Q6 | Credit the source on pages, and how | On, as plain text in `src/copy/prices.ts`, e.g. "Source: youfundceo.com, with spot checks against providers' own pages", switchable in `config/price-index.json` | E11.6-11 |
| Q7 | FX provider | The ECB euro foreign exchange reference rates. They are free and keyless, published each working day, and cover every seeded currency | E11.6-06 |
| D1 | How price pages render | **Server-rendered on request from build-bundled data**, through the existing origin render cache, with the landing page's cache contract: a ref-less, default-flag render is cacheable, and `?ref=` is `private, no-store`. A prerendered page cannot read `?ref=` on the server, and a client-side path is forbidden (hard rule 4). Prerendering would mean dropping referral capture on price pages | E11.6-11 |
| D2 | A service or market removed from config | Its URLs stay "temporarily unavailable" and `noindex` until the founder runs `price-index retire-url`, which records a 301 to the nearest hub in the ledger | E11.6-13 |
| D3 | The legal basis for republishing data extracted from one source (its terms of use; the EU sui generis database right over systematic extraction) | Proceed only if E11.6-01 finds no terms prohibiting automated access or reuse. Republish facts (prices) only, never the source's prose. Credit the source. Spot-check against official pages. Treat the direct-from-provider source as the long-term basis. The founder records the risk decision, as ADR-030 does for the legal review | E11.6-05 |
| D4 | The methodology text on `/price-index` | Drafted from the built system's actual behaviour, with every statement traceable to code or config, and approved by the founder in the E11.6-14 pull request | E11.6-14 |
| D5 | Where the site links to the price pages | A "Price index" link in the footer, so the pages are crawlable from every page | E11.6-13 |
