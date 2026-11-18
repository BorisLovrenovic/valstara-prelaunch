# Module: price-index

Kind: a separate offline tool, outside the site. Implements ADR-033. The feature spec is `docs/features/price-index.md`; the source findings are `docs/features/price-index-source-findings.md`.

## Responsibility
Collect the official list prices of the services in `config/catalogue.json`, in every market in `config/markets.json`, once a month on the founder's command. Write them as committed JSON that the price pages build from. **The tool never runs inside the site, and the site never runs the tool.**

## Where it lives
`packages/price-index/`, a framework-agnostic TypeScript package run as `npm run price-index -- <command>` (`tsx packages/price-index/src/cli/main.ts`). It is not a server module: nothing under `src/` starts it, and it imports nothing from `src/` or Astro.

| Directory | Holds | Built by |
|---|---|---|
| `src/schema/` | Zod schemas for every config and data file, and the rules that span files | E11.6-02 (the three config files); E11.6-03 (the price record, `latest.json` and snapshots); later tickets add the other data files |
| `src/money/` | Exact money: displayed prices parsed into bigint minor units, written back in a local style, and arithmetic in one currency | E11.6-03 |
| `src/storage/` | The `PriceStore` interface and its JSON-file implementation: atomic, deterministic writes and immutable snapshots | E11.6-03 |
| `src/http/` | The browser fetcher: robots.txt, the request rule, one page at a time, jitter, backoff, the raw store and checkpoints | E11.6-04 |
| `src/cli/` | The `price-index` command | E11.6-02 (`validate`); later tickets add their commands |

The rest of the layout in `docs/features/price-index.md#repository-layout` arrives with the ticket that owns each part. A missing directory is correct until then.

## Data owned
The configuration, all hand-edited and committed:

| File | Holds |
|---|---|
| `config/markets.json` | `{ "markets": [...] }`. Each market: `code` (ISO 3166-1 alpha-2, upper case), `name`, `slug` (lower-case kebab-case, the permanent URL segment), `currency` (ISO 4217), `enabled`. Seeded with the 20 markets, all enabled (founder, 2026-11-17) |
| `config/catalogue.json` | `{ "services": [...] }`. Each service: `service_id` (lower-case kebab-case), `name`, `category` (`ai` · `streaming` · `music` · `productivity` · `learning` · `fitness`), `website_url` (https), `status` (`selling_now` · `launch` · `planned`), `plans[]` (at least one) and `source_aliases`. Each plan: `plan_id`, `name`, `billing_period` (`month` · `year`), `is_student`, `is_family` |
| `config/price-index.json` | The tool's settings. E11.6-04 creates it with the fetcher's keys only, under `fetcher`: `source_origin` (exactly `https://www.youfundceo.com`, the host allowlist), `jitter_seconds` `{ min, max }` (8, 20), `page_timeout_seconds` (60), `checkpoint_wait_seconds` (30), `backoff` `{ initial_seconds, multiplier, max_seconds, retry_after_max_seconds }` (60, 2, 900, 3600), `max_consecutive_failures` (3) and `raw_runs_kept` (6). All are whole numbers; the jitter floor is at least 1 s and the backoff never starts below it. There is no `User-Agent` key: D6's `PriceIndexBot/1.0` is superseded for the fetcher |
| `config/valstara-prices.json` | `{ "prices": [...] }`, seeded empty. Each entry: `service_id`, `plan_id`, `market` (a market code), `term_months` (a whole number ≥ 1), `price_local` (a positive exact decimal string, never a number) and `currency` |

The price data, written only through `PriceStore` (E11.6-03), and read by the pages at build time:

