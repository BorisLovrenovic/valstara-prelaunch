# Feature: Price index and price pages

Founder-authorised 2026-11-17, and amended by the founder's answers the same day (the verbatim text is under "Founder amendments" at the end; it overrides the original brief wherever the two conflict). Built by Epic E11.6 (`docs/plan/development-plan.md`). The founder's wider growth decisions are in `docs/prerequisites/valstara-prelaunch-growth-decisions.md`. **This spec is the in-repository record of the founder's brief.** The brief has no other source, so every E11.6 ticket reads this file.

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

**How this is proven (E11.6-07).** `scrape` never writes `latest.json`: it writes its observations and a preview merge to the gitignored raw store. Only `build-data` writes `data/price-index/`, and only after every input and its result validate. Tests run every failure mode (a run stopped by the source, a run killed mid-market, an interrupted run, a dry run, a build that fails validation) and require every file under `data/price-index/` and `config/` to stay byte-identical. Each command runs as a child process and must exit on its own. The built site is scanned for code from the tool's `src/http`, `src/sources`, `src/cli` and `src/reports`, and a copy of the repository without the tool must build and serve (`test/price-index/isolation-proof.test.ts`).

**There is no automation (founder, 2026-11-17).** No cron, no scheduled GitHub Actions workflow and no automatic email notification. The monthly routine is in `docs/price-index-runbook.md` (E11.6-15).

## Feature flag

| Flag | Default | Off means |
|---|---|---|
| `prices.pages` | **on** | Every `/prices/**` and `/price-index/**` route answers `503` with `Retry-After` and `noindex`, and the sitemap is unchanged. **This is the lever for a wrong price that has gone live**: it pulls every price page at once without a deploy, and the 503 does not cost the URLs their index status |
| `prices.valstara_comparison` | **off** | No Valstara price renders anywhere, even where `config/valstara-prices.json` has an entry. A Valstara price shown before launch is a public price commitment, so it stays off until the founder turns it on |

The tool has no flag. It is never started by the site, so there is nothing to switch off.

## Markets, catalogue and data

### Markets (`config/markets.json`)

Each market has its ISO 3166-1 alpha-2 code, display name, URL slug, ISO 4217 currency and an `enabled` flag, and optionally its name as it reads in a sentence ("the United States", E11.6-10). **All 20 are enabled (founder, 2026-11-17):** United Kingdom (GBP), Germany, Spain, France, Italy (EUR), Poland (PLN), Romania (RON), Sweden (SEK), Norway (NOK), Denmark (DKK), Finland (EUR), Switzerland (CHF), Netherlands, Croatia, Ireland, Austria, Portugal (EUR), Canada (CAD), United States (USD) and Australia (AUD).

E11.6-01 also captures country pages for 18 further countries (Belgium, Bosnia and Herzegovina, Cyprus, Czech Republic, Estonia, Greece, Hungary, Iceland, Latvia, Liechtenstein, Lithuania, Luxembourg, Malta, New Zealand, North Macedonia, Serbia, Slovakia, Slovenia). **They are parser fixtures, not markets.** They cover more number and currency formats, and they make adding one of those markets later a config change. Enabling a market stays a founder decision.

### Catalogue (`config/catalogue.json`)

