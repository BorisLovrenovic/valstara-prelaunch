# Module: price-index

Kind: a separate offline tool, outside the site. Implements ADR-033. The feature spec is `docs/features/price-index.md`; the source findings are `docs/features/price-index-source-findings.md`.

## Responsibility
Collect the official list prices of the services in `config/catalogue.json`, in every market in `config/markets.json`, once a month on the founder's command. Write them as committed JSON that the price pages build from. **The tool never runs inside the site, and the site never runs the tool.**

## Where it lives
`packages/price-index/`, a framework-agnostic TypeScript package run as `npm run price-index -- <command>` (`tsx packages/price-index/src/cli/main.ts`). It is not a server module: nothing under `src/` starts it, and it imports nothing from `src/` or Astro.

| Directory | Holds | Built by |
|---|---|---|
| `src/schema/` | Zod schemas for every config and data file, and the rules that span files | E11.6-02 (the three config files); later tickets add the data files |
| `src/cli/` | The `price-index` command | E11.6-02 (`validate`); later tickets add their commands |

The rest of the layout in `docs/features/price-index.md#repository-layout` arrives with the ticket that owns each part. A missing directory is correct until then.

## Data owned
The configuration, all hand-edited and committed:

| File | Holds |
|---|---|
| `config/markets.json` | `{ "markets": [...] }`. Each market: `code` (ISO 3166-1 alpha-2, upper case), `name`, `slug` (lower-case kebab-case, the permanent URL segment), `currency` (ISO 4217), `enabled`. Seeded with the 20 markets, all enabled (founder, 2026-11-17) |
| `config/catalogue.json` | `{ "services": [...] }`. Each service: `service_id` (lower-case kebab-case), `name`, `category` (`ai` · `streaming` · `music` · `productivity` · `learning` · `fitness`), `website_url` (https), `status` (`selling_now` · `launch` · `planned`), `plans[]` (at least one) and `source_aliases`. Each plan: `plan_id`, `name`, `billing_period` (`month` · `year`), `is_student`, `is_family` |
| `config/valstara-prices.json` | `{ "prices": [...] }`, seeded empty. Each entry: `service_id`, `plan_id`, `market` (a market code), `term_months` (a whole number ≥ 1), `price_local` (a positive exact decimal string, never a number) and `currency` |

**`source_aliases`** is `{ "service": [...], "plans": { "<plan_id>": [...] } }`: the names the source uses for the service and for each plan, used for matching and nothing else. Each list holds the source's display name and its slug or plan-row key, as recorded in the findings, e.g. `"Netflix"` and `"netflix"`, `"Premium Individual"` and `"individual"`. **A plan with no entry has no alias**, so no source row can match it and it stays `missing`. The seed carries only the five confirmed and four founder-confirmed mappings of the findings (D-019 Q4, option B). Adobe Creative Cloud is unmapped by founder decision, and the eleven products the source does not list have no aliases.

**Alias normalisation** (`normaliseAlias` in `src/schema/common.ts`) is the one implementation every comparison uses: Unicode compatibility decomposition, diacritics removed, lower case, and every run of punctuation or whitespace collapsed to one space. `"apple-tv-plus"` normalises to `"apple tv plus"`.

## Exposed interface
```ts
// packages/price-index/src/schema — one of the two entry points src/ may import
marketsFileSchema, catalogueFileSchema, valstaraPricesFileSchema   // one file each
configSetSchema                       // the three together, with the cross-file rules
configIssues(input): { config?, issues: { file, path, message }[] }
normaliseAlias(value): string
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

## Dependencies
`zod` 4.6.7 (MIT), a direct runtime dependency at the version Astro already installs. Nothing in the package reaches the browser.

## Contract tests
`test/price-index/config-schema.test.ts`: an accept and a reject case for every field rule, and the alias collisions · `test/price-index/config-seed.test.ts`: the seed is exactly the founder's markets, catalogue and confirmed aliases · `test/price-index/config-changes.test.ts`: adding and removing a service, a plan and a market passes `validate` · `test/price-index/check-gate.test.mjs`: `npm run check` fails on a planted invalid file · `test/price-index/isolation-scan.test.mjs`: the isolation scan's red paths and green paths, with the wired red path in `test/fixtures/security/gates.json`.