| File | Holds |
|---|---|
| `data/price-index/latest.json` | `{ "built_at", "records": [...] }`: `built_at` is the build's RFC 3339 UTC time, and `records` holds at most one price record per market × service × plan × billing period |
| `data/raw/<run_id>/` | **Gitignored.** One fetch run (E11.6-04): `robots.txt` as sent, `pages/<name>.html` as the browser rendered each page, `checkpoint.json` (the units completed so far) and `fetch-report.json`. `<run_id>` is the run's UTC start, `20261118T093000Z` (`-2`, `-3`, … for a second run in the same second). Rotated to the last `raw_runs_kept` runs |
| `data/price-index/snapshots/YYYY-MM-DD.json` | The `latest.json` of one build, with the same schema. A date's second snapshot is `YYYY-MM-DD-2.json`, its third `-3`, and so on. **Never replaced** |

**The price record** (`docs/features/price-index.md#the-price-record`) carries every one of its fifteen keys, in the spec's order, with `null` where a value is absent: `market`, `service_id`, `plan_id`, `billing_period`, `price_local`, `price_source_text`, `currency`, `price_usd_source`, `source`, `source_url`, `observed_at`, `source_verified_at`, `status`, `missing_reason`, `notes`. Its schema (`src/schema/price-record.ts`) is strict, so **an `fx` field, or any converted price, is rejected** like every other unknown key. It also enforces:

- `price_local` is a decimal string at the currency's ISO 4217 minor-unit exponent (`"149.00"` SEK, `"1190"` ISK, `"1.250"` KWD; `minorUnitExponent` in `src/schema/iso4217.ts`). A JSON number is rejected;
- `price_usd_source` is a decimal string with two decimals (`"16.78"`), and only beside a local price;
- `price_local` and `currency` are both set or both null, and `price_source_text` only beside a local price;
- `missing_reason` is set exactly when the status is `missing`;
- `missing` and `not_offered` carry no price, and `ok` and `manual_override` always do. The other statuses may or may not, which E11.6-06's merge rules decide;
- `source` is `scraper:youfundceo.com`, `manual` or `direct:<provider>`, `source_url` is https, `observed_at` is RFC 3339 UTC and `source_verified_at` is a `YYYY-MM-DD` date.

**`source_aliases`** is `{ "service": [...], "plans": { "<plan_id>": [...] } }`: the names the source uses for the service and for each plan, used for matching and nothing else. Each list holds the source's display name and its slug or plan-row key, as recorded in the findings, e.g. `"Netflix"` and `"netflix"`, `"Premium Individual"` and `"individual"`. **A plan with no entry has no alias**, so no source row can match it and it stays `missing`. The seed carries only the five confirmed and four founder-confirmed mappings of the findings (D-019 Q4, option B). Adobe Creative Cloud is unmapped by founder decision, and the eleven products the source does not list have no aliases.

**Alias normalisation** (`normaliseAlias` in `src/schema/common.ts`) is the one implementation every comparison uses: Unicode compatibility decomposition, diacritics removed, lower case, and every run of punctuation or whitespace collapsed to one space. `"apple-tv-plus"` normalises to `"apple tv plus"`.

## Exposed interface
```ts
// packages/price-index/src/schema — one of the two entry points src/ may import
marketsFileSchema, catalogueFileSchema, valstaraPricesFileSchema   // one file each
configSetSchema                       // the three together, with the cross-file rules
configIssues(input): { config?, issues: { file, path, message }[] }
normaliseAlias(value): string

// packages/price-index/src/schema — E11.6-03
priceRecordSchema, latestFileSchema, snapshotFileSchema
priceStatuses, missingReasons, priceRecordKeys, recordIdentity(record)
minorUnitExponent(currency), isDecimalAtExponent(value, currency)
```

```ts
// packages/price-index/src/money — the tool only; the site does not import it
parseMoney(text, { currency? }): { money, style, sourceText }   // a displayed price
parseDecimal(text, currency): Money        // a plain decimal, e.g. a JSON number's text
toDecimalString(money), fromDecimalString(value, currency)    // the record's form
formatMoney(money, style): string          // writes a price back in a local style
fromMinor(currency, minor: bigint), add, subtract, multiply(money, factor: bigint), compare, equals
MoneyError { code }                        // every refusal, with a code from moneyErrorCodes
```

