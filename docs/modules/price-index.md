# Module: price-index

Kind: a separate offline tool, outside the site. Implements ADR-033. The feature spec is `docs/features/price-index.md`; the source findings are `docs/features/price-index-source-findings.md`.

## Responsibility
Collect the official list prices of the services in `config/catalogue.json`, in every market in `config/markets.json`, once a month on the founder's command. Write them as committed JSON that the price pages build from. **The tool never runs inside the site, and the site never runs the tool.**

## Where it lives
`packages/price-index/`, a framework-agnostic TypeScript package run as `npm run price-index -- <command>` (`tsx packages/price-index/src/cli/main.ts`). It is not a server module: nothing under `src/` starts it, and it imports nothing from `src/` or Astro.

| Directory | Holds | Built by |
|---|---|---|
| `src/schema/` | Zod schemas for every config and data file, and the rules that span files | E11.6-02 (the three config files); E11.6-03 (the price record, `latest.json` and snapshots); E11.6-06 (`manual-overrides.json`, `approvals.json` and the merge settings); E11.6-07 (the run files); E11.6-08 (the coverage report and the report settings); E11.6-09 (`changes.json` and the monthly report); later tickets add the other data files |
| `src/money/` | Exact money: displayed prices parsed into bigint minor units, written back in a local style, and arithmetic in one currency | E11.6-03 |
| `src/storage/` | The `PriceStore` interface and its JSON-file implementation: atomic, deterministic writes and immutable snapshots; the append-only writers of `approvals.json`, `changes.json` and `published-urls.json`; the writer of `manual-overrides.json`; reading a snapshot back | E11.6-03; E11.6-06 (`approvals.json`); E11.6-08 (`manual-overrides.json`); E11.6-09 (`changes.json`, `readSnapshot`); E11.6-10 (`published-urls.json`) |
| `src/http/` | The browser fetcher: robots.txt, the request rule, one page at a time, jitter, backoff, the raw store and checkpoints | E11.6-04 |
| `src/sources/` | The `SourceAdapter` interface, name matching through `source_aliases`, and the youfundceo adapter: its request plan, its page readers and its reader of the embedded page data | E11.6-05 |
| `src/pipeline/` | The merge: the status rules that turn a run, the founder's manual entries and decisions and the previous `latest.json` into the next one; change detection | E11.6-06; E11.6-09 (change detection) |
| `src/publish/` | The publish gate: `isPublishable`, `publishedView` and `rankMarkets`; the generation rule of the service × market pages, `generatedPages`, and the published-URL ledger's entries and slug check. With `src/schema`, the only part the site imports; it imports nothing but `src/schema` | E11.6-06; E11.6-10 (the generation rule and the ledger) |
| `src/reports/` | The run's figures: coverage, the counts, the run log and the console summary; the coverage report; the monthly report and its cross-check | E11.6-07 (the run log); E11.6-08 (the coverage report); E11.6-09 (the monthly report) |
| `src/cli/` | The `price-index` command | E11.6-02 (`validate`); E11.6-06 (`review`); E11.6-07 (`scrape`, `build-data`, `validate` of the data files, `review` on the preview); E11.6-08 (`report`, `override`); E11.6-09 (`monthly-report`, change detection in `build-data`); later tickets add their commands |
| `copy/` | The report's sentence templates, scanned by the forbidden-copy scan | E11.6-09 |

The rest of the layout in `docs/features/price-index.md#repository-layout` arrives with the ticket that owns each part. A missing directory is correct until then.

## Data owned
The configuration, all hand-edited and committed:

| File | Holds |
|---|---|
| `config/markets.json` | `{ "markets": [...] }`. Each market: `code` (ISO 3166-1 alpha-2, upper case), `name`, an optional `name_in_sentence` (the name as it reads inside a sentence, where English needs an article: "the United States"; it must contain `name`, and the pages use `name` without it; E11.6-10), `slug` (lower-case kebab-case, the permanent URL segment), `currency` (ISO 4217), `enabled`. Seeded with the 20 markets, all enabled (founder, 2026-11-17); the United Kingdom, the Netherlands and the United States carry a `name_in_sentence` |
| `config/catalogue.json` | `{ "services": [...] }`. Each service: `service_id` (lower-case kebab-case), `name`, `category` (`ai` · `streaming` · `music` · `productivity` · `learning` · `fitness`), `website_url` (https), optional `official_hosts` (bare lower-case hostnames, no scheme, path or port; no duplicates and none equal to the `website_url` host; D-031 Q1), `status` (`selling_now` · `launch` · `planned`), `plans[]` (at least one) and `source_aliases`. Each plan: `plan_id`, `name`, `billing_period` (`month` · `year`), `is_student`, `is_family` |
| `config/price-index.json` | The tool's settings. E11.6-04 creates it with the fetcher's keys only, under `fetcher`: `source_origin` (exactly `https://www.youfundceo.com`, the host allowlist), `jitter_seconds` `{ min, max }` (8, 20), `page_timeout_seconds` (60), `checkpoint_wait_seconds` (30), `backoff` `{ initial_seconds, multiplier, max_seconds, retry_after_max_seconds }` (60, 2, 900, 3600), `max_consecutive_failures` (3) and `raw_runs_kept` (6). All are whole numbers; the jitter floor is at least 1 s and the backoff never starts below it. There is no `User-Agent` key: D6's `PriceIndexBot/1.0` is superseded for the fetcher. E11.6-06 adds the merge's keys under `merge`: `change_threshold_percent` (40, a whole number from 1 to 1000) and `stale_after_days` `{ scraped, manual }` (45, 90, whole days). E11.6-08 adds the coverage report's under `reports`: `spot_checks` (5, a whole number from 1 to 1000), the number of `ok` records the spot-check list samples |
| `config/valstara-prices.json` | `{ "prices": [...] }`, seeded empty. Each entry: `service_id`, `plan_id`, `market` (a market code), `term_months` (a whole number ≥ 1), `price_local` (a positive exact decimal string, never a number) and `currency` |

The price data, written only through `PriceStore` (E11.6-03), and read by the pages at build time:

| File | Holds |
|---|---|
| `data/price-index/latest.json` | `{ "built_at", "records": [...] }`: `built_at` is the build's RFC 3339 UTC time, and `records` holds at most one price record per market × service × plan × billing period |
| `data/raw/<run_id>/` | **Gitignored.** One fetch run (E11.6-04): `robots.txt` as sent, `pages/<name>.html` as the browser rendered each page, `checkpoint.json` (the units completed so far) and `fetch-report.json`. `scrape` (E11.6-07) adds `observations.json`, what the run read (below), and `preview.json`, the latest.json a build of it would write, in `latest.json`'s schema and format. `<run_id>` is the run's UTC start, `20261118T093000Z` (`-2`, `-3`, … for a second run in the same second). Rotated to the last `raw_runs_kept` runs |
| `data/price-index/snapshots/YYYY-MM-DD.json` | The `latest.json` of one build, with the same schema. A date's second snapshot is `YYYY-MM-DD-2.json`, its third `-3`, and so on. **Never replaced** |
| `data/price-index/manual-overrides.json` | `{ "overrides": [...] }`, seeded empty (E11.6-06; E11.6-08's `override` commands write it, entries in identity order: service, plan, billing period, market, with each entry's keys in the order listed here). Each entry has `kind` (`price` or `not_offered`), `market`, `service_id`, `plan_id`, `billing_period`, `source_url` (the https page the founder read), `verified_at` (`YYYY-MM-DD`), `verified_by` (non-empty) and `note`. A `price` entry adds `price_local` (above zero, at the currency's exponent), `currency` and an optional `price_usd_source` (two decimals, or `null`, which leaves the record unranked). A `not_offered` entry carries no price. At most one entry per market × service × plan × billing period |
| `data/price-index/approvals.json` | `{ "approvals": [...] }`, seeded empty, **append-only** (E11.6-06). Each entry: `decision` (`approve` or `reject`), `market`, `service_id`, `plan_id`, `billing_period`, `price_local` and `currency` (both `null` for a disappearance), `source`, `actor` (non-empty) and `decided_at` (RFC 3339 UTC). Entries stay in the order they were made, so the last decision for a value is the last matching entry |
| `reports/runs/<run_id>.json` | **Committed.** The run log of one build (E11.6-07), written by `build-data`: `run_id`, `source`, `fetch_status` (`completed`, `stopped_by_source` or `interrupted`), `market_scope` (the `--market` code, or `null`), `observed_at`, `built_at`, `snapshot` (the snapshot the build wrote), `coverage_percent`, `counts` (`fetched`, `matched`, `unmatched`, `records_by_status` with all seven statuses, `failed_markets`, `changed`), `failed_markets` (`{ market, failed_records }`) and `failures` (each failed page: `url`, `market`, `reason`, `detail`). **No "not modified" count** (E11.6-07 founder decision 1). A second build of the same run replaces it |
| `data/price-index/changes.json` | `{ "changes": [...] }`, seeded empty, **append-only** (E11.6-09), written only by `build-data`. Each entry: `market`, `service_id`, `plan_id`, `billing_period`, `old_price_local`, `new_price_local` (both at the currency's exponent, never equal), `currency`, `change_percent` (signed text with one decimal, `"15.5"`, `"-7.8"`), `detected_on` (`YYYY-MM-DD`) and `source` (the new value's). Entries stay in the order the builds found them. No USD figure |
| `data/price-index/published-urls.json` | `{ "urls": [...] }`, seeded empty, **append-only** (E11.6-10), written only by `build-data`: the ledger of every price URL ever published. Each entry: `path` (`/prices/{service}/{country}`, naming its `service_id`), `service_id`, `market` (its code), `service_name` and `market_name` (as they read in a sentence) when it was first published, and `first_published_on` (the date of that build's `built_at`). One entry per path. Each build appends the pages it generates for the first time, in path order. The site serves every ledger URL: a URL whose data is lost renders "temporarily unavailable" with `noindex` and never answers 404 |
| `data/price-index/monthly/YYYY-MM.json` | **Committed.** The monthly report's figures for `/price-index/{yyyy-mm}` (E11.6-09), written by `monthly-report`; a later report of the same month replaces it. `month`, `snapshot` (the month's last snapshot, which the figures are read from), `built_at` (that snapshot's), `markets` (enabled markets), `changes` (the month's change entries without their `source`, largest % first) and `plans` (per catalogue plan with a published price: `published_markets`, `ranked_markets`, `most_expensive` and `least_expensive` as `{ market, price_local, currency }` or `null`, `spread_ratio` as one-decimal text or `null`, `rose_in`, `fell_in`). **No USD figure, no source credit and no cross-check** |
| `reports/monthly/YYYY-MM.md` | **Committed.** The same figures as Markdown for outreach, plus the founder-only cross-check against the source's "Price moves" (E11.6-09) |
| `reports/coverage-YYYY-MM-DD.json` and `.md` | **Committed.** The coverage report of one run against the founder's data (E11.6-08), dated by the merge's `built_at`; a later report of the same date replaces it, so a build's final report replaces that day's preview. The JSON: `kind` (`preview` or `final`), `run_id`, `source`, `fetch_status`, `market_scope`, `built_at`, `markets` (the enabled codes, the matrix's columns), `coverage` (`overall`, `by_market`, `by_service`, each `publishable`, `records` and `percent`), `matrix`, `missing`, `flagged`, `retirable_overrides`, `unranked`, `untracked` and `spot_checks` (`requested`, `seed`, `records`). The Markdown is rendered from the same object. **No USD figure** |

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

```ts
// packages/price-index/src/sources — the tool only (E11.6-05)
interface SourceAdapter {
  id; source; origin;                                  // 'youfundceo', 'scraper:youfundceo.com', https://www.youfundceo.com
  units(context): RunUnit[];                           // { id: 'index', market: null }, then { id: 'market:<code>', market } per enabled market
  requests(unit, context, pages: RawPages): string[];  // the absolute URLs the unit still needs; [] once it is complete
  parse({ observedAt, pages }, context): SourceParseResult;  // pure: fetches nothing, writes nothing
}
SourceContext { catalogue, markets }                   // the parsed config files
RawPages = ReadonlyMap<url, RawPage>                   // { url, outcome: 'ok', html } | { url, outcome: 'not_found' | 'http_error' | 'refused', detail }
SourceParseResult { source, observations, gaps, untracked, priceMoves, failures }
Observation        // market, service_id, plan_id, billing_period, price_local, price_source_text, currency,
                   // price_usd_source, source, source_url, observed_at, source_verified_at (the record's fields)
SourceGap { market, service_id, plan_id, billing_period, reason, source_url, note }   // reason: a missing_reason
UntrackedEntry     // { kind: 'service', source_service, source_name, suggestion } |
                   // { kind: 'plan', service_id, source_service, source_plan, source_name, billing_period, markets, suggestion }
PriceMove          // one row of the source's "Price moves", exact decimals, with the catalogue's ids when they match
PageFailure { url, market, reason: 'parse_failed' | 'market_failed', detail }
SourceInputError   // a malformed observedAt
youfundceoAdapter, youfundceoSource
matchesAlias(sourceNames, aliases), nameSimilarity(a, b), suggestAlias(sourceNames, candidates), suggestionThreshold
```

```ts
// packages/price-index/src/schema — E11.6-06
manualOverridesFileSchema, manualEntrySchema, manualOverridesFile   // data/price-index/manual-overrides.json
approvalsFileSchema, approvalEntrySchema, approvalEntryKeys, approvalsFile, reviewDecisions
mergeSettingsSchema                   // config/price-index.json `merge`
```

```ts
// packages/price-index/src/pipeline — the tool only (E11.6-06)
mergePriceIndex({ previous, run, overrides, approvals, catalogue, markets, settings, clock }): LatestFile
  // run: { source, observedAt, observations, gaps }, as SourceAdapter.parse returns them with the run's time
  // pure: reads and writes no file; built_at is clock.now()
retirableOverrides(latest, overrides): PriceOverride[]   // overrides the scraper now agrees with
MergeError { code }    // invalid_input · duplicate_input · billing_period · override_currency · invalid_output
```

```ts
// packages/price-index/src/publish — one of the two entry points src/ may import (E11.6-06)
isPublishable(record): boolean          // ok or manual_override, with a price above zero
publishedView(latest): { built_at, records: PublishedRecord[] }   // publishable records, without price_usd_source or notes
rankMarkets(latest, { service_id, plan_id, billing_period }): { rank, market, record }[]
PublishGateError                         // latest.json failed its schema: nothing is published

// E11.6-10: the generation rule and the published-URL ledger
generatedPages(latest | null, catalogue, markets): GeneratedPage[]   // { path, service_id, market, service_name, market_name, market_name_in_sentence, records }
servicePagePath(serviceId, marketSlug): string                         // /prices/{service}/{country}
publishedUrlsFor(pages, builtOn): PublishedUrl[]                        // the ledger entries for those pages
ledgerPathConflicts(ledger, catalogue, markets): { entry, expected }[]  // published URLs the configuration would now move
```

```ts
// packages/price-index/src/storage — E11.6-06
readApprovals(path): Promise<ApprovalsFile | null>
appendApproval(path, entry, { fs? }): Promise<ApprovalsFile>   // validated, atomic, at the end only
serialiseApprovals(file): string
```

```ts
// packages/price-index/src/schema — E11.6-07
runObservationsFileSchema, RunObservationsFile   // data/raw/<run_id>/observations.json
runLogFileSchema, RunLogFile, runLogKeys         // reports/runs/<run_id>.json
observationSchema, sourceGapSchema, pageFailureSchema, runIdPattern, runStatuses, runLogDirectory
```

```ts
// packages/price-index/src/reports — the tool only (E11.6-07)
runFigures(observations, latest): RunFigures   // coverage_percent, counts, failed_markets, failures
coveragePercent(latest), recordsByStatus(latest), failedMarkets(observations)
buildRunLog({ observations, latest, snapshot }), serialiseRunLog(log)
describeChanges(previous, next): string[]      // what a build would change, for a dry run
formatSummary({ heading, marketScope, figures, reports }): string
```

```ts
// packages/price-index/src/schema — E11.6-08
coverageReportFileSchema, CoverageReportFile, coverageReportKeys, coverageReportKinds
coverageReportDirectory, coverageReportNamePattern, reportSettingsSchema
```

```ts
// packages/price-index/src/reports — the tool only (E11.6-08)
buildCoverageReport({ kind, observations, latest, overrides, catalogue, markets, spotChecks }): CoverageReportFile
renderCoverageMarkdown(report): string      // from the report object only
serialiseCoverageReport(report): string     // keys in schema order, in Prettier's JSON layout
coverageReportBaseName(report)              // coverage-YYYY-MM-DD, from built_at
spotCheckSeed(runId), sampleRecords(records, seed, count), coverageShare(publishable, records)
cellCodes, cellCode(cell), markdownText(text), missingReasonOrder
```

```ts
// packages/price-index/src/storage — E11.6-08
serialiseManualOverrides(file), writeManualOverrides(path, file, { fs? })   // validated, atomic
```

```ts
// packages/price-index/src/cli — the tool only (E11.6-07)
runCli(argv, { root, stdout, stderr, clock?, scrape?, prompt? }): Promise<number>   // the exit code
Prompt { ask(question): Promise<string | null>; close() }, linePrompt(input, write)    // E11.6-08
writeCoverageReport(root, input): Promise<string[]>                                    // E11.6-08
officialHost(service), sourceUrlProblem(url, service)                                  // E11.6-08
ScrapeEnvironment { origin?, openBrowser?, clock?, random?, signal? }      // injected by tests only
validateDataFiles(root): ConfigIssue[]
```

```ts
// packages/price-index/src/schema — E11.6-09 (site-importable)
changesFileSchema, changeEntrySchema, changeEntryKeys, changesFile, changePercentPattern
monthlyReportFileSchema, monthlyChangeSchema, monthlyPlanSchema, monthlyReportKeys
monthlyDataDirectory, monthlyReportDirectory, monthPattern
```

```ts
// packages/price-index/src/pipeline — the tool only (E11.6-09)
lastPublishedRecords(next, history): Promise<Map<identity, PriceRecord>>   // history: newest first
detectChanges({ next, baselines, logged }): ChangeEntry[]                   // pure, identity order
changePercent(oldMinor, newMinor): string, observationDate(record, builtAt), compareChangeSize(a, b)
```

```ts
// packages/price-index/src/storage — E11.6-09
PriceStore.readSnapshot(ref): Promise<SnapshotFile>
readChanges(path), appendChanges(path, entries, { fs? }), serialiseChanges(file)
```

```ts
// packages/price-index/src/reports — the tool only (E11.6-09)
buildMonthlyReport({ month, snapshot, changes, catalogue, markets }): MonthlyReportFile
serialiseMonthlyReport(report): string
crossCheckPriceMoves({ month, runs, changes, catalogue, markets }): CrossCheck   // Markdown only
renderMonthlyMarkdown(report, { catalogue, markets }, crossCheck): string
runFigures(observations, latest, changed), buildRunLog({ observations, latest, snapshot, changed })
```

```
npm run price-index -- validate
npm run price-index -- scrape [--market <code>] [--resume <run_id>]
npm run price-index -- scrape --dry-run [--from-fixtures] [--market <code>]
npm run price-index -- review approve|reject --market <code> --service <service_id> --plan <plan_id> --actor <name>
npm run price-index -- build-data
npm run price-index -- monthly-report --month YYYY-MM
npm run price-index -- report
npm run price-index -- override add|not-offered|retire
```

Exit codes (E11.6-07): `0` done, `1` a usage error or a request refused before anything was written, `2` stopped by the source, `3` validation failure, `4` interrupted.

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
- **`override add` is stricter than `parseMoney` (D-031 Q2).** The rule above stays for the source's text, and `src/money/` is unchanged; the override command refuses a hand-typed price whose only separator is a `.` or `,` before exactly three digits, which `parseMoney` would read as thousands.
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
  - **The rule runs at two layers, and a request leaves only if both allow it.** Playwright's context routing lets some requests through without asking: one whose frame it does not yet know (an iframe's first navigation) and every later hop of a redirect. So the run's tab also has its own DevTools session with request interception on (`Fetch.enable`), which holds every request of the tab, those included, until `classifyRequest` decides. The browser test plants iframes, a late link prefetch and a beacon to prove it; with Playwright's routing alone they reached the fake server.
  - As a third line, the browser is launched with `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE <source host>`, so no other host name even resolves inside it. A page that ends up off the source is rejected and never stored.
  - A worker cannot start: its script is an unlisted resource type, so the rule refuses it.
- **No conditional requests** (founder decision 2 of 2026-11-18). The fetcher sends no `If-None-Match` or `If-Modified-Since` and keeps no `ETag` or `Last-Modified` state. With request routing on, Playwright loads every request without the browser cache, which the browser test checks for a page and its assets loaded twice.
- **Robots.** `robots.txt` is the run's first load, read as sent and stored in the raw store. Only the `*` group applies (RFC 9309 longest match, an Allow winning a tie, `*` and `$` patterns). A `404`, `410` or other 4xx answer apart from `403` and `429` means no rules; `/api/` and `/go/` are refused regardless. A resumed run keeps the robots.txt it started with.
- **Host allowlist.** `source_origin` can only be `https://www.youfundceo.com`. A page on another origin, or on a path robots.txt disallows, is refused before a page is opened, and costs no delay.
- **Delays.** Before every load but the session's first, the fetcher waits a jitter drawn uniformly from `jitter_seconds` with the injected seeded source, or the `*` group's `Crawl-delay` when that is longer.
- **Failures and backoff.** A load fails when it answers `403`, `429` or `5xx`, times out (`page_timeout_seconds`), errors in the browser (a refused redirect included), or **still shows the bot checkpoint after `checkpoint_wait_seconds`**. The checkpoint is a `403` or `429`, `x-vercel-mitigated: challenge`, or the title "Vercel Security Checkpoint"; the fetcher waits for it to complete on its own and never interacts with it. After the n-th consecutive failure the same page is retried after `initial_seconds × multiplier^(n−1)`, capped at `max_seconds`, or after `Retry-After` (seconds or an HTTP date) when longer. A `Retry-After` beyond `retry_after_max_seconds` stops the run instead. **`max_consecutive_failures` failures in a row stop the run cleanly**, as `stopped_by_source` with exit code `2` in the report. A `404` or `410` is `not_found`, another 4xx is `http_error`; neither is a failure, and a success resets the count.
- **Checkpoints and resume.** Work is grouped into units (a market). When a unit's work finishes, `checkpoint.json` is replaced atomically with the completed units. A run that stops or is interrupted (`signal`, reported as `interrupted`, exit code `4`) leaves the checkpoint; `resumeRunId` reopens that run, skips every checkpointed unit without a request and refetches the unit that was in progress. A checkpoint of another run or origin is refused.
- **Raw store and rotation.** Each loaded page is written atomically to `data/raw/<run_id>/pages/<name>.html` (its path with `/` as `__`, the home page as `home`, a query after `__q-`). When a run starts, the oldest run directories are deleted so that `raw_runs_kept` remain, the current run always among them; nothing that is not named like a run is touched.

**The source adapter (E11.6-05).** Everything below is tested on the founder's capture (`packages/price-index/test/fixtures/youfundceo/`); no test and no agent session requests the source (epic rule 2).

- **The interface.** A `SourceAdapter` decides which pages a run needs and reads them; it never fetches and never writes a file. `requests` is asked again after each batch of pages, because a page can depend on an earlier one (a country's slug comes from `/countries`). An empty answer means the unit is complete. A later `direct:<provider>` adapter implements the same four members, so the pipeline does not change.
- **The minimum request set** (`docs/features/price-index-source-findings.md#the-minimum-request-set-for-a-monthly-run`). The `index` unit asks for `/countries`, `/services` and `/price-moves`. Each enabled market's unit then asks for its country page, and then **for a country × service page only for a tracked service the country page prices**. That excludes a service in "No price shown", a service the country does not list, a service the source does not list, a source service no alias matches, and every disabled market. A tracked service is one whose `source_aliases.service` matches a `/services` entry. With the committed config that is 3 + 20 + 129 pages, plus `robots.txt` from the fetcher. With an Adobe alias it would be the findings' 148 country × service pages.
- **The extraction sources** are those the findings chose:
  - **`/countries` and `/services`:** their HTML links (`a.prow` with its `.prow-title`, and `a[href="/services/<slug>"]` with its first paragraph). A market resolves to the one country whose name (after `normaliseAlias`) or slug equals its own.
  - **A country page:** the `li[data-name] > a.prow[href]` entries. Those inside `section[aria-labelledby="unavailable"]` are "No price shown", each with its `.prow-sub` label. The priced entries must equal the JSON-LD `ItemList` in count, URLs and order, and the `ItemList` must name the page itself. Prices are not read here, and "What you get in <country>" is ignored.
  - **A country × service page:** the rows of `section[aria-labelledby="plans"]`, as shown on the page and as the embedded React Server Components payload holds them, matched one-to-one by order and `data-name`:
    - the payload gives each row's `"<plan>-<month|year>"` key, `official.amount`, `official.currency`, `official.yearly` (which must agree with the key) and `usd`;
    - the row's `.prow-sub` text, without its ` / mo` suffix, is `price_source_text` (`kr 169`, `$19.99 + tax`), and it must parse with `parseMoney` to exactly the embedded amount;
    - the JSON-LD `Dataset` must name the page (`url`) and its market (`spatialCoverage.identifier`, when present), and its `dateModified` is `source_verified_at`.
  - **"Price moves":** the payload's one `rows` prop, every row checked field by field.
- **Exactness.** The payload is read by a JSON tokenizer of the package's own (`src/sources/youfundceo/flight.ts`) that keeps every number as its source text. Amounts then go through `parseDecimal`, so no price ever passes through a float. The tokenizer follows row references (`"$L3f"`), because a row can be split across payload rows, and reads text rows by their UTF-8 byte length. A USD figure with more than two decimals (a float artefact) fails its page, because nothing is rounded.
- **Statuses.** Each enabled market × catalogue plan gets exactly one observation or one gap:
  - **an observation:** a row matched to the plan, in the plan's own billing period;
  - **`not_on_source`:** the source does not list the service (`/services`), does not list the country (`/countries`), or does not list the service in that country (the country page), or the service's page has no row for the plan (Netflix Basic in the United States). It is expected, not an error;
  - **`source_no_price`:** the service is under "No price shown", for each of its plans. The source's label ("Not verified yet" or "Not available here") is kept in the gap's `note`. It never becomes `not_offered`, which only the founder records (epic rule 6);
  - **`parse_failed`:** a page needed for the plan could not be read. The page's failure is listed with its URL, its market and why. The run's other pages still parse;
  - **`market_failed`:** a page needed for the plan was not fetched, or did not load.

  A broken index page gives every plan in every market its reason. A broken country page affects only that market, and a broken country × service page only that service there. **A changed page never yields zero records silently.**
- **Matching** is through `source_aliases` only, after `normaliseAlias`:
  - a service by its `/services` name or slug;
  - a plan row by its displayed name or its key without the period.

  A row that matches a plan in another billing period is untracked, not observed. Two rows for one plan, one row for two plans, or a service whose aliases match two source services (or a source service two catalogue services claim) fail as `parse_failed`. Every source service and plan row that matches nothing is listed as **untracked on source**, with a fuzzy **suggestion**:
  - the catalogue entry most like it, scoring at least `suggestionThreshold` (0.6);
  - one name's words all among the other's score at least 0.75, and otherwise the score is the Dice similarity of their letters;
  - a tie goes to the earlier entry.

  **A suggestion is never applied and never written**: the adapter imports no file system call, and the catalogue it is given is left unchanged.
- **"Price moves" are kept as their own list** for E11.6-09's cross-check, with the catalogue's `service_id` and `plan_id` when the source's slugs match an alias, else `null`. They never alter an observation. If the page cannot be read, `priceMoves` is `null` and the failure is listed.

**The merge (E11.6-06, founder decisions D-028 of 2026-11-18).** `mergePriceIndex` validates every input against its schema, then decides each record in this order. Every case below is a named test in `test/price-index/merge-status-rules.test.ts`.

- **Coverage.** `latest.json` holds exactly one record per enabled market × catalogue plan, in the plan's billing period (Q3 d). Observations, gaps, manual entries and decisions for a disabled market or a plan no longer in the catalogue produce no record and are left in their files. An observation or manual entry for a tracked plan in another billing period, an override in another currency than its enabled market's, a second observation, gap or manual entry for one record, or both an observation and a gap, stops the merge with a `MergeError`, so nothing is built from it.
- **The scraped side.** An observation is this run's value. A gap with `source_no_price` or `not_on_source` means the source prices nothing; where the previous record held a scraped value (or was itself a disappearance), the plan has **disappeared**. A gap with `parse_failed` or `market_failed`, or no observation and no gap at all, is a **failed page**: the previous scraped value is kept with its old `observed_at`, source and USD figure, and a note says why, so it goes stale on schedule (Q3 c).
- **The checks.** A scraped value in another currency than the market's, or not above zero, is `needs_review` with the broken rule in `notes`, and no decision can publish it (Q3 a). If a manual entry exists it fills the gap instead, and a note records the value set aside.
- **Precedence.** With a manual entry and a valid scraped value:
  - the scraper agreeing with a price override (same `price_local` and currency) is `ok` from the scraper, and `retirableOverrides` lists the override. If the value is more than the threshold from the baseline, or the previous record was `needs_review` or `conflict`, it is `needs_review` until approved;
  - a disagreeing override, or a scraped price against a `not_offered` entry, is a **`conflict`**. The record shows the scraper's value, and `notes` names the manual entry's value or the `not_offered` entry with its URL. `approve` of the scraper's value makes it `ok`; `reject` lets the manual entry stand, an override passing the threshold check like any override (Q1); after a conflict carried from an earlier build there is no baseline, so the override then waits for its own approval.
- **The threshold (Q2).** The baseline is the previous record's value only when that record was `ok`, `manual_override` or `stale`. More than `change_threshold_percent` from it, up or down, is `needs_review`; exactly the threshold passes. The comparison is in integer minor units. A baseline in another currency cannot be measured, so the value needs an approval. After a `needs_review` or `conflict` record, a new scraped value is `needs_review` whatever it is, until its value is approved, and so is a scraped value agreeing with an override. An override is too, unless that record was a disappearance (no value shown): the last published value is no longer in the record, so a flagged override never publishes itself on a later build. Otherwise an override with no baseline, or within the threshold, is `manual_override`; one beyond it is `needs_review` (shown with source `manual`) until `review approve` of its value.
- **Disappearance.** A disappeared plan is `needs_review` with no price, and `notes` gives the last value and when it was observed. It stays open across builds and failed pages. A manual entry fills it. `approve` (a decision on no price) makes it `missing` with the gap's reason. A value that comes back is a new scraped value after a `needs_review` record, so it waits for an approval.
- **Decisions.** A decision applies to the value a record would show: identity, `price_local`, `currency` and `source` all equal. The last matching entry in `approvals.json` counts. `reject` keeps a ±40% value or a disappearance `needs_review`; nothing restores an older value.
- **Staleness (Q3 b).** `ok` goes `stale` when more than `stale_after_days.scraped` days have passed since `observed_at` (a scraped record with no readable time is stale); `manual_override` and `not_offered` when more than `stale_after_days.manual` whole days have passed since `verified_at`. The value is kept. `needs_review`, `conflict` and `missing` never go stale.
- **Record fields.** A manual record has `source` `manual`, the entry's `source_url`, `observed_at` `null` and `source_verified_at` set to `verified_at`, and its `notes` start with the entry's `note`. A `missing` record from a gap carries the gap's page and the run's time; one from a failed page has no `observed_at`. Notes name no person.

**The publish gate (E11.6-06, epic rule 4).** `src/publish/` is the one gate, and it imports only `src/schema`.

- `isPublishable` passes a record only when its status is `ok` or `manual_override` and it carries a price above zero with its currency. Every `manual_override` the merge writes is approved in Q2's sense, so the status is the test.
- `publishedView` validates the file against `latestFileSchema` (an invalid file throws `PublishGateError` and publishes nothing) and returns the publishable records in file order **without `price_usd_source` or `notes`**, so no page can display the USD figure or the merge's working notes, which can name a value the gate refused (a scraped price set aside or rejected). `rankMarkets` returns the same view of each record.
- **The generation rule (E11.6-10).** `generatedPages` gives one page per catalogue service × enabled market with at least one publishable record for one of the service's catalogue plans, through `publishedView`, so a `not_offered`, `needs_review`, `conflict`, `stale` or `missing` plan never makes a page. Its records are in the catalogue's plan order; pages come in catalogue order, then markets order. No `latest.json` generates nothing. The site renders exactly these pages and lists them in its sitemap, and `build-data` appends their URLs to the ledger, so both read this one function.
- `rankMarkets` ranks one plan's publishable records that have a `price_usd_source`, most expensive first, comparing cents as integers. A record without a USD figure is published but never ranked, and M is the list's length. Equal figures share a rank (1, 1, 3) and are listed by market code.

**Review (E11.6-06, E11.6-07).** `price-index review approve|reject` takes exactly `--market`, `--service`, `--plan` and `--actor`, each once. It refuses, writing nothing and exiting `1`: a missing or blank `--actor` (checked before any file is read), any other flag, an unknown or disabled market, an unknown service or plan, a missing record, a record that is not `needs_review` or `conflict`, and a value that breaks the currency or price check. **It reads the record from the preview merge of the latest run** (D-028 Q4, built in E11.6-07): the merge of the newest run's `observations.json` with the current `latest.json`, overrides and decisions, which is what `build-data` would write now. With no run in the raw store at all, it reads `latest.json` (and refuses when there is none). A newest run without observations is refused until it is resumed. It appends one entry with the record's `price_local`, `currency` and `source`, the actor and the clock's time; an invalid configuration or data file, or a merge that refuses its inputs, exits `3`. `approvals.json` and its schema are unchanged.

**The scrape run (E11.6-07).** Every command runs to completion and exits; nothing calls `process.exit`, so a handle left open would keep the process alive, and `test/price-index/cli-exit.test.ts` runs each command as a child process to prove none is.

- **`scrape`** checks the configuration and the data files first (exit `3`), then opens one browser and one fetch session (E11.6-04). It runs the source adapter's units in order: for each, it asks `requests` for the pages the unit needs, loads them one at a time, and asks again until the answer is empty (at most 10 rounds). The adapter's absolute URLs are its keys; the fetcher loads their path from its own origin. A unit a resumed run already checkpointed is read back from the raw store instead, so the units after it can be planned. Then it parses the pages (E11.6-05) and writes `observations.json`, with `observed_at` the run's start (from its id) and `pages_fetched` the source pages it holds as loaded, robots.txt aside. It merges them into the current data exactly as `build-data` would (E11.6-06) and writes `preview.json`. **It never writes under `data/price-index/`.** A run stopped by the source (exit `2`) or interrupted by SIGINT or SIGTERM (exit `4`) still writes both, so a partial run can be built or resumed. The browser is closed whatever happens. Playwright's own signal handlers are off, so a signal stops the run cleanly after the page in progress.
- **`--market <code>`** reads only that enabled market: its units are the index and that market's, and its observations and gaps cover only it. A build of it keeps every other market's previous values, and the run log's `market_scope` says so; those markets are not "failed".
- **`--resume <run_id>`** reopens a stopped, interrupted or killed run, fetches only the units its checkpoint lacks, and rewrites its observations and preview.
- **`--dry-run`** fetches nothing and writes nothing at all: no browser is opened, nothing is created under `data/raw/`, and `data/price-index/` may be read-only. It replays the newest raw run, page by page from its stored copies (a page of a checkpointed unit with no stored copy did not load; one of an unfinished unit was not fetched), or with `--from-fixtures` the founder's captured pages (`packages/price-index/test/fixtures/youfundceo/pages/`). It prints each record whose status, value, currency, source or missing reason a build would change, and the summary.
- **`build-data`** validates the configuration and every data file, then merges the newest run's observations (a newest run without observations is refused, exit `1`, until resumed). Only when every input and the result validate does it write, in this order: the build's real price changes appended to `changes.json` (E11.6-09), the URL of every page the new `latest.json` generates for the first time appended to `published-urls.json` (E11.6-10; before `latest.json`, so a page is in the ledger before it can be served), `latest.json` (atomically), a new snapshot dated by `built_at`, `reports/runs/<run_id>.json`, and the final coverage report (E11.6-08). A build that fails validation writes nothing (exit `3`). A partial run builds: its failed markets keep their previous values, and the run log names them.
- **The figures** are computed from the run's observations and the merged index only: fetched (`pages_fetched`), matched (observations), unmatched ("untracked on source" entries), records by status, failed markets (markets with a `parse_failed` or `market_failed` record this run, with how many) and changed (the real price changes the build appends to `changes.json`; `scrape` and its dry run count the changes a build would append, and write none). **Coverage** is the publish gate's records (`ok` and approved `manual_override`) as a share of all records, floored to one decimal.
- **The console summary** of `scrape`, `scrape --dry-run` and `build-data` prints the coverage %, every count, the failed markets and the path of each file written.
- **`validate`** checks every data file too: `latest.json` and each snapshot against their schema, `manual-overrides.json`, `approvals.json`, `changes.json` and `published-urls.json` (all four required; E11.6-10 checks the ledger against the configuration as well: **a published slug never changes**, so a ledger URL whose service and market are still configured must still be the path they give, and a renamed slug is refused), each monthly report under `data/price-index/monthly/` (named `YYYY-MM.json`, with that `month`; E11.6-09), each run log, whose name must be its `run_id`, and each coverage report's JSON under `reports/` (E11.6-08), whose `built_at` must fall on its file's date. A temporary file a crashed write left in `snapshots/` is ignored. Files are read one at a time.

**The coverage report (E11.6-08).** `buildCoverageReport` builds one object from a merged index (a preview, or the build's `latest.json`), the run's observations, `manual-overrides.json` and the configuration; the JSON file is that object and the Markdown is rendered from it alone, so the two carry the same figures (`test/price-index/coverage-report.test.ts` reads every figure back out of the Markdown).

- **Who writes it.** `scrape` writes the preview of its run beside the raw store's preview (not on a dry run, and not when the preview merge is refused). `build-data` writes the final report after the run log. `report` (no flags) writes the preview of the newest run merged with the data as it now stands, exactly the merge `review` reads; it refuses (exit `1`) with no run, or a newest run without observations, and exits `3` when a file or the merge is refused. None of them writes under `data/price-index/` for the report.
- **The matrix** has exactly one cell for every enabled market × catalogue plan, in `config/markets.json`'s market order and the catalogue's service and plan ids in code-unit order; a disabled market or a removed plan has none. A cell without a record in the index is a broken index and throws, never a silent gap. In the Markdown a cell is a short code (`ok`, `mo`, `nr`, `cf`, `st`, `no`, `m-nos`, `m-snp`, `m-pf`, `m-mf`) with a legend.
- **Coverage** is publishable records (the publish gate) as a share of all, floored to one decimal, overall (equal to the run log's `coverage_percent`), per market and per service.
- **Missing** combinations form one group per service and reason, `not_on_source` groups first, then `source_no_price`, `parse_failed` and `market_failed`; each names the service's official site and each market's currency.
- **Flagged** lists every `needs_review`, then `conflict`, then `stale` record, with the value it shows and the founder's manual entry for it, so a conflict shows both values; and its `notes`.
- **Retirable overrides** are `retirableOverrides` (E11.6-06). **Unranked** are the publishable records with no `price_usd_source`. **Untracked** is the run's "untracked on source" list, each with its suggestion, never applied.
- **Spot checks.** `reports.spot_checks` `ok` records, drawn without replacement by a partial Fisher–Yates shuffle over the `ok` records in identity order, from `seededRandom(spotCheckSeed(run_id))`: FNV-1a over the run id. The same run id always draws the same records, whatever order the index lists them in; fewer `ok` records than asked for are all listed. Each carries its value, its source text and page, and the service's official URL.
- **Format.** The JSON has the schema's key order, two-space indentation, a list of plain values on one line when it fits 80 columns, and a trailing newline: what Prettier writes. The Markdown pads its tables as Prettier does and escapes every Markdown character in free text (notes, the source's names), so both pass `npm run format`.

**Manual entries (E11.6-08).** `override add`, `override not-offered` and `override retire` ask one question per line, on standard input (piped answers are buffered, so a script can send them at once); the end of the input before the last answer is a refusal. They read `manual-overrides.json` first (an invalid file exits `3`), and the first refused answer stops the command with nothing written (exit `1`):

- **the target:** a market code (any case) that is in `config/markets.json` and enabled; a `service_id` and `plan_id` in the catalogue; the billing period, which must be the plan's (an empty answer takes it);
- **`add`:** the local price is read by `parseMoney` in the answered currency (an empty answer takes the market's), which must be the market's; a price that does not parse exactly, or is not above zero, is refused, and so is a price whose only separator is a `.` or `,` followed by exactly three digits (`149.999`, `149,999`), with a request for the price without a thousands separator (`1299` or `1 299`); a space, a no-break space, an apostrophe or two separators (`1.299,00`) still read (D-031 Q2). An optional USD figure is read by `parseDecimal` with two decimals at most;
- **`add` and `not-offered`:** `source_url` must be an https URL whose host is exactly the host of the service's catalogue `website_url` (`www.spotify.com` for Spotify) or one of its `official_hosts` (`help.netflix.com` for Netflix); another subdomain, even of a listed host, or a look-alike is refused, and the reports' official URL stays `website_url` (D-031 Q1); `verified_at` a real `YYYY-MM-DD` no later than the clock's day (an empty answer takes today); `verified_by` non-empty; the note optional;
- a second entry for the same market, service, plan and billing period is refused (retire the first); `retire` refuses when there is none.

The entry is checked against `manualEntrySchema`, the whole file against `manualOverridesFileSchema`, and only then written atomically. The merge reads it on the next `scrape` preview, `report`, `review` or `build-data`.

**The isolation proof (E11.6-07, epic rule 1).** `test/price-index/isolation-proof.test.ts` scans the site's build output for every distinctive string literal (16 printable characters or more, with a space) of the tool's `src/http`, `src/sources`, `src/cli` and `src/reports`, and for those directories' paths. A planted output is its red path. It also copies the repository without the tool (everything in `packages/price-index/` but `src/publish` and `src/schema`, and `config/price-index.json`), builds it with `npm run build`, and serves `/` from it. That the tool's failure modes alter no file the site reads is asserted on each failure mode, over every file under `data/price-index/` and `config/`.

**Append-only `approvals.json` (E11.6-06, epic rule 7).** `scripts/ci/price-index-append-only.mjs`, run by `npm run security`, compares the working tree with the merge base of the pull request's base (`SECURITY_BASE_SHA`) and HEAD, or with HEAD when no base is given. Every entry at that revision must still be there, at the same position and with the same JSON value, so only additions at the end pass; a deleted or unreadable file fails, and a base that cannot be resolved fails closed. `test/price-index/approvals-append-only.test.mjs` plants an edit, a removal and a reorder (`test/fixtures/price-index/approvals/`) in a real git repository as the red path.

**Append-only `changes.json` (E11.6-09, epic rule 7).** The same check covers `data/price-index/changes.json`, its `changes` list compared entry by entry in the same way. `test/price-index/changes-append-only.test.mjs` plants an edit, a removal and a reorder (`test/fixtures/price-index/changes/`) in a real git repository as the red path.

**Append-only `published-urls.json` (E11.6-10, epic rule 7).** The same check covers the published-URL ledger, its `urls` list compared entry by entry. `test/price-index/published-urls-append-only.test.mjs` plants an edit, a removal and a reorder (`test/fixtures/price-index/published-urls/`) in a real git repository as the red path.

**The change log (E11.6-09).** A real change is a published value replaced by a different published value for the same record and currency.
- **What is compared.** Every record the new `latest.json` publishes (`isPublishable()`) is compared with the value its identity last published: `lastPublishedRecords` looks in the previous `latest.json`, then in the snapshots newest first, one file at a time, and stops as soon as every published identity has a baseline. A record that waited as `needs_review`, `stale` or `missing` in between is therefore compared with the last value the pages showed.
- **What is not a change.** A first observation (no baseline); a status change, including ok → stale → ok and a scraped value taken over by an equal manual entry (equal minor units); a formatting difference (`price_source_text` is never compared); a value in another currency than its baseline; an unapproved `needs_review` or a `conflict` value (not published).
- **Approved `needs_review`.** The value is logged by the build that first publishes it, dated by its observation: `observed_at`'s date for a scraped value, `source_verified_at` (the founder's verification date) for a manual entry, which has no `observed_at`. A decision recorded before `build-data` (the monthly routine) and one recorded after a build that left the record flagged give the same entry.
- **Once.** An entry identical to one already in the log (identity, both prices, currency, `detected_on`) is not appended again. `build-data` appends before it writes `latest.json`, so a build cut short after the append rebuilds to entries the log already holds.
- **`change_percent`** is `(new − old) / old` in exact minor units, as text with one decimal, rounded half away from zero; a fall keeps its `-`.

**The monthly report (E11.6-09).** `price-index monthly-report --month YYYY-MM` takes exactly that flag (exit `1` otherwise). It validates the configuration and every data file (exit `3`), and refuses (exit `1`) a month with no snapshot, since there are no published prices to report. A refusal writes nothing.
- **Inputs.** The month's last snapshot (by date, then suffix) and `changes.json`. Every figure passes the publish gate: a record counts only if `isPublishable()` passes it in that snapshot, for an enabled market and a catalogue plan, and a change of the month counts only while its record does.
- **Changes**: every counted change dated that month, largest percentage first by size (rises and falls together), compared exactly; ties in identity order.
- **Extremes**: per plan, `rankMarkets()` over the snapshot, restricted to enabled markets. The most expensive is rank 1; the least expensive is the first market (by code) of the last rank. Both are shown as local prices. A plan with fewer than two ranked markets has none, and the Markdown says how many such plans there are.
- **Spread**: the most expensive market's `price_usd_source` over the least expensive's, as one-decimal text, rounded half up. The USD figures themselves are never written.
- **Counts**: per plan, `published_markets` is the enabled markets where it is published; a market rose (fell) when its month of changes, in log order, ends above (below) where it began.
- **The cross-check (Markdown only).** The runs whose run logs name a snapshot of the month are read from the raw store (`observations.json`'s `price_moves`); a run the store no longer holds is named, and with none the section says the check could not run. A broken `observations.json` is refused (exit `3`) rather than read as "no moves". A move is comparable when it has the catalogue's ids, an enabled market and a known period (`m` month, `y` year). It agrees with a change when market, service, plan, billing period, currency and both prices are equal; dates may differ. The section lists the comparable moves dated that month that agree with no entry of the whole log, and the month's log entries (the gated ones included) that agree with no move read. The section is marked for the founder only. It never reaches the JSON, and it changes no value.
- **Copy.** Every sentence is a template in `packages/price-index/copy/monthly-report.ts`, which the forbidden-copy scan covers. Prices are written as `149.00 SEK`; no sentence names the data source.
- **Output.** Both files are written atomically and replace an earlier report of the same month. The JSON is in Prettier's layout; the Markdown is in Prettier's Markdown format. A month with no changes says so plainly ("No list price we track changed in …").

**Installing Chromium, once.** The fetcher drives the Chromium build that matches the installed `playwright` (1.62.1). On the machine that runs the tool, install it once with `npx playwright install --with-deps chromium`. Alternatively, run the tool inside the repository's pinned Playwright image (`mcr.microsoft.com/playwright:v1.62.1-noble`), which already carries Chromium and its system libraries, as the P9 capture did (`docs/prerequisites/p9-source-capture.md`). The monthly routine itself is E11.6-15's runbook.

## Dependencies
`zod` 4.6.7 (MIT), a direct runtime dependency at the version Astro already installs. `playwright` 1.62.1 (Apache-2.0), already a dev dependency, drives the fetcher's Chromium (E11.6-04); the tool never ships in the image, so it stays a dev dependency. `htmlparser2` 10.1.0 (MIT), a direct dev dependency since E11.6-05 at the version already installed through `mailparser`, reads the source's HTML; it adds no code to the tree. Nothing in the package reaches the site's browser.

## Contract tests
`test/price-index/config-schema.test.ts`: an accept and a reject case for every field rule (`official_hosts` included), and the alias collisions · `test/price-index/config-seed.test.ts`: the seed is exactly the founder's markets, catalogue, official hosts and confirmed aliases · `test/price-index/config-changes.test.ts`: adding and removing a service, a plan and a market passes `validate` · `test/price-index/check-gate.test.mjs`: `npm run check` fails on a planted invalid file · `test/price-index/isolation-scan.test.mjs`: the isolation scan's red paths and green paths, with the wired red path in `test/fixtures/security/gates.json` · `test/price-index/money-parse.test.ts`: a format table for every market currency and every captured currency, each with every thousands separator; ambiguity, currency and malformed-text refusals; number inputs refused; every price on the 38 captured country pages read against its embedded value (E11.6-03) · `test/price-index/money-format.test.ts`: round-trip formatting, decimal strings and minor-unit arithmetic · `test/price-index/price-record-schema.test.ts`: the record's field and cross-field rules, the `fx` and converted-price rejections, and the latest and snapshot files · `test/price-index/price-store.test.ts`: source-text round trip, byte-stable serialisation passing Prettier, an injected failure and a killed process before the rename, snapshot immutability under a race, and snapshot listing · `test/price-index/float-scan.test.mjs`: the float scan's red and green paths · `test/price-index/fetcher-browser.test.ts` (E11.6-04): in real Chromium against a local fake server, at most one page-level request in flight over every browser request under a queue of 50; prefetches, images, fonts, media, frames, `/api/` and a second host refused in the browser and never reaching either server; no headless marker and `navigator.webdriver` hidden; no conditional request; a checkpoint that clears through a same-host script and fetch, and one that never clears stopping the run and resuming; page timeouts; redirects · `test/price-index/fetcher.test.ts`: with a fake driver, injected clock and seeded source, the delay against the jitter floor and `Crawl-delay`, the backoff sequence and its cap, `Retry-After`, every failure kind, the stop and its checkpoint, resume, refusal before a page opens, one page at a time and interruption · `test/price-index/request-rule.test.ts`: every allowed and refused request kind · `test/price-index/robots.test.ts`: the `*` group, longest match and `Crawl-delay`, on the captured robots.txt and planted files · `test/price-index/raw-store.test.ts`: rotation keeps exactly the configured number of runs, run ids and the checkpoint · `test/price-index/fetcher-settings.test.ts`: the committed settings and every rejected value · `test/price-index/evasion-scan.test.mjs`: the evasion scan's red and green paths · `test/price-index/source-youfundceo-pages.test.ts` (E11.6-05): every captured page read to its hand-written expectations, in both the rendered and the server copy (the twelve country × service plan tables, the 38 country pages against their JSON-LD, Sweden's "No price shown" list, both indexes, all 205 price moves), and every planted structural change refused · `test/price-index/source-youfundceo-plan.test.ts`: the request plan over a fixture catalogue, unit by unit and for all 20 markets (129 country × service pages, 148 with an Adobe alias), never for an unpriced service or a disabled market, and following a catalogue addition or removal · `test/price-index/source-youfundceo-parse.test.ts`: the hand-written observations, `not_on_source` and `source_no_price` in every enabled market, a restructured page failing as `parse_failed` while the others parse, alias addition and removal, suggestions never applied, and price moves never altering an observation · `test/price-index/source-flight.test.ts`: the embedded-data reader keeps numbers as text, reads text rows by byte length and refuses malformed payloads · `test/price-index/source-matching.test.ts`: alias matching and suggestions · `test/price-index/merge-status-rules.test.ts` (E11.6-06): every status rule as a named case with explicit inputs and an injected clock: precedence and retirable overrides, `not_offered` and its conflicts, approve and reject on a conflict, a ±40% flag and a disappearance, the threshold's edges and setting, the after-flag rule, overrides within and beyond 40%, the currency, price and billing-period checks, staleness at 45 and 90 days, failed pages, and refused inputs · `test/price-index/merge-catalogue-changes.test.ts`: one record per enabled market × plan, and a service, plan and market added, removed and disabled, with snapshots left byte-identical · `test/price-index/publish-gate-property.test.ts`: the seeded property test over generated merges, with an independent oracle for approved `manual_override` and published `ok` records, against the gate, the view and the ranking · `test/price-index/publish.test.ts`: the gate per status, the view without USD figures or notes, ranking, ties and unranked records, and the import boundary · `test/price-index/review-cli.test.ts`: decisions bound to the shown value, every refusal leaving `approvals.json` byte-identical, and a recorded decision applied by the next merge · `test/price-index/data-files-schema.test.ts`: the override, approvals and merge-settings schemas, and the committed seeds · `test/price-index/approvals-append-only.test.mjs`: the append-only check, its red paths in a git repository and its wiring · `test/price-index/scrape-run.test.ts` (E11.6-07): with a fake driver answering from the captured pages, `scrape` writing the hand-written observations and the preview and leaving `latest.json` untouched; `build-data` writing latest.json, a snapshot and the run log; a run stopped by the source leaving the site data byte-identical and building as a partial run with its failed market named; resume; `--market`; an interrupted run; a build failing validation writing nothing; a killed run refused by `build-data` and `review`; every refusal; `review` on the preview · `test/price-index/scrape-dry-run.test.ts`: a dry run with a transport that throws on any request and a read-only `data/price-index/`, from the raw store and from the fixtures, changing no file · `test/price-index/cli-exit.test.ts`: every command as a child process, ending on its own with its exit code; `scrape` in real Chromium against a fake source; stopped (2), killed mid-market (then resumed) and interrupted (4) runs leaving the site data byte-identical · `test/price-index/isolation-proof.test.ts`: the build-output scan and its red path, and the site built and served without the tool · `test/price-index/run-log.test.ts`: coverage, failed markets, the counts, `describeChanges`, the run log's determinism and Prettier format, and the summary · `test/price-index/validate-data.test.ts`: `validate` on every data file and each planted invalid one · `test/price-index/coverage-report.test.ts` (E11.6-08): matrix completeness over a fixture catalogue with a disabled market, a removed plan and an added and removed service (through the merge); coverage overall, per market and per service; missing groups with `not_on_source` first; flags with both values of a conflict; retirable and unranked records; untracked suggestions never applied; no USD figure; JSON–Markdown parity read back from the Markdown, with its red path; spot-check reproducibility (a pinned seed and sample, record order, another run id) and the settings key; both files byte-stable and in Prettier's format · `test/price-index/override-cli.test.ts`: scripted `override add`, `not-offered` and `retire` (and piped input), each refusal leaving `manual-overrides.json` byte-identical (an ambiguous `149.999` or `149,999` among them), `1 299` and `1.299,00` accepted, and the official-host rule with a listed host accepted and an unlisted subdomain of it refused · `test/price-index/report-cli.test.ts`: the preview from `scrape`, the final report from `build-data`, `report` after an override, refusals, no report from a dry run, and `validate` of the reports · `test/price-index/cli-exit.test.ts` also runs `report`, `override` (with piped input) and `monthly-report` as child processes · `test/price-index/change-detection.test.ts` (E11.6-09): the exact `change_percent`; a real change with every field; a first observation, status changes, a formatting-only difference and a currency change logging nothing; a manual entry dated by its verification; an approved `needs_review` change logged once, dated by its observation, whether approved before or after a build; the history walk stopping early; the size order; `appendChanges` refusals; and `build-data` appending the changes and counting them in the run log, once, and refusing an invalid `changes.json` · `test/price-index/changes-append-only.test.mjs`: the append-only check on `changes.json` and its red paths in a git repository · `test/price-index/monthly-report.test.ts`: the hand-computed figures of a fixture month, the Markdown's sentences, no USD figure or converted price in either file, publish-gate exclusion (with the same records published as the control), both kinds of cross-check disagreement and the cross-check's absence from the JSON, the unavailable cross-check, the honest empty month, Prettier format and the templates against the forbidden-copy list · `test/price-index/monthly-report-cli.test.ts`: the files from the month's last snapshot, nothing else changed, a re-run byte-identical, an empty month, a broken and a lost raw run, and every refusal writing nothing · the forbidden-copy red path for `packages/price-index/copy/` is the `price-index-copy-forbidden` entry of `test/fixtures/security/gates.json` · `test/price-index/price-pages.test.ts` (E11.6-10): the generation rule over the price-page fixture dataset (`test/fixtures/price-index/pages/`: generated, skipped and ledger-unavailable cases), the site's view model (exact records, verification dates, no USD figure, unpublished value or source name), a service, plan and market added and removed at the page layer, invalid inputs publishing nothing, the ledger's entries, slug check and schema, `name_in_sentence`, and `build-data` appending to the ledger once and refusing an invalid one · `test/price-index/published-urls-append-only.test.mjs`: the append-only check on the ledger and its red paths in a git repository · `test/price-index/price-page-content.test.ts` (E11.6-11): the service × market page's content blocks over the same fixture dataset, against hand-written expectations: history present and absent, never for a plan the gate leaves off the page or in another currency; the rank sentence with excluded (conflict, missing) and unranked (no USD figure) markets, ties, a single ranked market and a disabled market; no USD figure in the view; related links to generated pages only; the FAQ and its FAQPage data, validated; the Valstara comparison like for like, by stated basis, with no entry, not below list, and for a yearly plan, with inexact and foreign prices refused; the flag's default; the copy rules · `test/price-pages-rendered.test.mjs` serves the same blocks from the built site: the number trace over every block, the no-USD assertion, history, the rank sentence and extremes, related links that answer 200, FAQPage presence and validation, and `prices.valstara_comparison` off and on.
