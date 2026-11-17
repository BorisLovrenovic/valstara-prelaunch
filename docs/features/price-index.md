# Feature: Price index and price pages

Founder-authorised 2026-11-17, and amended by the founder's answers the same day (the verbatim text is under "Founder amendments" at the end; it overrides the original brief wherever the two conflict). Built by Epic E11.6 (`docs/plan/development-plan.md`). **This spec is the in-repository record of the founder's brief.** The brief has no other source, so every E11.6 ticket reads this file.

## Summary

Valstara sells subscriptions (AI, streaming, music, productivity) and later other digital goods below list price. The buyers assume the category is full of scams, so **every price Valstara publishes has to be precise, accurate and verifiable.** A wrong price on our own page damages the brand directly.

The **price index** records the official list prices of the subscriptions we track in every market we serve. It is refreshed once a month, by hand. It feeds:

1. **Programmatic price pages** on the pre-launch site: one template for each service and country (e.g. "Spotify Premium price in Sweden"), plus hubs. They rank for long-tail searches before launch and bring in waitlist signups.
2. **The monthly change report** the founder sends to journalists, newsletters and communities ("Spotify raised prices in 4 of our 20 markets this month"). It needs a reliable change log.
3. **Later, outside this repository:** the overpay calculator and the storefront's "official price vs Valstara price" comparison. They read the same data files, so the data must be framework-agnostic.

**What sets these pages apart:** other price-by-country sites show only official prices. Ours will eventually show the official price next to the Valstara price in each market. Before launch there is usually no Valstara price, so every page has to work without one.

### Two separate things: a tool and some pages

| | The price-index tool | The price pages |
|---|---|---|
| Where | `packages/price-index/` | `src/pages/prices/`, `src/pages/price-index/` |
| Runs | **Only when the founder types the command**, on the founder's machine, once a month | Inside the site, like every other page |
| Lifetime | Starts, fetches, writes files, **exits**. No daemon, timer, watcher, cron or scheduled workflow | Always on |
| Network | The source site only, politely | None at runtime |
| Writes | Files under `data/`, `reports/` and the override file | Nothing |
| Reaches the browser | Never | Server-rendered HTML; the existing signup and theme islands only |

**The tool cannot affect the running site (founder requirement, 2026-11-17).** It is not started by `npm run dev`, `npm start`, Docker Compose or the production image. The site never reads the tool's working files. The pages read only the committed `data/price-index/` files, and only at build time. New prices go live only through the ordinary path: a pull request, CI, merge and deploy. A scraper crash, a block by the source, or bad data can therefore at worst leave the founder without a new data commit. Even then, the site keeps serving the last merged prices until they go stale.

**There is no automation (founder, 2026-11-17).** No cron, no scheduled GitHub Actions workflow and no automatic email notification. The monthly routine is in `docs/price-index-runbook.md` (E11.6-15).

## Feature flag

| Flag | Default | Off means |
|---|---|---|
| `prices.pages` | **on** | Every `/prices/**` and `/price-index/**` route answers `503` with `Retry-After` and `noindex`, and the sitemap is unchanged. **This is the lever for a wrong price that has gone live**: it pulls every price page at once without a deploy, and the 503 does not cost the URLs their index status |
| `prices.valstara_comparison` | **off** | No Valstara price renders anywhere, even where `config/valstara-prices.json` has an entry. A Valstara price shown before launch is a public price commitment, so it stays off until the founder turns it on |

The tool has no flag. It is never started by the site, so there is nothing to switch off.

## Markets, catalogue and data

### Markets (`config/markets.json`)

Each market has its ISO 3166-1 alpha-2 code, display name, URL slug, ISO 4217 currency and an `enabled` flag. **All 20 are enabled (founder, 2026-11-17):** United Kingdom (GBP), Germany, Spain, France, Italy (EUR), Poland (PLN), Romania (RON), Sweden (SEK), Norway (NOK), Denmark (DKK), Finland (EUR), Switzerland (CHF), Netherlands, Croatia, Ireland, Austria, Portugal (EUR), Canada (CAD), United States (USD) and Australia (AUD).