```ts
// packages/price-index/src/storage — the tool only
interface PriceStore {
  readLatest(): Promise<LatestFile | null>;            // null before the first build
  writeLatest(latest): Promise<void>;                  // validated, atomic, deterministic
  writeSnapshot(snapshot, date): Promise<SnapshotRef>; // never replaces a file
  listSnapshots(): Promise<SnapshotRef[]>;             // oldest first
}
createJsonFileStore({ directory, fs? }): PriceStore    // fs: injectable write calls, for tests
writeFileAtomic(target, content, { mode: 'replace' | 'create' })
serialisePriceIndexFile(file): string
PriceStoreError { code }   // invalid_data · not_json · invalid_date · snapshots_exhausted
```

```ts
// packages/price-index/src/http — the tool only (E11.6-04)
openFetchSession({ origin, settings, driver, clock, random, rawRoot, resumeRunId?, signal? }): FetchSession
interface FetchSession {
  runId; robots;                                  // the `*` group of the run's robots.txt
  isCompleted(unitId): boolean;
  runUnit(unitId, work: (fetchPage) => Promise<void>): Promise<'completed' | 'skipped' | 'stopped'>;
  finish(): Promise<FetchReport>;                 // also written to data/raw/<run_id>/fetch-report.json
}
fetchPage(pathOrUrl): Promise<FetchedPage>        // ok (with html and file) · not_found · http_error · refused
fetchUnits(session, units: { id, paths }[]): Promise<FetchReport>    // a fixed plan
FetchStoppedError { reason }                      // source_refused · retry_after_too_long · interrupted
fetchExitCodes                                    // completed 0 · stopped_by_source 2 · interrupted 4
interface BrowserDriver { load({ url, isPathOpenable, read }): Promise<LoadResult>; close() }
createPlaywrightDriver({ browser, origin, pageTimeoutMilliseconds, checkpointWaitMilliseconds })
launchChromium(origin), evasionLaunchArguments, sourceOnlyLaunchArguments(origin)
classifyRequest(facts, pageInProgress), isPathOpenable(robots, path), alwaysRefusedPrefixes
parseRobots(text), backoffMilliseconds(backoff, n), retryAfterMilliseconds(value, now)
Clock { now(), sleep(ms, signal?) }, systemClock, seededRandom(seed), freshRandom()
createRun, openRun, rotateRuns, readCheckpoint, writeCheckpoint, pageFileName, readFetcherSettings(root)
```

```
npm run price-index -- validate
```

Exit codes: `0` done, `1` usage error, `3` validation failure. E11.6-07 adds `2` (stopped by the source) and `4` (interrupted); the fetcher's report already carries them as `exit_code`.

## Rules
- **`validate` rejects**, naming the file and the path:
  - a duplicate `service_id`, a duplicate `plan_id` within a service, a duplicate market code or a duplicate market slug;
  - an unknown category, status or billing period;
  - a currency not in the ISO 4217 table (`src/schema/iso4217.ts`: active codes of List One as at 2026-11-17, without fund codes, metals, the testing code or `XXX`);
  - a slug that is not lower-case kebab-case, or the `service_id` `countries`, which the market hub route `/prices/countries/{country}` reserves;
  - **an alias that maps to two different plans of a service, or to two services**, compared after normalisation, and an alias entry for an unknown plan;
  - a Valstara price for an unknown service, plan or market, in a currency other than the market's, or a second entry for the same service, plan, market and term;
  - in `config/price-index.json`: a `source_origin` other than `https://www.youfundceo.com`, a delay, timeout or count that is not a positive whole number, a jitter `min` above its `max`, a backoff that starts below the jitter floor or above its own cap, a multiplier below 1, or an unknown or missing key;
  - an unknown key in any object, a missing file or a file that is not JSON.
- The same plan alias may appear under two services, because matching finds the service first.
- **Adding or removing a service, a plan or a market is a change to `config/` only.** `validate` accepts it with no code change (epic rule 5).
- **`npm run check` runs `price-index validate` first**, so an invalid config file stops it before any other check.
- **The isolation scan** (`scripts/ci/price-index-isolation.mjs`, part of `npm run security`) enforces the boundary in ADR-033.