Each service has a `service_id` (slug), display name, category (`ai`, `streaming`, `music`, `productivity`, `learning`, `fitness`), official website URL, optional `official_hosts` (further hosts on which a manual entry's source page may be, as bare lower-case hostnames; D-031), `status` (`selling_now` | `launch` | `planned`), `plans[]` and `source_aliases`. Each plan has a `plan_id`, display name, `billing_period` (`month` | `year`), and `is_student` and `is_family` flags. `source_aliases` lists the names the source uses for the service and for each plan. They are used for matching, and nothing else. The file shapes, the alias layout and every rule `price-index validate` enforces are in `docs/modules/price-index.md` (E11.6-02).

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
| Lovable | Pro (the founder, 2026-11-18) |
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
| `price_usd_source` | The source's approximate USD figure, an exact decimal string with two decimals (`"16.78"`). **Used only internally to rank markets. It is never displayed, and no conversion is ever computed from it.** Empty for a manual override without one; such a record is left out of cross-market rankings |
| `source` | `scraper:youfundceo.com` · `manual` · later `direct:<provider>` |
| `source_url`, `observed_at` | Where and when we read it |
| `source_verified_at` | The source's own "last checked" date for that service |
| `status` | `ok` · `missing` · `not_offered` · `needs_review` · `manual_override` · `stale` · `conflict` |
| `missing_reason` | When `missing`: `source_no_price` (in the source's "No price shown" section) · `not_on_source` (the source does not list the service, or does not list it in that country) · `parse_failed` · `market_failed` |
| `notes` | Free text |

Every record carries all of these keys, with `null` where a value is absent, and nothing else: the schema rejects an `fx` field or any converted price. `price_local` is written at the currency's ISO 4217 minor-unit exponent (`"149.00"` SEK, `"1190"` ISK). The full schema rules, and the money module that reads displayed prices into exact decimals, are in `docs/modules/price-index.md` (E11.6-03).

**There is no currency conversion anywhere, and no FX provider (founder, 2026-11-17).** Pages display the local currency only.

**`not_offered`** means the plan does not exist in that market (e.g. Netflix Basic in some countries). It is set **only once confirmed**: the founder records it as a manual entry, with the official page that shows it, through `price-index override not-offered`. Until then, the combination stays `missing`. A `not_offered` entry goes stale like any manual entry. If the scraper later finds a price for it, the record becomes `conflict`. A `not_offered` plan never counts towards publishing a page.

### Files

| Path | Committed | What |
|---|---|---|
| `config/markets.json`, `config/catalogue.json`, `config/valstara-prices.json`, `config/price-index.json` | yes | Configuration, plus the tool settings (delays, thresholds, staleness, sample size, retention) |
| `data/price-index/latest.json` | yes | **The merged current view the pages build from** |
| `data/price-index/snapshots/YYYY-MM-DD.json` | yes | One per build, immutable. A second build on the same date takes a numeric suffix (`YYYY-MM-DD-2.json`, then `-3`, …) and never overwrites |
| `data/price-index/changes.json` | yes | **Append-only** log of real price changes |
| `data/price-index/manual-overrides.json` | yes | Hand-entered prices and `not_offered` confirmations |
| `data/price-index/approvals.json` | yes | **Append-only** founder approvals of `needs_review` and `conflict` values, each with an actor |
| `data/price-index/monthly/YYYY-MM.json` | yes | The monthly report data that feeds `/price-index/{yyyy-mm}` |
| `data/price-index/published-urls.json` | yes | **Append-only** ledger of every price URL ever published |
| `data/raw/<run_id>/…` | **no** (gitignored) | Raw fetched pages, the fetcher's report and checkpoint, the run's normalised observations (`observations.json`) and its preview merge (`preview.json`). Rotated (keep the last N runs) |
| `reports/coverage-YYYY-MM-DD.{md,json}`, `reports/monthly/YYYY-MM.md`, `reports/runs/<run_id>.json` | yes | Gap reports, outreach summaries, one structured log per run |

**The JSON feed is a repository file, not a served endpoint.** A public API is permanently out of scope (`AGENTS.md`). The storefront imports the files.

## The source: youfundceo.com

The founder picked this source after comparing several. It was the only one that caught Spotify Sweden rising from 129 to 149 SEK (October 2026). It also correctly shows YouTube Premium Individual in Sweden at 169 SEK, where other sites and Google's AI answer still showed 149 SEK.

**The known structure (founder, 2026-11-17; confirmed by E11.6-01, whose findings are in `docs/features/price-index-source-findings.md`):**

| Page | Path | Use |
|---|---|---|
| Country index | `/countries` | Resolves the slug of each enabled market |
| Country page | `/countries/{country}` | **The top section** lists every service with its current price. **"No price shown for <country>"** at the bottom lists services without a price, which become `missing` (`source_no_price`). **"What you get in <country>"** is not read |
| Service page | `/services/{service}` | Resolves service slugs |
| **Country × service page** | `/services/{service}/{country}` (e.g. `/services/netflix/sweden`) | **The preferred source of a tracked price.** Fetch only the pairs we track |
| Price moves | `/price-moves` (confirmed by E11.6-01) | Dated price changes on the source. **Used only to cross-check the changes our runs detect, in the founder's report. It never overrides our data** |

Prices are shown in local currency with an approximate USD figure, plus a "last checked" date for each service, which is stored as `source_verified_at`. **E11.6-01 decides from the captured pages which page type carries each fact.** That covers plan-level prices, the "last checked" date, and the "No price shown" list. A run then fetches nothing it does not need: `/robots.txt`, the indexes, the enabled markets' country pages, and the country × service pages only for tracked services the source lists in that country. That is roughly 460 requests a month, or about two hours at the default delay. Speed does not matter.

**What the 2026-11-17 check of `robots.txt` found (one request, before the spike):** the `*` group allows `/` and disallows only `/api/` and `/go/`. A separate group disallows the whole site to named AI agents, including `ClaudeBot`, `anthropic-ai`, `Claude-Web`, `GPTBot`, `CCBot` and `Scrapy`. The responses carry `ETag` and `Last-Modified`, and the site is served by Vercel. So:

- **No AI agent session fetches the site.** The founder captures E11.6-01's fixtures following `docs/prerequisites/p9-source-capture.md`, and agents work on them offline.
- **The source answers scripted requests with a Vercel bot checkpoint** (`x-vercel-mitigated: challenge`, HTTP 429), found by the founder's capture on 2026-11-17. `robots.txt` and `sitemap.xml` load without it.
- **The tool therefore fetches through headless Chromium presenting as an ordinary browser, with fingerprint evasion as needed, and never solves a CAPTCHA** (founder decision, 2026-11-17, recorded on E11.6-04; it supersedes D6 for the fetcher). It obeys the `*` group of `robots.txt`.
- **Nothing under `/api/` or `/go/` is requested**, however stable a JSON endpoint there looks.

**Fetching rules.** One page at a time. A randomised delay between requests (default 8–20 s, configurable), or the source's `Crawl-delay` if longer. It never crawls the whole site. It backs off exponentially on 429, 403 and 5xx, honouring `Retry-After` — a `Retry-After` longer than the configured ceiling (default one hour) stops the run instead of waiting — and stops the run cleanly after repeated failures. **There is no proxy or IP rotation and no CAPTCHA solving.** A page that still refuses after backoff stops the run, and that is a signal for the founder. Fingerprint evasion is permitted by founder decision (2026-11-17). It checkpoints after each market and resumes an interrupted run.

**One page at a time holds for every request the browser makes (E11.6-04, founder decision 1 of 2026-11-18).** A page load of the source sets off its own requests, among them Next.js prefetches of other source pages, so the browser context refuses by default, before a request leaves the browser. It allows only the main-frame navigation to the requested page (and its reload or same-host redirect while the checkpoint completes), same-host scripts and stylesheets, and same-host fetch and XHR requests without `_rsc`, `rsc` or `next-router-prefetch`. Prefetches, images, fonts, media, every other resource type, every other host, and every path the `*` group disallows are refused. **The fetcher makes no conditional request** (founder decision 2 of 2026-11-18): it sends no `If-None-Match` or `If-Modified-Since` and keeps no `ETag` or `Last-Modified` state. The rules in full are under "The browser fetcher" in `docs/modules/price-index.md`.

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

**How the rules apply (E11.6-06, founder decisions D-028 of 2026-11-18).** The merge (`packages/price-index/src/pipeline/`) is a pure function of the previous `latest.json`, the run's observations and gaps, `manual-overrides.json`, `approvals.json`, the catalogue, the markets, the settings and an injected clock. The full rule set, case by case, is in `docs/modules/price-index.md` under "The merge".

- **One record per enabled market × catalogue plan.** A disabled market's records leave `latest.json`, the same as a removed market's or service's. Snapshots are never touched.
- **A decision is a yes or no on the one value a record shows.** It binds to the market, service, plan, billing period, `price_local`, currency and source, and the last decision for that exact value counts.
  - **Conflict:** the record shows the scraper's value, with the manual entry in `notes`. `approve` publishes the scraper's value as `ok`. `reject` lets the manual entry stand: an override publishes as `manual_override` (passing the ±40% check like any override, so after a conflict carried from an earlier build it waits for its own approval), and a `not_offered` entry stays `not_offered`.
  - **A ±40% `needs_review`:** the record shows the new value. `approve` publishes it; `reject` keeps it unpublished, and the old value is not put back.
  - **A disappearance:** the record shows no price, with the last value in `notes`. It ends with a manual entry, or with the plan coming back, and `approve` turns it into `missing`. A value that comes back is a new scraped value after a `needs_review` record, so it waits for an approval.
- **The ±40% rule compares only with a previously published value, and it covers the founder's overrides.** A new value is compared with the previous record's only when that record was `ok`, `manual_override` or `stale`. After a `needs_review` or `conflict` record, every new scraped value stays `needs_review` until approved, so a flagged rise can never publish itself a month later. An override within 40% of the last published value, or with nothing to compare with, publishes as `manual_override` with no `approvals.json` entry: its `verified_by` is the founder's approval, and this is what "approved `manual_override`" means. An override more than 40% away is `needs_review` and needs `review approve`. Exactly 40% passes; a value in another currency than the last published one cannot be measured and needs an approval. **After a `needs_review` or `conflict` record that shows a value, a new override, and a scraped value that agrees with one, also wait for an approval** (E11.6-06): the last published value is no longer in the record, so nothing can be compared, and a flagged override never publishes itself on a later build. After a disappearance, which shows no value, a manual entry fills the gap with nothing to compare with.
- **A value that breaks the currency or price > 0 check is `needs_review`**, with the broken rule in `notes`. No approval can publish it, and a manual override fills the gap as usual. An observation or override for a tracked plan in another billing period than the catalogue's, or an override in another currency than its market's, stops the merge: nothing is built until the input is fixed.
- **Only `ok`, `manual_override` and `not_offered` go `stale`:** scraped values 45 days after `observed_at`, manual entries 90 days after `verified_at`. A stale record keeps its value, which stays the ±40% baseline. `needs_review`, `conflict` and `missing` keep their status, so an open flag stays visible.
- **A failed page keeps the previous scraped value with its old `observed_at`, and any open flag**, so a conflict stays a conflict and an override never wins because a market failed. A retired override's value is not kept.
- **`price-index review approve|reject --market --service --plan --actor`** records the decision. It reads the flagged record from the preview merge of the latest run (E11.6-07; D-028 Q4), so the monthly routine above (review before `build-data`) works as written. With no run in the raw store at all, it reads `latest.json`, as E11.6-06 built it. `approvals.json` is the same either way.
- **The settings** are in `config/price-index.json` under `merge`: `change_threshold_percent` (40) and `stale_after_days` `{ scraped, manual }` (45, 90).

## The coverage report and manual entries

Built by E11.6-08; the full rules are in `docs/modules/price-index.md` under "The coverage report" and "Manual entries".

`reports/coverage-YYYY-MM-DD.md` and `.json` are the founder's working list for a run. `scrape` writes them as a **preview**, `build-data` as the **final** report of its build (replacing that day's preview), and `price-index report` on demand, as the preview of the newest run against the data as it now stands. The Markdown is rendered from the JSON's own object, so the two always carry the same figures. They hold:

- the full matrix of enabled markets × catalogue plans, each cell's status and, for `missing`, its reason;
- coverage overall, per market and per service: publishable records as a share of all records, floored to one decimal;
- the `missing` combinations grouped by service, `not_on_source` first, each with the market's currency and the service's official site, ready for manual entry;
- every `needs_review`, `conflict` and `stale` record, with the value it shows and, for a conflict, the founder's manual entry beside it;
- the overrides the scraper now agrees with, which may be retired;
- the publishable records without a USD figure, which are published but never ranked;
- the "untracked on source" list with its suggestions, none applied;
- **a spot-check list of N `ok` records** (`reports.spot_checks` in `config/price-index.json`, 5 by default), drawn by a source seeded from the run id, so the same run always lists the same records, each with the service's official URL.

The report carries no USD figure. It is a committed file for the founder, never read by a page.

**Manual entries.** `price-index override add` asks, one line at a time, for the market, service, plan, billing period, local price, currency, an optional USD figure, `source_url`, `verified_at`, `verified_by` and a note. `override not-offered` asks the same without the price, currency and USD figure, and records a confirmed `not_offered`. `override retire` removes the entry for one market, service, plan and billing period. Every answer is checked as it is given and the first refused one writes nothing. **They refuse a currency other than the market's, a `source_url` whose host is not exactly the host of the service's catalogue `website_url` or one of its `official_hosts`, a price that does not parse exactly, and an empty `verified_by`.** Another subdomain or a look-alike is refused, and adding an official host is a reviewed edit to `config/catalogue.json` (D-031 Q1). `override add` also refuses a price whose only separator is a `.` or `,` followed by exactly three digits (`149.999`, `1,299`), which could be a thousands separator or a mistyped decimal, and asks for the price without a thousands separator (`1299` or `1 299`); a hand-entered price with nothing to compare it with publishes without approval, so a typo must not parse (D-031 Q2). `manual-overrides.json` is validated whole and written atomically.

## Change log and monthly report

A **real change** is a published value replaced by a different published value for the same record and currency. It is not a first observation, a status change or a formatting difference. A `needs_review` change is logged only when approved, dated by its observation. `changes.json` is append-only, and CI fails a change that edits or removes an existing entry.

`price-index monthly-report --month YYYY-MM` writes `reports/monthly/YYYY-MM.md` for outreach and `data/price-index/monthly/YYYY-MM.json` for the page. It contains:

- every change that month, largest % first, in local currency;
- the most and least expensive market for each plan, ranked by `price_usd_source` but shown in local prices;
- each plan's spread across markets, as a ratio (e.g. "the most expensive market costs 2.4 times the cheapest"), computed from `price_usd_source`;
- counts such as "Spotify Premium — Individual rose in 4 of 20 markets";
- **a cross-check against the source's "Price moves" page that only the founder sees.** It lists the source's moves we did not detect and our changes the source does not list. It is never published, and it never changes a value.

**How it is built (E11.6-09).** The full rules are in `docs/modules/price-index.md` under "The change log" and "The monthly report".

- **Detection.** `build-data` compares each value the new `latest.json` publishes (the publish gate's `isPublishable()`) with the value its record last published: the record in the previous `latest.json` when the gate passes it, otherwise the newest snapshot in which it does. So a value that waited as `needs_review`, `stale` or `missing` is compared with the last value the pages showed, and a first observation has nothing to compare with. Values are compared in exact minor units and the same currency, so a formatting difference or a status change logs nothing, and a change of currency is not a price change. An approved `needs_review` value is logged by the build that publishes it, dated by its observation (`observed_at`; a manual entry's verification date). An entry already in the log is not repeated, so a rebuild logs a change once. The changes are appended before `latest.json` is written.
- **An entry** holds market, service, plan, billing period, old and new local price, currency, `change_percent` (signed text with one decimal, e.g. `"15.5"`, `"-7.8"`, computed exactly), `detected_on` and source. No USD figure.
- **The month's figures** come from the month's last snapshot and `changes.json`, through the publish gate. A change counts only while its record still passes the gate in that snapshot; the extremes rank with `rankMarkets()` (rank 1, and the last rank, first by market code on a tie) and show local prices; the spread is the most expensive market's USD figure over the cheapest's, one decimal, and needs two ranked markets; the counts are of markets where the plan is published, and a market whose month of changes ends above (below) where it began rose (fell). "Largest % first" is by size, rises and falls together.
- **The cross-check** reads the price moves of the runs built that month from the gitignored raw store. A move and a change agree when market, plan, billing period, currency and both prices match; dates may differ. When the raw store no longer holds them, the Markdown says so. It is written to the Markdown only.
- **A month with no build** has no report: the command refuses. A month with no changes gets a report that says so.

## Pages

| Route | What |
|---|---|
| `/prices` | Top-level index of the service and market hubs (E11.6-12) |
| `/prices/{service}` | Service hub: every enabled market with a publishable price, ranked, linking to each page (E11.6-12) |
| `/prices/{service}/{country}` | **The main programmatic page** |
| `/prices/countries/{country}` | Market hub: every tracked service in that market (E11.6-12) |
| `/price-index` | Landing page and methodology (E11.6-13) |
| `/price-index/{yyyy-mm}` | The monthly report (E11.6-13) |

**These URLs are permanent. They will be ported to the storefront at launch.** The slugs come from the catalogue and markets config, and a slug never changes once published (the ledger enforces it).

**The service × market page** carries data specific to that page, so it is never thin content:

- The H1 and title, e.g. "Spotify Premium price in Sweden (November 2026)", dated from the last verification.
- **The plan table, in local currency only**, in monospace, with "last verified".
- Price history from `changes.json`, hidden when there is none.
- The rank across markets ("Sweden is the 3rd most expensive of our 20 markets for Spotify Premium — Individual"). It is ranked internally by `price_usd_source` among markets with a publishable record and a USD figure, and M is that count. A mini-table lists the cheapest and most expensive markets with their local prices.
- Related services in the same category in that market.
- The waitlist call to action through the existing signup island with server-side `?ref=` capture intact, on every page, and the Valstara comparison beside it where one exists.
- An FAQ built only from data.
- A methodology link and a "Prices verified on …" line.
- A plain statement that Valstara is not affiliated with the services listed.

**No page credits the data source (founder, 2026-11-17).**

**Generation.** A service × market page exists only when at least one of its plans passes the publish gate. Hubs list only pages that exist. The sitemaps list only pages that exist and are indexable.

**How the service × market page is built (E11.6-10).**

- **Rendering.** `src/pages/prices/[service]/[country].astro` is server-rendered on request (D1) from the `latest.json`, catalogue, markets and ledger bundled into the server at build (`src/server/prices/bundled.ts`), with `changes.json` and `config/valstara-prices.json` since E11.6-11; the running site never reads the repository's files. The view model is one pure function of those files, `createPriceSite` in `src/server/prices/site.ts`: the page, the sitemap, the SEO build check and the tests all read it, and the page only renders it. Every input is validated against its schema first (the Valstara prices with `price-index validate`'s cross-file rules too), so an invalid file fails the build (the prebuild sitemap step reads it) and publishes nothing.
- **Generation and the ledger.** The pages are exactly `generatedPages` (`packages/price-index/src/publish/`). `build-data` appends each newly generated page's URL to `data/price-index/published-urls.json`, append-only and CI-checked. A ledger URL that generates no page renders the **unavailable** state: the H1, a "temporarily unavailable" note, no price, the independence statement and the waitlist form, with `noindex` (meta and `X-Robots-Tag`), HTTP 200, and no sitemap entry. Its names come from the configuration, or from the ledger once its service or market has left it (D2). **Any other pair answers the branded 404.**
- **The page.** The H1 and title ("Spotify Premium price in Sweden (November 2026)") are dated from the newest verification. The plan table lists each published plan in the catalogue's order, with its price as the published record holds it, the exact decimal and its ISO 4217 code ("149.00 SEK"), the billing period, and its last verification date, all set in the monospace token. A record's verification date is its `source_verified_at` (the source's "last checked" date, or the founder's date for a manual entry), else the day it was observed; one with neither fails the build. The "Prices verified on …" line names the single date, or "between … and …" when the plans differ. Then the independence statement and the waitlist call to action through `SignupForm`, with the landing's server-signed referral field (E4-02). **No USD figure, converted price or source credit** can render: the view is built from `publishedView`, which carries no `price_usd_source`, and a record whose currency is not its market's fails the build. A market whose name needs an article in a sentence carries `name_in_sentence` in `config/markets.json` ("the United States").
- **The flag.** `prices.pages` (default on) is read before any lookup: off, every price route answers 503 with `Retry-After: 3600`, `noindex` (meta and `X-Robots-Tag`), `private, no-store` and a plain paused card, and the sitemaps are unchanged.
- **Caching.** The landing's contract: a ref-less render in the default flag state is `public, max-age=0, s-maxage=300`, varying on `X-Valstara-Flag-Generation`; `?ref=` and any non-default flag state are `private, no-store`. Every 200 render goes through the origin render cache, keyed by path and flag generation, in its own bound of 64 entries so a crawl of the price pages never evicts the landing's entries; a 404 or 503 is never stored.
- **Sitemaps and metadata.** `/sitemap.xml` is an index over `/sitemaps/pages.xml` (the site's own routes, exactly as before) and `/sitemaps/prices-service-market.xml` (the generated pages, each with its verification date as `lastmod`; written by every build and not committed). Each page has a unique title and description, a self-canonical, BreadcrumbList JSON-LD (Valstara → the page) mirrored by a visible breadcrumb, and its own social card (E11.6-14): the page's title and its first plan row word for word (plan name, price and period, set in the monospace token), with the typed `prices` card as the Open Graph fallback. A ledger URL that publishes no page has no card of its own and serves the typed `prices` card at its card URL. The E9-06 and E9-07 checks cover their metadata (`docs/features/seo.md#social-card-contract-e9-07`).
- **JavaScript and requests.** The page ships the theme toggle and the signup form only, plus the page-view emitter every page carries and the Turnstile loader the form needs. The E11-05 privacy crawl runs every price page kind on a site built over the fixture dataset in `test/fixtures/price-index/pages/`, because the repository's data has no page before the first run.

**The page's content blocks (E11.6-11).** Each block is built in the view model from published data only, renders only when the data holds it, and sits between the plan table and the independence statement. No block can show a USD figure: they read `publishedView` and `rankMarkets`, which carry no `price_usd_source`.

- **Price history.** The `changes.json` entries of the plans the page's table shows, in the record's currency, newest first: "Raised from 129.00 SEK to 149.00 SEK in October 2026." Every entry is a real change between two published values (E11.6-09). A plan the gate leaves off the page today (`needs_review`, `stale`, …) shows no history, so the page never shows a value of a record it does not publish. Hidden when there is none.
- **The cross-market comparison.** For each plan in the table, `rankMarkets()` gives this market's rank N and M, the number of markets it ranks (publishable records with a USD figure): "Sweden is the 3rd most expensive of our 20 markets for Spotify Premium — Individual." Rank 1 reads "the most expensive", and a shared rank reads "the joint …". A market name that begins the sentence is capitalised ("The United States is …", D-032 Q1). A mini-table names the most expensive market (rank 1) and the cheapest (the first market by code of the last rank, the monthly report's rule), each with its own local price, so a US price shows in USD as the United States' list price, never as a figure for another market. The block is hidden for a plan this market is unranked for, for a plan ranked in fewer than two markets (there is nothing to compare with), and for a ranking that holds a market the configuration does not enable (M would count a market we do not serve). The mini-table is left out when every ranked market shares one rank.
- **Related services.** Links to the generated pages of the other services in the same category and the same market, in catalogue order. An unavailable ledger URL or a pair that generates no page is never linked.
- **The FAQ.** Questions are asked only where the data answers them: the price of each shown plan (always, on a generated page, with the "Prices verified" line), the comparison (only when that block renders, answered with its rank sentences) and the history (only when it renders, answered with each plan's newest change). The `FAQPage` JSON-LD is built from the same entries, so it is present exactly when the visible FAQ is, and says exactly what the page says. An unavailable page has neither.
- **The Valstara comparison.** Rendered only while `prices.valstara_comparison` is on (default off) and `config/valstara-prices.json` holds an entry for one of the page's published plans. A 1-month entry for a monthly plan, or a 12-month entry for a yearly plan, compares with that published price. Any other term of a monthly plan compares with the monthly list price multiplied by the term, and the page states that basis in words ("For 12 months of Spotify Premium — Individual, the list price shown is the monthly list price, 149.00 SEK, multiplied by 12."). Any other term of a yearly plan has no basis and is not shown. The table shows the plan, the term, the list price, the Valstara price (at the currency's exponent) and how far below list it is, computed exactly in minor units and floored to one decimal so it never overstates ("16.6% below list price"). A Valstara price that is not at least 0.1% below the list price is not shown, so the figure never reads "0.0%" (D-033 Q2), nor is an entry for a plan the page does not publish. An entry not written at its currency's exponent ("149.001" or "149" for SEK) is refused by `price-index validate`'s cross-file rules, so validate, CI and the build all reject it, whether or not its plan publishes a page today (D-034 Q2). **The waitlist call to action stays on every page either way**: the comparison is shown beside it, never instead of it, so the signup form and its signed referral field (E4-02, E11.6-10) are on every price page. A non-default flag state is `private, no-store`, as for every flag.

