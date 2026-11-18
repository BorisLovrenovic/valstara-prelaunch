# ADR-033: The price index is a separate offline tool with JSON data in the repository

- Status: Accepted
- Date: 2026-11-17
- Deciders: founder

## Context

The price index (`docs/features/price-index.md`, Epic E11.6) records the official list prices of the subscriptions Valstara tracks, in every market it serves, once a month. It feeds the price pages on this site, the founder's monthly change report and, later, the storefront's "official price vs Valstara price" comparison.

Collecting the prices means fetching pages from a third-party source, through a headless browser, politely and slowly. That work can be blocked, crash, or return bad data. The site is a production system whose proposition is trust, so none of that can be allowed to reach it. The founder's requirement (2026-11-17) is that the tool runs only when the founder types the command, does its work, writes files and exits, and cannot affect the running site.

## Decision

**The price index is a separate, framework-agnostic TypeScript package, `packages/price-index/`, run by hand as `npm run price-index -- <command>`.** It is epic rule 1 of E11.6:

- **It runs to completion.** It has no daemon, timer, watcher, server, cron, scheduled workflow or automatic notification. It starts only on the founder's command and exits when its work is done. `npm run check` runs one command of it, `validate`, which reads the configuration files and changes nothing.
- **Nothing that develops, builds, starts or deploys the site starts it, imports it or copies it.** That covers the `dev`, `start`, `build` and `preview` scripts and their hooks, every Dockerfile, every Compose file, every CI workflow and any crontab.
- **Its data is JSON in the repository.** Configuration lives in `config/` (`markets.json`, `catalogue.json`, `valstara-prices.json`, and later `price-index.json`). The committed data lives in `data/price-index/`. New prices reach the site only through the ordinary path: a pull request, CI, merge and deploy. **The site reads only the committed `data/price-index/` files, and only at build time**, so nothing the tool does, fails at or leaves half-written can reach a running site.
- **The import boundary is one-way.** `src/` may import only `packages/price-index/src/publish` (the read-only published view) and `packages/price-index/src/schema` (the Zod schemas). The package imports nothing from `src/`, and nothing from Astro.
- **Storage and sources are interfaces, and they are the extension points.** The `PriceStore` interface (`src/storage/`) has one implementation, JSON files with atomic writes. The `SourceAdapter` interface (`src/sources/`) has one implementation, the first source. A database store, or a `direct:<provider>` source that reads providers' own pricing pages, plugs in later without changing the pipeline. **Neither is built now.**

**The isolation scan** (`scripts/ci/price-index-isolation.mjs`, run by `npm run security` and so by CI) enforces the boundary and the startup rule. It fails when:

- a file under `src/` imports anything in `packages/price-index/` other than `src/publish` and `src/schema`, or imports a bare specifier naming the tool that it cannot resolve;
- a code file in `packages/price-index/` imports from `src/`;
- a Dockerfile, Compose file, CI workflow or crontab names `packages/price-index` (other than `src/publish` or `src/schema`) or runs `npm run price-index`;
- a Dockerfile copies the whole build context (`COPY . …`) or the whole `packages/` directory, which would carry the tool into an image;
- the `dev`, `start`, `build` or `preview` script, a `pre`/`post` hook of one, or any script one of them runs through `npm run`, names the tool.

Its red path is a planted fixture in `test/fixtures/security/gates.json`, and `test/price-index/isolation-scan.test.mjs` plants one fixture for each rule.

**The isolation proof** (E11.6-07) shows the decision holds in the built artefacts, not only in the sources. `test/price-index/isolation-proof.test.ts` scans the site's build output for code from the tool's `src/http`, `src/sources`, `src/cli` and `src/reports`, and builds and serves a copy of the repository without the tool. `scrape` writes only to the gitignored raw store, and `build-data` writes `data/price-index/` only after every input and its result validate, so the tests require every file the site reads to stay byte-identical through each failure mode: a run stopped by the source, killed mid-market or interrupted, a dry run, and a failed build. `test/price-index/cli-exit.test.ts` runs every command as its own process and requires it to end on its own, with its documented exit code (`0` done, `1` refused, `2` stopped by the source, `3` validation failure, `4` interrupted).

The package adds **one direct runtime dependency, `zod` 4.6.7 (MIT)**, at the version Astro already installs, so it adds no code to the tree. Nothing in the package reaches the browser.

## Alternatives rejected

- **A scheduled job inside the site or the maintenance process.** It would give a scraper failure a path to the running site, and the founder ruled out any automation (2026-11-17).
- **A separate repository.** The pages need the schemas and the published view at build time, and the change log, approvals and published-URL ledger must be reviewed in the same pull request as the data. Two repositories would need a publishing step between them.
- **A database store from the start.** The data is small, changes once a month, and must be reviewable in a diff and append-only against the merge base. JSON files in the repository do all three. The `PriceStore` interface keeps the database option open.
- **A served JSON endpoint for the storefront.** A public API is permanently out of scope (`AGENTS.md`). The storefront imports the files.

## Consequences

- A tool crash, a block by the source or bad data can at worst leave the founder without a new data commit. The site keeps serving the last merged prices until they go stale.
- Adding a service, plan or market is a change to `config/`, validated by `price-index validate`, with no code change.
- A later ticket that needs the site to read the index does it through `src/publish` only. The Docker build stage may copy `packages/price-index/src/publish` and `src/schema`, never the rest of the package.
- The local development stack bind-mounts the working tree into its container (`infra/compose/docker-compose.yml`), so the package is present there on disk. Nothing in that stack starts or imports it, which the scan checks.
- **Reopen** if prices must update more often than a monthly pull request allows, or if the storefront needs the data at runtime rather than at build time.