**Money (E11.6-03, epic rule 3).** A price is a bigint count of its currency's minor unit, and is stored as the decimal string `toDecimalString` writes. **A float never holds a price**: every money function refuses a JavaScript number, and **the float scan** (`scripts/ci/price-index-float-scan.mjs`, part of `npm run security`) fails on any `parseFloat` or `Number(` in `packages/price-index/src/`. Arithmetic never mixes currencies, and nothing converts one into another.

- **`parseMoney` reads every format E11.6-01 recorded on the 38 captured country pages**: the source's own style (`kr 169` and `CHF 23.40` with a no-break space, `€8`, `£66.49`, `CA$143.40`, `A$16`, `NZ$17`, `Ft 2,790`, `Kč 2,449`, `RSD 2,599`), a foreign currency's ISO tag (`€18 EUR`) and the US `+ tax` suffix (`$19.99 + tax`). It also reads the local forms the ticket names (`149 kr`, `11,99 €`, `23,99 zł`, `25,99 lei`, `C$12.99`), with a mark before or after the number and thousands written as `.`, `,`, a space, a no-break space, a narrow no-break space or an apostrophe (`'` or `’`).
- **The currency.** A mark settles it when only one currency uses it: `€`, `£`, `zł`, `lei`, `Kč`, `Ft`, `A$`/`AU$`, `C$`/`CA$`, `NZ$`, `US$`, or a three-letter ISO code. `kr` (SEK, NOK, DKK, ISK) and `$` (USD, CAD, AUD, NZD) need the caller's currency, such as the source's `official.currency`. The caller's currency must agree with any mark in the text. Another dollar or krona currency must be written with its ISO code, or the parse fails (`src/money/symbols.ts`).
- **Nothing is guessed.** A single `.` or `,` followed by exactly three digits (`1.299`) is thousands only when the currency has fewer than three decimals, so `.299` cannot be its decimals. With no currency, or a three-decimal currency, it is refused as `ambiguous_separator`. A text with more decimals than its currency's exponent, more than one number, an unknown mark or word, a sign, a leading zero, or thousands not grouped in threes is refused too. Nothing is rounded.
- **`price_source_text` is the text as given**, outer whitespace and all; `parseMoney` returns it unchanged as `sourceText`, and storage writes it unchanged.
- **`formatMoney` writes a price back** in the style `parseMoney` read (`formatMoney(parsed.money, parsed.style) === text`, outer whitespace aside). For another amount it writes the style's decimals when they hold the amount exactly, and otherwise all of the currency's decimals; a style with no decimal separator refuses an amount with decimals.

**Storage (E11.6-03).**

- **Every write is atomic.** The content goes to a temporary file in the same directory (`.<name>.<pid>-<n>.tmp`, opened exclusively), is flushed, and only then takes the target's name. `latest.json` is renamed over; a snapshot is linked into place, which fails if the name exists. A crash at any point leaves the previous file byte-identical. A temporary file a crash leaves behind is ignored by `listSnapshots` and by git (`/data/price-index/**/*.tmp` in `.gitignore`).
- **Data is validated before anything is written**, and `readLatest` validates what it reads.
- **Output is deterministic** (epic rule 8): the file's keys are `built_at` then `records`, each record's keys are in the spec's order, and records are sorted by `service_id`, `plan_id`, `billing_period` and `market` in code-unit order. JSON is written with two-space indentation and one trailing newline, and passes `npm run format`.
- **Snapshots are immutable** (epic rule 7). A date's first snapshot is `YYYY-MM-DD.json`; a second build on that date takes `-2`, and so on, up to 999 a date. A writer that loses a race for a number takes the next one; no snapshot is ever replaced.

**The browser fetcher (E11.6-04).** Everything below is enforced in `src/http/` and tested against a local fake server in real Chromium (`test/price-index/fetcher-browser.test.ts`). No AI agent session runs it against the source (epic rule 2).