E11.6-01 also captures country pages for 18 further countries (Belgium, Bosnia and Herzegovina, Cyprus, Czech Republic, Estonia, Greece, Hungary, Iceland, Latvia, Liechtenstein, Lithuania, Luxembourg, Malta, New Zealand, North Macedonia, Serbia, Slovakia, Slovenia). **They are parser fixtures, not markets.** They cover more number and currency formats, and they make adding one of those markets later a config change. Enabling a market stays a founder decision.

### Catalogue (`config/catalogue.json`)

Each service has a `service_id` (slug), display name, category (`ai`, `streaming`, `music`, `productivity`, `learning`, `fitness`), official website URL, `status` (`selling_now` | `launch` | `planned`), `plans[]` and `source_aliases`. Each plan has a `plan_id`, display name, `billing_period` (`month` | `year`), and `is_student` and `is_family` flags. `source_aliases` lists the names the source uses for the service and for each plan. They are used for matching, and nothing else.

**Track exactly these products and plans, at the monthly price the source shows (founder, 2026-11-17):**

| Product | Plan |
|---|---|
| Adobe Creative Cloud | The source's individual plan. Flag it if ambiguous |
| Amazon Prime / Prime Video | Prime |
| Apple TV | Individual |
| Apple Music | Individual |
| Bolt.new | Pro |
| Canva | Pro |
| ChatGPT | Plus |
| Crunchyroll | Mega Fan |
| Duolingo | Super, Max |
| Figma | Professional |
| LinkedIn Premium | Career, Business |
| Lovable | The paid plan. Flag it if ambiguous |
| MyFitnessPal | Premium |
| n8n | Starter |
| Netflix | Basic, Standard, Premium (4K) |
| Notion | Plus |
| Perplexity | Pro |
| Spotify Premium | Individual |
| YouTube Premium | Individual |

**No student plans, and no plan not listed here.** Where the mapping of a product or plan to the source's names is uncertain, E11.6-01 lists it in its findings for the founder to confirm. Nothing is guessed.

**Adding or removing a service or plan is a data change, never a code change.** Every layer reads the catalogue: matching, merge, coverage, the change log, reports and pages. Every E11.6 ticket that consumes the catalogue tests both an addition and a removal against its own layer.

- **Added:** the new combinations appear as `missing` until data arrives. No page exists for them until a plan passes the publish gate.
- **Removed:** the service's records leave `latest.json`. Snapshots and `changes.json` keep their history unchanged, since history is never rewritten. A URL that was ever published stays served, as described under "Edge cases".

**The source lists 41 services, so several of our products are not on it.** Those combinations appear as `missing` (`not_on_source`) in the coverage report, for manual entry. **This is expected, not an error.** The same goes for a service the source does not list in a given country.

### Valstara prices (`config/valstara-prices.json`)

Entered by hand by the founder for each service, plan, market and term (e.g. 12 months), in the market's local currency. Usually empty before launch. **No Valstara price is ever invented, estimated or derived.** The comparison block renders only when an entry exists and `prices.valstara_comparison` is on. It compares in the local currency only. The comparison is like for like: it compares against the official price for the same billing period where one is tracked. Otherwise it compares against the monthly list price multiplied by the term, and the page says so in words.

### The price record

One record per market × service × plan × billing period:

| Field | Rule |
|---|---|
| `market`, `service_id`, `plan_id`, `billing_period` | Identity |
| `price_local` | **The local price exactly as the source shows it**, held as an exact decimal string at the currency's minor-unit exponent (`"149.00"`). Arithmetic is done in integer minor units. **A float never holds a price** |
| `price_source_text` | The price text exactly as displayed (`"149 kr"`), kept for audit |
| `currency` | As the source shows it. It must equal the market's currency, and a mismatch is flagged |
| `price_usd_source` | The source's approximate USD figure, an exact decimal string. **Used only internally to rank markets. It is never displayed, and no conversion is ever computed from it.** Empty for a manual override without one; such a record is left out of cross-market rankings |
| `source` | `scraper:youfundceo.com` · `manual` · later `direct:<provider>` |
| `source_url`, `observed_at` | Where and when we read it |
| `source_verified_at` | The source's own "last checked" date for that service |
| `status` | `ok` · `missing` · `not_offered` · `needs_review` · `manual_override` · `stale` · `conflict` |
| `missing_reason` | When `missing`: `source_no_price` (in the source's "No price shown" section) · `not_on_source` (the source does not list the service, or does not list it in that country) · `parse_failed` · `market_failed` |
| `notes` | Free text |

**There is no currency conversion anywhere, and no FX provider (founder, 2026-11-17).** Pages display the local currency only.

**`not_offered`** means the plan does not exist in that market (e.g. Netflix Basic in some countries). It is set **only once confirmed**: the founder records it as a manual entry, with the official page that shows it, through `price-index override not-offered`. Until then, the combination stays `missing`. A `not_offered` entry goes stale like any manual entry. If the scraper later finds a price for it, the record becomes `conflict`. A `not_offered` plan never counts towards publishing a page.

### Files

| Path | Committed | What |
|---|---|---|
| `config/markets.json`, `config/catalogue.json`, `config/valstara-prices.json`, `config/price-index.json` | yes | Configuration, plus the tool settings (delays, thresholds, staleness, sample size, retention) |
| `data/price-index/latest.json` | yes | **The merged current view the pages build from** |
| `data/price-index/snapshots/YYYY-MM-DD.json` | yes | One per build, immutable. A second build on the same date takes a numeric suffix and never overwrites |
| `data/price-index/changes.json` | yes | **Append-only** log of real price changes |
| `data/price-index/manual-overrides.json` | yes | Hand-entered prices and `not_offered` confirmations |
| `data/price-index/approvals.json` | yes | **Append-only** founder approvals of `needs_review` and `conflict` values, each with an actor |
| `data/price-index/monthly/YYYY-MM.json` | yes | The monthly report data that feeds `/price-index/{yyyy-mm}` |
| `data/price-index/published-urls.json` | yes | **Append-only** ledger of every price URL ever published |
| `data/raw/<run_id>/…` | **no** (gitignored) | Raw fetched pages, normalised observations, checkpoint. Rotated (keep the last N runs) |
| `reports/coverage-YYYY-MM-DD.{md,json}`, `reports/monthly/YYYY-MM.md`, `reports/runs/<run_id>.json` | yes | Gap reports, outreach summaries, one structured log per run |

**The JSON feed is a repository file, not a served endpoint.** A public API is permanently out of scope (`AGENTS.md`). The storefront imports the files.

## The source: youfundceo.com

The founder picked this source after comparing several. It was the only one that caught Spotify Sweden rising from 129 to 149 SEK (October 2026). It also correctly shows YouTube Premium Individual in Sweden at 169 SEK, where other sites and Google's AI answer still showed 149 SEK.

**The known structure (founder, 2026-11-17; E11.6-01 confirms it):**

| Page | Path | Use |
|---|---|---|
| Country index | `/countries` | Resolves the slug of each enabled market |
| Country page | `/countries/{country}` | **The top section** lists every service with its current price. **"No price shown for <country>"** at the bottom lists services without a price, which become `missing` (`source_no_price`). **"What you get in <country>"** is not read |
| Service page | `/services/{service}` | Resolves service slugs |
| **Country × service page** | `/services/{service}/{country}` (e.g. `/services/netflix/sweden`) | **The preferred source of a tracked price.** Fetch only the pairs we track |
| Price moves | Path confirmed by E11.6-01 | Dated price changes on the source. **Used only to cross-check the changes our runs detect, in the founder's report. It never overrides our data** |

Prices are shown in local currency with an approximate USD figure, plus a "last checked" date for each service, which is stored as `source_verified_at`. **E11.6-01 decides from the captured pages which page type carries each fact.** That covers plan-level prices, the "last checked" date, and the "No price shown" list. A run then fetches nothing it does not need: `/robots.txt`, the indexes, the enabled markets' country pages, and the country × service pages only for tracked services the source lists in that country. That is roughly 460 requests a month, or about two hours at the default delay. Speed does not matter.

**What the 2026-11-17 check of `robots.txt` found (one request, before the spike):** the `*` group allows `/` and disallows only `/api/` and `/go/`. A separate group disallows the whole site to named AI agents, including `ClaudeBot`, `anthropic-ai`, `Claude-Web`, `GPTBot`, `CCBot` and `Scrapy`. The responses carry `ETag` and `Last-Modified`, and the site is served by Vercel. So:

- **No AI agent session fetches the site.** The founder captures E11.6-01's fixtures following `docs/prerequisites/p9-source-capture.md`, and agents work on them offline.
- **The source answers scripted requests with a Vercel bot checkpoint** (`x-vercel-mitigated: challenge`, HTTP 429), found by the founder's capture on 2026-11-17. `robots.txt` and `sitemap.xml` load without it.
- **The tool therefore fetches through headless Chromium presenting as an ordinary browser, with fingerprint evasion as needed, and never solves a CAPTCHA** (founder decision, 2026-11-17, recorded on E11.6-04; it supersedes D6 for the fetcher). It obeys the `*` group of `robots.txt`.
- **Nothing under `/api/` or `/go/` is requested**, however stable a JSON endpoint there looks.

**Fetching rules.** One page at a time. A randomised delay between requests (default 8–20 s, configurable), or the source's `Crawl-delay` if longer. It never crawls the whole site. It backs off exponentially on 429, 403 and 5xx, honouring `Retry-After`, and stops the run cleanly after repeated failures. **There is no proxy or IP rotation and no CAPTCHA solving.** A page that still refuses after backoff stops the run, and that is a signal for the founder. Fingerprint evasion is permitted by founder decision (2026-11-17). It checkpoints after each market and resumes an interrupted run.

**Matching.** The source's service and plan names are matched to the catalogue through `source_aliases` only, after normalising case, whitespace, punctuation and diacritics. A source entry that matches nothing is listed in the run report as "untracked on source". A fuzzy matcher may *suggest* an alias, and **never accepts one**.

## Validation, merge and the publish gate

- **Precedence.** A manual override fills any gap. If the scraper agrees with the override, the record is `ok` and the coverage report marks the override as retirable. **If they disagree, the record is `conflict` and both values are shown. Neither silently replaces the other.**
- **Rules.**
  - The currency must equal the market's currency.
  - The price must be > 0.
  - The billing period must be known.
  - A change of more than ±40% (configurable) from the previous published value makes the record `needs_review`.
  - **A scraped record not refreshed within 45 days, or a manual entry not re-verified within 90 days, becomes `stale`** (founder, 2026-11-17; both configurable).
  - **A plan that disappears from the source where it existed before becomes `needs_review`, and is never deleted silently.**
  - A market whose page failed to fetch or parse keeps its previous values, which go stale on schedule.
- **Human decisions.** `needs_review` and `conflict` resolve only by a founder action recorded in `approvals.json` with an actor. An approval binds to the exact value approved, so a different value later needs a new approval.
- **The publish gate.** **Only `ok` records and approved `manual_override` records ever reach a page, a hub, a sitemap entry, an FAQ answer, a ranking or the monthly report's published figures.** `needs_review`, `conflict`, `stale`, `missing` and `not_offered` are left out of every published figure, and the coverage report lists them. There is one implementation of the gate, and every consumer calls it.

## Change log and monthly report

A **real change** is a published value replaced by a different published value for the same record and currency. It is not a first observation, a status change or a formatting difference. A `needs_review` change is logged only when approved, dated by its observation. `changes.json` is append-only, and CI fails a change that edits or removes an existing entry.

`price-index monthly-report --month YYYY-MM` writes `reports/monthly/YYYY-MM.md` for outreach and `data/price-index/monthly/YYYY-MM.json` for the page. It contains:

- every change that month, largest % first, in local currency;
- the most and least expensive market for each plan, ranked by `price_usd_source` but shown in local prices;
- each plan's spread across markets, as a ratio (e.g. "the most expensive market costs 2.4 times the cheapest"), computed from `price_usd_source`;
- counts such as "Spotify Premium — Individual rose in 4 of 20 markets";
- **a cross-check against the source's "Price moves" page that only the founder sees.** It lists the source's moves we did not detect and our changes the source does not list. It is never published, and it never changes a value.

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
- **The plan table, in local currency only**, in monospace, with "last verified".
- Price history from `changes.json`, hidden when there is none.
- The rank across markets ("Sweden is the 3rd most expensive of our 20 markets for Spotify Premium — Individual"). It is ranked internally by `price_usd_source` among markets with a publishable record and a USD figure, and M is that count. A mini-table lists the cheapest and most expensive markets with their local prices.
- Related services in the same category in that market.
- The Valstara comparison, or before launch the waitlist call to action through the existing signup island with server-side `?ref=` capture intact.
- An FAQ built only from data.
- A methodology link and a "Prices verified on …" line.
- A plain statement that Valstara is not affiliated with the services listed.

**No page credits the data source (founder, 2026-11-17).**

**Generation.** A service × market page exists only when at least one of its plans passes the publish gate. Hubs list only pages that exist. The sitemaps list only pages that exist and are indexable.

**Copy.** Every sentence is a template in `src/copy/prices.ts` or a content file, filled from data. Nothing is typed per page. The rules of `docs/brand/copy-rules.md` apply in full:

- sentence case;
- no exclamation marks and no hype — "below list price", never "insane deal";
- "digital goods", never "digital products";
- provider names used plainly ("Spotify Premium — Family");
- no countdowns or scarcity;
- **never a price we do not have, and never a converted price.**

**The methodology** describes the process in general terms (founder, 2026-11-17, D4): "We collect official list prices once a month from public price listings, and check them by hand against providers' own pricing pages where needed." **Every sentence on it must be literally true** of the built system (E11-04's claims rules), and it does not name the source.

## User flows

1. **Monthly run (founder, by hand).** The steps are in `docs/price-index-runbook.md`.
   1. `npm run price-index -- scrape` fetches enabled markets politely and saves the raw pages. It writes the observations and a **preview** coverage report. It does not touch `latest.json`, and it exits.
   2. The founder reads the coverage report.
   3. The founder resolves `needs_review` and `conflict` records with `review approve|reject`, and adds manual overrides with `override add` and `override not-offered`.
   4. `npm run price-index -- build-data` merges and validates everything, then writes `latest.json`, a snapshot, the changes, the final coverage report and the run log.
   5. `npm run price-index -- monthly-report --month YYYY-MM` writes the month's report.
   6. The founder commits the data on a data branch and opens a pull request. CI validates it, and the founder merges it. The normal GitHub Actions build and deploy then publishes the pages.
2. **Search visitor.** Lands on `/prices/spotify/sweden`, reads the plan table, history and rank, and joins the waitlist through the signup island. A visitor who arrived with `?ref=` is attributed exactly as on `/`.
3. **Journalist.** Opens the `/price-index/2026-12` link from the outreach email. It lists the month's changes and links to every page it mentions.

## Edge cases and error states

- **The source blocks us (403, 429, a challenge page).** The run backs off, stops cleanly, and reports. Nothing is retried around the block. Prices keep their last values and go `stale` on schedule.
- **The source changes its page structure.** That market's parse fails loudly (`parse_failed`). It never yields zero records silently. Its previous values are kept, and the run report names the market.
- **A crash mid-write.** Every write is atomic (temporary file, then rename), so the previous `latest.json` survives intact.
- **An interrupted run.** It resumes from the last market checkpoint.
- **A previously published page loses all publishable data.** The page keeps rendering with a "temporarily unavailable" note and no price, carries `noindex`, and leaves the sitemap until data returns. **It never becomes a 404**, so indexed URLs do not churn. The published-URL ledger is what lets the site know it was published.
- **A service or market removed from config.** Its URLs behave exactly like lost data until the founder retires a URL with a recorded 301 target in the ledger (D2).
- **A record has no `price_usd_source`.** It is shown in its own page's plan table, but it is left out of every ranking, and M counts only the ranked markets.
- **`prices.pages` is off.** Every price route answers 503, `noindex`, `Retry-After`.

## Acceptance criteria

- [ ] The tool runs only on an explicit command and exits when done. Nothing in `npm run dev`, `npm start`, Compose, the production image or a CI schedule starts or contains it, which is asserted.
- [ ] A failed, blocked or interrupted run leaves `data/price-index/latest.json` byte-identical.
- [ ] The tool requests only the source host, obeys the `*` group of `robots.txt`, loads one page at a time through a headless browser, solves no CAPTCHA, and backs off and stops on repeated trouble.
- [ ] Every currency in `config/markets.json`, and every currency with a captured fixture, has parser tests against founder-captured fixtures.
- [ ] Prices are exact decimals end to end, no float holds a price, and no conversion is computed or displayed anywhere.
- [ ] Override precedence, `not_offered`, conflict detection, staleness, disappearance and the ±40% threshold behave as specified. **Only `ok` and approved `manual_override` records reach any page.**
- [ ] `changes.json`, `approvals.json` and `published-urls.json` are append-only, and CI enforces it.
- [ ] Adding or removing a service, plan or market needs no code change, and every layer tests it.
- [ ] Pages exist only with publishable data. A previously published URL never 404s. Sitemaps list only indexable pages, with `lastmod` from the verification date.
- [ ] Price routes load no JavaScript beyond the signup and theme islands, and make no third-party request.
- [ ] Every number on a page traces to `latest.json` or `changes.json`, and no USD figure appears on any page, which a render test asserts.
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
    http/         the browser fetcher: robots, one page at a time, jitter, backoff, raw store
    sources/      the SourceAdapter interface; youfundceo/ (the first adapter); direct:<provider> later
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
docs/price-index-runbook.md   the founder's monthly routine
```

**The direction of dependencies is one way.** `src/` may import only `packages/price-index/src/publish` and `src/schema`, and a scan enforces it. The package imports nothing from `src/`. Storage and sources are interfaces. A database store or a `direct:<provider>` source (fetching official pricing pages through an in-country route) plugs in later without changing the pipeline. **Neither is built now.**

## Open questions for the founder

The brief's six questions were answered on 2026-11-17 (see "Founder amendments"). So were D1–D6, raised while planning; each answer is recorded on its ticket in the plan. **None remains open.**

| # | Question | Answer | Ticket |
|---|---|---|---|
| D1 | How price pages render | **Answered 2026-11-17:** server-rendered on request from build-bundled data, with the landing page's cache contract, so `?ref=` capture works | E11.6-10 |
| D2 | A service or market removed from config | **Answered 2026-11-17:** "temporarily unavailable" and `noindex` until `price-index retire-url` records a 301 to the nearest hub | E11.6-12 |
| D3 | The legal basis for republishing the source's data | **Answered 2026-11-17:** the founder accepts the risk. The source itself republishes the providers' own public prices. Not a gate | E11.6-05 |
| D4 | The methodology wording | **Answered 2026-11-17:** "We collect official list prices once a month from public price listings, and check them by hand against providers' own pricing pages where needed." | E11.6-13 |
| D5 | Where the site links to the price pages | **Answered 2026-11-17:** a "Price index" link in the footer, added with the hubs | E11.6-12 |
| D6 | The name the tool gives in its `User-Agent` | **Answered 2026-11-17:** a neutral bot name, exactly `PriceIndexBot/1.0`, with no URL. **Superseded for the fetcher the same day**, after the source's bot checkpoint refused scripted requests: the fetcher is a headless browser presenting as an ordinary browser (recorded on E11.6-04) | E11.6-04 and the P9 capture |

## Founder amendments, 17 November 2026 (verbatim)

> # Amendments to the price-index brief (founder answers, 17 Nov 2026)
>
> These override the original brief wherever they conflict.
>
> ## 1. Source (section 5)
> - `{{SOURCE_SITE}}` = **https://www.youfundceo.com/**
> - Known structure (confirm in Ticket 0):
>   - country pages: `/countries/{country-slug}` (e.g. `/countries/united-states`);
>   - service pages: `/services/{service-slug}` (e.g. `/services/netflix`);
>   - **country × service pages**: `/services/{service-slug}/{country-slug}` (e.g. `/services/netflix/pakistan`). Prefer these: fetch only the pairs we track.
>   - It also has a "Price moves" page with dated price changes. Use it to cross-check changes our runs detect (reporting only; it doesn't override our data).
> - Prices are shown in local currency with an approximate USD figure, plus a "last checked" date per service. Store that date as `source_verified_at`.
> - The site lists 41 services, so several of our products won't be on it. **They must appear as `missing` in the coverage report** for manual entry. This is expected, not an error.
>
> ## 2. Markets (section 4.1)
> Enable **all** of these: United Kingdom, Germany, Spain, France, Italy, Poland, Romania, Sweden, Norway, Denmark, Finland, Switzerland, Netherlands, Croatia, Ireland, Austria, Portugal, Canada, **United States, Australia**.
>
> ## 3. Catalogue (section 4.2): replaces the provisional seed list
> Track exactly these products and plans (monthly price as shown on the source):
> - Adobe Creative Cloud (map to the source's individual plan; flag if ambiguous)
> - Amazon Prime / Prime Video
> - Apple TV
> - Apple Music (Individual)
> - Bolt.new Pro
> - Canva Pro
> - ChatGPT Plus
> - Crunchyroll Mega Fan
> - Duolingo Super
> - Duolingo Max
> - Figma Professional
> - LinkedIn Premium Career
> - LinkedIn Premium Business
> - Lovable (paid plan; flag if ambiguous)
> - MyFitnessPal (Premium)
> - n8n Starter
> - Netflix Basic, Netflix Standard, Netflix Premium (4K)
> - Notion Plus
> - Perplexity Pro
> - Spotify Premium Individual
> - YouTube Premium (Individual)
>
> Rules:
> - **Drop** the instruction to track student plans and any plans not listed above.
> - If a plan doesn't exist in a market (for example Netflix Basic in some countries), record it as `not_offered`, not `missing`, once confirmed. Add `not_offered` as a status.
> - When mapping names to the source is uncertain, put it in the Ticket 0 findings for the founder to confirm.
>
> ## 4. Currency (sections 4.4 and 8.2)
> - **No currency conversion and no FX provider.** Remove the `fx` field and the ECB/FX logic.
> - Store `price_local` and `currency` exactly as the source shows them.
> - Store the source's approximate USD figure as `price_usd_source`. Use it **only** internally to rank markets (e.g. "Nth most expensive of M markets").
> - **Pages display the local currency only.** Remove the "≈ USD / ≈ EUR" display and the FX date from the page spec.
> - Manual overrides need a local price and currency. `price_usd_source` may be left empty; such records are left out of cross-market rankings until they have one.
>
> ## 5. Source credit (sections 8.2 and 12)
> - **Don't credit the data source** on any page. Remove the configurable credit option.
> - The methodology page describes the process in general terms: prices are taken from official pricing pages, checked monthly and verified by hand where needed.
>
> ## 6. Run cadence and automation (section 9): replaces the automation section
> - **Monthly, run by hand.** The founder runs `price-index scrape` once a month from the CLI. **No cron, no scheduled GitHub Actions workflow, no automatic email notifications.**
> - After a run:
>   1. the founder reads the coverage report;
>   2. resolves `needs_review` / `conflict` records and adds manual overrides;
>   3. runs `price-index build-data`;
>   4. commits the updated data;
>   5. the normal GitHub Actions build and deploy publishes the pages.
> - Document this monthly routine as a short runbook in the repo, e.g. `docs/price-index-runbook.md`.
>
> ## 7. Staleness defaults (section 6.3)
> Given monthly runs:
> - scraped records go `stale` after **45 days**;
> - manual overrides go `stale` after **90 days**.
>
> ## 8. Open questions (section 12): all resolved
> - Source: youfundceo.com
> - Catalogue: section 3 above
> - US and Australia: included
> - Cadence: monthly, by hand
> - Source credit: none
> - FX: none needed
