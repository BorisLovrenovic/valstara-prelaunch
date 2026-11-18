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
| `src/cli/` | The `price-index` command | E11.6-02 (`validate`); later tickets add their commands |

The rest of the layout in `docs/features/price-index.md#repository-layout` arrives with the ticket that owns each part. A missing directory is correct until then.

## Data owned
The configuration, all hand-edited and committed:

| File | Holds |
|---|---|
| `config/markets.json` | `{ "markets": [...] }`. Each market: `code` (ISO 3166-1 alpha-2, upper case), `name`, `slug` (lower-case kebab-case, the permanent URL segment), `currency` (ISO 4217), `enabled`. Seeded with the 20 markets, all enabled (founder, 2026-11-17) |
| `config/catalogue.json` | `{ "services": [...] }`. Each service: `service_id` (lower-case kebab-case), `name`, `category` (`ai` · `streaming` · `music` · `productivity` · `learning` · `fitness`), `website_url` (https), `status` (`selling_now` · `launch` · `planned`), `plans[]` (at least one) and `source_aliases`. Each plan: `plan_id`, `name`, `billing_period` (`month` · `year`), `is_student`, `is_family` |
| `config/valstara-prices.json` | `{ "prices": [...] }`, seeded empty. Each entry: `service_id`, `plan_id`, `market` (a market code), `term_months` (a whole number ≥ 1), `price_local` (a positive exact decimal string, never a number) and `currency` |

The price data, written only through `PriceStore` (E11.6-03), and read by the pages at build time:

| File | Holds |
|---|---|
| `data/price-index/latest.json` | `{ "built_at", "records": [...] }`: `built_at` is the build's RFC 3339 UTC time, and `records` holds at most one price record per market × service × plan × billing period |
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

```
npm run price-index -- validate
```

Exit codes: `0` done, `1` usage error, `3` validation failure. E11.6-07 adds `2` (stopped by the source) and `4` (interrupted).

## Rules
- **`validate` rejects**, naming the file and the path:
  - a duplicate `service_id`, a duplicate `plan_id` within a service, a duplicate market code or a duplicate market slug;
  - an unknown category, status or billing period;
  - a currency not in the ISO 4217 table (`src/schema/iso4217.ts`: active codes of List One as at 2026-11-17, without fund codes, metals, the testing code or `XXX`);
  - a slug that is not lower-case kebab-case, or the `service_id` `countries`, which the market hub route `/prices/countries/{country}` reserves;
  - **an alias that maps to two different plans of a service, or to two services**, compared after normalisation, and an alias entry for an unknown plan;
  - a Valstara price for an unknown service, plan or market, in a currency other than the market's, or a second entry for the same service, plan, market and term;
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

## Dependencies
`zod` 4.6.7 (MIT), a direct runtime dependency at the version Astro already installs. Nothing in the package reaches the browser.

## Contract tests
`test/price-index/config-schema.test.ts`: an accept and a reject case for every field rule, and the alias collisions · `test/price-index/config-seed.test.ts`: the seed is exactly the founder's markets, catalogue and confirmed aliases · `test/price-index/config-changes.test.ts`: adding and removing a service, a plan and a market passes `validate` · `test/price-index/check-gate.test.mjs`: `npm run check` fails on a planted invalid file · `test/price-index/isolation-scan.test.mjs`: the isolation scan's red paths and green paths, with the wired red path in `test/fixtures/security/gates.json` · `test/price-index/money-parse.test.ts`: a format table for every market currency and every captured currency, each with every thousands separator; ambiguity, currency and malformed-text refusals; number inputs refused; every price on the 38 captured country pages read against its embedded value (E11.6-03) · `test/price-index/money-format.test.ts`: round-trip formatting, decimal strings and minor-unit arithmetic · `test/price-index/price-record-schema.test.ts`: the record's field and cross-field rules, the `fx` and converted-price rejections, and the latest and snapshot files · `test/price-index/price-store.test.ts`: source-text round trip, byte-stable serialisation passing Prettier, an injected failure and a killed process before the rename, snapshot immutability under a race, and snapshot listing · `test/price-index/float-scan.test.mjs`: the float scan's red and green paths.