- **A headless browser presenting as an ordinary browser** (founder decision 2 of 2026-11-17). Pages load in headless Chromium driven by Playwright, with the three measures the founder's capture used and no more: the launch argument `--disable-blink-features=AutomationControlled`, `HeadlessChrome` replaced with `Chrome` in the `User-Agent`, and `navigator.webdriver` hidden. Locale `en-US`, a 1366 × 900 viewport, and service workers blocked so no request bypasses the rule below. **No CAPTCHA is solved and no proxy or IP rotation is used**; the evasion scan enforces both.
- **One browser context per run, one page at a time, by construction.** The session's loop awaits each load, a second `fetchPage` while one is loading throws, and the driver refuses a second `load` while one is in progress. The run also uses one tab, kept between pages. Chromium lets some requests outlive their page (a `<link rel=prefetch>`, a beacon, a keep-alive fetch) and sends one on if its tab closes while the request waits for the rule, so after each page the tab moves to `about:blank`. There nothing more can start, and every request still waiting meets the rule and is refused. The tab and context close only once every routed request has been decided.
- **The request rule (founder decision 1 of 2026-11-18, D-025 Q1).** Every request the browser makes goes through `classifyRequest`, which refuses by default before the request leaves the browser:
  - **allowed:** the main-frame navigation to the URL the tool asked for, and its reload or same-host redirect while the checkpoint completes; same-host `script` and `stylesheet` requests; same-host `fetch` and `xhr` requests with no `_rsc` query parameter and no `rsc` or `next-router-prefetch` header;
  - **refused:** any request carrying `_rsc`, `rsc` or `next-router-prefetch`; every `image`, `font` and `media` request and every other resource type, subframe documents included; every request to another origin (scheme, host and port); and every request of any type to a path the `*` group of `robots.txt` disallows, or under `/api/` or `/go/`.
  - Playwright never routes the later hops of a redirect, so the browser is also launched with `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE <source host>`: a redirect to another host fails before a connection is made, and the page counts as a failure. A redirect hop to a bare IP address is the one case neither line stops; a page that ends up off the source is still rejected and never stored.
- **No conditional requests** (founder decision 2 of 2026-11-18). The fetcher sends no `If-None-Match` or `If-Modified-Since` and keeps no `ETag` or `Last-Modified` state. With request routing on, Playwright loads every request without the browser cache, which the browser test checks for a page and its assets loaded twice.
- **Robots.** `robots.txt` is the run's first load, read as sent and stored in the raw store. Only the `*` group applies (RFC 9309 longest match, an Allow winning a tie, `*` and `$` patterns). A `404`, `410` or other 4xx answer apart from `403` and `429` means no rules; `/api/` and `/go/` are refused regardless. A resumed run keeps the robots.txt it started with.
- **Host allowlist.** `source_origin` can only be `https://www.youfundceo.com`. A page on another origin, or on a path robots.txt disallows, is refused before a page is opened, and costs no delay.
- **Delays.** Before every load but the session's first, the fetcher waits a jitter drawn uniformly from `jitter_seconds` with the injected seeded source, or the `*` group's `Crawl-delay` when that is longer.
- **Failures and backoff.** A load fails when it answers `403`, `429` or `5xx`, times out (`page_timeout_seconds`), errors in the browser (a refused redirect included), or **still shows the bot checkpoint after `checkpoint_wait_seconds`**. The checkpoint is a `403` or `429`, `x-vercel-mitigated: challenge`, or the title "Vercel Security Checkpoint"; the fetcher waits for it to complete on its own and never interacts with it. After the n-th consecutive failure the same page is retried after `initial_seconds × multiplier^(n−1)`, capped at `max_seconds`, or after `Retry-After` (seconds or an HTTP date) when longer. A `Retry-After` beyond `retry_after_max_seconds` stops the run instead. **`max_consecutive_failures` failures in a row stop the run cleanly**, as `stopped_by_source` with exit code `2` in the report. A `404` or `410` is `not_found`, another 4xx is `http_error`; neither is a failure, and a success resets the count.
- **Checkpoints and resume.** Work is grouped into units (a market). When a unit's work finishes, `checkpoint.json` is replaced atomically with the completed units. A run that stops or is interrupted (`signal`, reported as `interrupted`, exit code `4`) leaves the checkpoint; `resumeRunId` reopens that run, skips every checkpointed unit without a request and refetches the unit that was in progress. A checkpoint of another run or origin is refused.
- **Raw store and rotation.** Each loaded page is written atomically to `data/raw/<run_id>/pages/<name>.html` (its path with `/` as `__`, the home page as `home`, a query after `__q-`). When a run starts, the oldest run directories are deleted so that `raw_runs_kept` remain, the current run always among them; nothing that is not named like a run is touched.