**The hubs and `/prices` (E11.6-12).**

- **What exists.** The hubs are built in the same view model (`createPriceSite`) from the **live pages**: every generated page (`generatedPages` in `packages/price-index/src/publish/`), served whether or not the ledger holds a retirement for its URL, since a retirement applies only while its pair generates no page (D-037 Q2). A service has a hub at `/prices/{service}`, and a market at `/prices/countries/{country}`, exactly when it has at least one live page (`hubPaths`); any other hub path answers the branded 404, so a service or market with no page has no hub and no sitemap entry. `countries` is a reserved `service_id`, so the two hub routes never collide. Adding a service or a market with publishable data adds its hubs and its rows on the other hubs with no code change.
- **The service hub.** One section per catalogue plan that a live page publishes, in catalogue order: a table of every market whose live page shows that plan, with the market's name linking to the page, the price exactly as the published record holds it in the market's own currency ("149.00 SEK"), and its verification date, all figures in the monospace token. Markets that `rankMarkets()` ranks come first, in its order (most expensive first, ties by market code), so the hub agrees with every page's rank sentence; markets it leaves out (no USD figure) follow, alphabetically by name. A line under the table says how it is ordered, without naming the ranking's basis; a plan in one market has none. The H1 and title are dated from the newest verification the hub shows ("Spotify Premium prices by country (November 2026)").
- **The market hub.** One section per catalogue category with a live page in the market, in the order the catalogue first lists each category, and within it every published plan of each service in catalogue order ("Spotify Premium — Individual"), linking to the page, with its price and verification date. Titled "Subscription prices in Sweden (November 2026)", with the market's in-sentence name.
- **`/prices`.** The service hubs grouped by category, and the market hubs alphabetically by name, with the "Prices verified between … and …" line over every live page. With no live page (before the first build of data) it renders an honest empty note, with `noindex` (meta and `X-Robots-Tag`) and no sitemap entry, so the footer's "Price index" link (D5, in the Company column, label in `src/copy/layout.ts`) always reaches a page that is there.
- **Every hub** has a visible breadcrumb (Valstara → Prices → the hub) mirrored by BreadcrumbList JSON-LD, a unique title, description and self-canonical, its own title-only social card with the typed `prices` card as fallback (E11.6-14), a "Prices verified …" line and the independence statement for the services listed. **A hub shows no USD figure and no converted price**: every row is a `publishedView` record, which carries no `price_usd_source`. A hub carries no signup form, no signed referral field and no script beyond the shell's theme toggle and page-view emitter. Its cache contract is the price pages': a ref-less render in the default flag state is `public, max-age=0, s-maxage=300`, varying on the flag generation; `?ref=` and non-default flag states are `private, no-store`. Hubs do not use the origin render cache.
- **The page's links to its hubs.** Every generated service × market page has a "More prices" block linking to its service hub and its market hub; an unavailable ledger URL links to whichever of the two still exists.
- **Sitemaps.** Each kind of hub has its own child sitemap in the `/sitemap.xml` index: `/sitemaps/prices-index.xml` (`/prices`, while a page is live), `/sitemaps/prices-service-hubs.xml` and `/sitemaps/prices-market-hubs.xml`, each entry's `lastmod` the newest verification date the hub shows, never the build date. Written by every build and git-ignored.
- **Retiring a URL (D2, D-032 Q2).** `npm run price-index -- retire-url <url> --to <hub> --actor <name>` appends `{ kind: "retired", path, to, actor, retired_on }` to `data/price-index/published-urls.json`, after the URL's publication entry (`retired_on` from the injected clock). It refuses, writing nothing: a missing or empty `--actor` (before anything is read), a URL that is not a service × market page or was never published, one already retired, **a URL that still publishes a page** (a page in `generatedPages` of the current data: a retirement ends a URL's "temporarily unavailable" state and never takes down a live page, D-037 Q1), a `to` that is not `/prices/{service}` or `/prices/countries/{country}`, and a hub the current data does not make. **The target hub is checked at retirement time only:** a hub disappears with its last live page, and a URL retired to it keeps answering 301 to it, which then answers the branded 404; neither `validate` nor the build checks this. **A retirement applies only while its pair generates no page (D-037 Q2):** the URL then answers **301** to its `to`, in place of the unavailable state, and is in no sitemap, hub or related link. If its data later publishes again, the retirement entry stays in the ledger unchanged and the URL serves its page exactly like any generated page, with its sitemap entry, hub rows, related links and "More prices" block; if it then generates none again, it answers 301 again, never the unavailable state. A second retirement of the same path stays refused. The existing append-only check covers the ledger unchanged.
- **The flag.** `prices.pages` off answers `/prices` and every hub path with the same 503, `Retry-After`, `noindex` and paused card as the pages; a retired URL that generates no page answers 503 too, not its 301.