**Installing Chromium, once.** The fetcher drives the Chromium build that matches the installed `playwright` (1.62.1). On the machine that runs the tool, install it once with `npx playwright install --with-deps chromium`. Alternatively, run the tool inside the repository's pinned Playwright image (`mcr.microsoft.com/playwright:v1.62.1-noble`), which already carries Chromium and its system libraries, as the P9 capture did (`docs/prerequisites/p9-source-capture.md`). The monthly routine itself is E11.6-15's runbook.

## Dependencies
`zod` 4.6.7 (MIT), a direct runtime dependency at the version Astro already installs. `playwright` 1.62.1 (Apache-2.0), already a dev dependency, drives the fetcher's Chromium (E11.6-04); the tool never ships in the image, so it stays a dev dependency. Nothing in the package reaches the site's browser.

## Contract tests
`test/price-index/config-schema.test.ts`: an accept and a reject case for every field rule, and the alias collisions · `test/price-index/config-seed.test.ts`: the seed is exactly the founder's markets, catalogue and confirmed aliases · `test/price-index/config-changes.test.ts`: adding and removing a service, a plan and a market passes `validate` · `test/price-index/check-gate.test.mjs`: `npm run check` fails on a planted invalid file · `test/price-index/isolation-scan.test.mjs`: the isolation scan's red paths and green paths, with the wired red path in `test/fixtures/security/gates.json` · `test/price-index/money-parse.test.ts`: a format table for every market currency and every captured currency, each with every thousands separator; ambiguity, currency and malformed-text refusals; number inputs refused; every price on the 38 captured country pages read against its embedded value (E11.6-03) · `test/price-index/money-format.test.ts`: round-trip formatting, decimal strings and minor-unit arithmetic · `test/price-index/price-record-schema.test.ts`: the record's field and cross-field rules, the `fx` and converted-price rejections, and the latest and snapshot files · `test/price-index/price-store.test.ts`: source-text round trip, byte-stable serialisation passing Prettier, an injected failure and a killed process before the rename, snapshot immutability under a race, and snapshot listing · `test/price-index/float-scan.test.mjs`: the float scan's red and green paths · `test/price-index/fetcher-browser.test.ts` (E11.6-04): in real Chromium against a local fake server, at most one page-level request in flight over every browser request under a queue of 50; prefetches, images, fonts, media, frames, `/api/` and a second host refused in the browser and never reaching either server; no headless marker and `navigator.webdriver` hidden; no conditional request; a checkpoint that clears through a same-host script and fetch, and one that never clears stopping the run and resuming; page timeouts; redirects · `test/price-index/fetcher.test.ts`: with a fake driver, injected clock and seeded source, the delay against the jitter floor and `Crawl-delay`, the backoff sequence and its cap, `Retry-After`, every failure kind, the stop and its checkpoint, resume, refusal before a page opens, one page at a time and interruption · `test/price-index/request-rule.test.ts`: every allowed and refused request kind · `test/price-index/robots.test.ts`: the `*` group, longest match and `Crawl-delay`, on the captured robots.txt and planted files · `test/price-index/raw-store.test.ts`: rotation keeps exactly the configured number of runs, run ids and the checkpoint · `test/price-index/fetcher-settings.test.ts`: the committed settings and every rejected value · `test/price-index/evasion-scan.test.mjs`: the evasion scan's red and green paths.