**Copy.** Every sentence is a template in `src/copy/prices.ts` or a content file, filled from data. Nothing is typed per page. The rules of `docs/brand/copy-rules.md` apply in full:

- sentence case;
- no exclamation marks and no hype — "below list price", never "insane deal";
- "digital goods", never "digital products";
- provider names used plainly ("Spotify Premium — Family");
- no countdowns or scarcity;
- **never a price we do not have, and never a converted price.**

**The methodology** describes the process in general terms (founder, 2026-11-17, D4): "We collect official list prices once a month from public price listings, and check them by hand against providers' own pricing pages where needed." **Every sentence on it must be literally true** of the built system (E11-04's claims rules), and it does not name the source.

**`/price-index` and the monthly reports (E11.6-13).**

- **`/price-index`** is the landing page and methodology. The methodology is the content file `src/content/price-index-methodology.md` (the `priceIndex` collection, `portTarget: /price-index`, ADR-017), and its own H1 is the page's only H1. It opens with D4 verbatim, then says, in the same general terms, what a price on the pages is, when one is published or held back (the currency and price > 0 checks, the ±40% rule, conflicts, disappearances), when one comes off the pages (45 and 90 days, applied each time the index is updated, since staleness is computed by `build-data`, never at render time), how changes are recorded and how markets are compared. It never says the prices are read from official pages: they are collected from a public listing and checked by hand against the providers' own pages where needed. **Every sentence is reconciled with the code or configuration it describes** by `test/price-index/price-index-methodology.test.ts`: a number against `config/price-index.json`, a rule against the publish gate, a behaviour against the named test that proves it. A changed setting with an unchanged sentence, a sentence without a trace, and a claim that the prices come from official pages each fail it, so a methodology edit and the change it describes ship together.
- Around the methodology, the page lists every monthly report, newest first ("No monthly report is published yet." with none), links to `/prices`, and shows the "Prices verified between … and …" line of the published prices while there are any. It carries **`Dataset` JSON-LD**: its name and description (`src/copy/prices.ts`), its URL, `spatialCoverage` (every enabled market, as a `Country` with its name and code), `temporalCoverage` (the oldest and newest verification dates of the published prices, an ISO 8601 interval, or one date when they are the same) and `dateModified` (the newest). Every figure in it comes from the published data, and with no published price there is no dataset to describe, so there is none. It states no price, count or USD figure.
- **`/price-index/{yyyy-mm}`** renders `data/price-index/monthly/YYYY-MM.json` (E11.6-09), bundled at build like the rest of the price data: the month's changes in a table, largest first, in local currency; the rises and falls ("Spotify Premium — Individual rose in 3 of 6 markets."); the most and least expensive markets of each ranked plan, each in its own currency, with the spread; and how many plans could not be ranked. A month with no changes says so. **Every page a report mentions is linked while it exists, and named without a link while it does not**: a service × market pair links to its generated page, a plan to its service hub. A pair that generates no page today (flagged, stale, retired, or no longer configured) is named only. A report is a dated record, so a service, plan or market the configuration no longer has is named as the ledger recorded it, else by its identifier. The page has a breadcrumb (Valstara → Price index → the report) mirrored by BreadcrumbList JSON-LD, and links back to the methodology. **A month with no report file has no page:** its path answers the branded 404. A file not named `YYYY-MM.json`, or whose `month` is not its name, or that fails its schema, fails the build.
- **Both** are behind `prices.pages`: off, they answer 503 with `Retry-After`, `noindex` and the paused card, as every price route does. They carry no signup form, no signed referral field and no script beyond the shell's page-view emitter and theme toggle; their cache contract is the hubs' (`public, max-age=0, s-maxage=300` ref-less in the default flag state, else `private, no-store`), outside the origin render cache. `/price-index` is in `/sitemaps/pages.xml`; the reports have their own child sitemap, `/sitemaps/price-index-monthly.xml`, each dated by its snapshot's build (`built_at`), never the site's build date. Their social-card kind is `prices`: each has its own title-only card (E11.6-14), with the typed `prices` card as fallback.
- **Every service × market page links the methodology** ("How we collect and check these prices"), generated or unavailable.

## User flows

1. **Monthly run (founder, by hand).** The steps are in `docs/price-index-runbook.md`.
   1. `npm run price-index -- scrape` fetches enabled markets politely and saves the raw pages. It writes the observations and a **preview** merge to `data/raw/<run_id>/`, writes the preview's coverage report to `reports/coverage-YYYY-MM-DD.{md,json}`, and prints its coverage and counts. It does not touch `latest.json`, and it exits. `scrape --dry-run` replays the latest raw run (or `--from-fixtures`, the captured pages) and prints what a build would change, fetching and writing nothing. A run the source stopped, or that was interrupted, resumes with `scrape --resume <run_id>`.
   2. The founder reads the coverage report.
   3. The founder resolves `needs_review` and `conflict` records with `review approve|reject`, and adds manual overrides with `override add` and `override not-offered` (and removes one with `override retire`). `npm run price-index -- report` rewrites the preview's coverage report against the data as it now stands, so the founder sees each decision's effect before building.
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
- **A service or market removed from config.** Its URLs behave exactly like lost data until the founder retires a URL with `price-index retire-url`, which records a 301 target, a hub, in the ledger (D2, E11.6-12). The retirement applies only while the URL generates no page: if the service or market returns with publishable data, its page comes back and is served, and the 301 resumes only if it later generates none again (D-037 Q2). Its hub disappears with its last live page: the hub path answers 404.
- **A record has no `price_usd_source`.** It is shown in its own page's plan table, but it is left out of every ranking, and M counts only the ranked markets. A page whose market is unranked for a plan shows no rank sentence for it (E11.6-11).
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

Organic entries and signups by price-page type (from Umami's page views and the existing server-side funnel events: no new event, and no property carrying personal data). Each run's counts are logged to `reports/runs/<run_id>.json` by `build-data`: fetched, matched, unmatched, changed (the real price changes the build appended to `changes.json`, E11.6-09), records by status (which includes every flagged status), and failed markets, with the coverage %. **There is no "not modified" count** (E11.6-07, founder decision 1 of 2026-11-18): the fetcher makes no conditional request, so no page can answer "not modified".

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
