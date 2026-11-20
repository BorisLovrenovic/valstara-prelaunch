# CI/CD, Environments and Rollback

Status: authoritative.

## PR pipeline

Checks only, no build artifacts are published.

1. Install with a frozen lockfile
2. **Lint · format · typecheck**
3. **Unit, module-contract and integration tests** against a disposable PostgreSQL service container — run once, under coverage, split across eight parallel runners ([below](#how-the-suite-runs))
4. **The Astro production build** — a build failure is a blocker, and several gates below are build-time assertions
5. **Coverage gate** — on the merged report of all eight shards: ≥80% changed code; ≥90% in `subscriber`, `verification`, `referral`, `giveaway`, `email`
6. **Security and privacy gates** (below)
7. **Migration check** — the ledger's checksums match, and the schema is reproducible from the migration files alone
8. **Accessibility pass** — automated axe run over the built pages, at both themes

**All are mandatory review gates. Never skip, delete or weaken one to get green.** Docs-only changes (`docs/**`) run nothing. The workflow can also be started by hand on any branch (`gh workflow run pr.yml --ref main`), which is how a QA gate runs the full suite on `main`; with no pull request, the base revisions for the rules, coverage and secret checks fall back to the run's own commit.

The five critical-module thresholds are registered in `coverage.config.json` but remain unenforced until those modules exist. E1-04 enforces the 80% changed-line threshold from the first PR pipeline; the owning module tickets activate their 90% thresholds as the modules arrive. The lint, typecheck, test, build and coverage checks each have a committed red-path fixture exercised with `npm run ci:red-paths`. That harness runs every gate, coverage included, inside fixture repositories, so the coverage run skips it; the `red-paths` job runs it on every pull request instead.

### How the suite runs

**Founder-authorised 2026-10-23; eight runners from E11.6-11a (founder-authorised 2026-11-19).** The suite runs once per pull request, under coverage, on eight GitHub-hosted runners in parallel. Before 2026-10-23, the `test` and `coverage` jobs each ran the whole suite serially, about 21 minutes apiece. With four runners, by 2026-11-19 the slowest shard took 19.9 minutes against 8.9 for the fastest, because the recorded timings dated from 2026-10-23 and held 138 files, while the suite had grown to 237. The repository is public, so GitHub-hosted runner minutes are free: the extra runners add no paid service.

- **Planning.** `scripts/ci/shard-plan.mjs` lets Node discover the test files: a hook records each test-file child's path and exits before any test runs, so the list is exactly what `npm test` runs. It splits them by the per-file durations in `scripts/ci/shard-timings.json`, longest first, each onto the shard with the least recorded time. A file with no recorded time weighs the median, so a new file is still placed exactly once.
- **Shards.** Each `test (n/8)` job builds the app once with `node scripts/ci/app-build.mjs`, starts the CI Compose stack and runs its files with `npm run coverage -- --shard n/8`. The shard count is the matrix's alone (`shard: [1, 2, 3, 4, 5, 6, 7, 8]` in `.github/workflows/pr.yml`): the job name and the `--shard` argument read it from `strategy.job-total`, each shard records it in its report, and the planner's own command line (`node scripts/ci/shard-plan.mjs --total 8`) takes it as a required argument. Nothing else names a shard count. Each shard uploads its LCOV report, the list of files it ran and each file's measured time.
- **Merging.** `coverage` downloads the eight reports. `scripts/ci/merge-coverage.mjs` fails unless every shard from 1 to the total the reports record is present exactly once, all discovered the same files, and together ran each discovered file exactly once; a missing shard report fails it, whatever the shard plan says. It then sums each line's hits, and `changed-coverage.mjs` applies the gate. That script diffs only the roots the gate measures (`includedRoots` in `coverage.config.json`: `src/` and, since E11.6-02, `packages/price-index/src/`, which `scripts/ci/c8.config.json` also instruments), so a large change elsewhere, such as a committed fixture capture, cannot overflow the diff buffer. If any shard fails, `coverage` fails too instead of being skipped. **The merged report carries line coverage only**, which is what the gates measure. Line hits from separate runs sum to exactly what one run over every file reports: a test in `test/ci-sharding.test.mjs` proves this on real c8 output. c8 derives function and branch entries per run, including placeholders for files a run never loaded, so those cannot be combined faithfully and are not reported.
- **Build reuse.** Tests that need the built app call `ensureAppBuild()` from `scripts/ci/app-build.mjs` instead of running `npm run build`. It rebuilds only when the build inputs, the build-relevant environment or `dist/` itself changed since the stamped build. The build-relevant environment is `NODE_ENV`, `COVERAGE_SOURCE_MAPS`, `PUBLIC_*` variables and any `.env*` file: on 2026-10-23 these were measured to be the only environment that changes the output, because secrets and URLs are read at runtime. A test that changes `dist/`, such as one deleting an image to exercise a fallback, makes the stamp stale, so the next test rebuilds. Tests that build a temporary copy of the project still build that copy.

#### Refreshing the shard plan

The `coverage` job prints each shard's measured and planned time, and uploads the merged per-file times as the `shard-timings` artifact. The plan only affects balance: a stale or missing time can make one shard slower, but it can never skip or repeat a file.

**The drift warning.** After the table, `merge-coverage.mjs` compares the plan with what ran. It adds a GitHub warning annotation, "Shard plan drift", when either:

- more than 10% of the discovered test files have no recorded time in `scripts/ci/shard-timings.json`; or
- the slowest shard's measured time is more than 25% above the mean shard time.

The annotation names this procedure. **It never fails the job**: an unreadable plan is a warning too, because balance never affects correctness. A missing or repeated file still fails the merge, as above. `test/ci-sharding.test.mjs` plants a stale plan and a balanced one.

**To refresh the plan,** when the warning appears or after adding a slow test file:

1. Find the newest merged pull request that ran PR checks (a docs-only one runs none), and its latest green `PR checks` run: `gh run list --workflow pr.yml --branch <its head branch> --status success --limit 1`.
2. Download that run's merged timings: `gh run download <run-id> -n shard-timings -D <a scratch directory>`.
3. Replace `scripts/ci/shard-timings.json` with the downloaded `test-timings.json`, unchanged.
4. Commit it in a small pull request. `test/ci-sharding.test.mjs` fails if any discovered test file has no recorded time.

E11.6-11a last refreshed it on 2026-11-20, from run 44581334724 of pull request #166: 239 files, 3,143 seconds in all. The three files E11.6-11a then added (`test/container-owner.test.mjs` and its helper `test/helpers/container-owner.mjs` with its `.d.mts`) carry times measured locally on 2026-11-20 (6.6, 0.2 and 0.3 seconds), until the next refresh replaces them with CI's. E11.6-12's three test files carry 8.1 seconds for `test/price-hubs-rendered.test.mjs`, measured by CI in run 44708422358, and 0.8 and 1.6 seconds for `test/price-index/price-hubs.test.ts` and `test/price-index/retire-url.test.ts`, measured locally on 2026-11-20, until the same refresh. E11.6-13's three test files carry 2.0 seconds for `test/price-index-rendered.test.mjs` (with the price fixture site already built, which `test/price-hubs-rendered.test.mjs` shares) and 0.7 seconds each for `test/price-index/price-index-methodology.test.ts` and `test/price-index/price-index-pages.test.ts`, measured locally on 2026-11-20, until the same refresh. E11.6-14's `test/social-cards.test.ts` carries 25.8 seconds, measured by CI in run 44735281193, until the same refresh. E11.6-16 measured these times locally, until the same refresh: `test/e11-6-16-price-browser.test.mjs` 290 seconds on 2026-11-21, with its text-link and narrow-table checks and the Valstara comparison served from the price fixture site (D-040, D-041), and on 2026-11-20 `test/e11-6-16-price-routes.test.mjs` 3.0 seconds, and its helpers `test/helpers/price-audit.mjs` and `test/helpers/structured-data.mjs` 0.2 seconds each. It also replaced the recorded time of `test/e11-05-page-inventory.test.mjs` with 270 seconds, because its new crawl of every price route adds about 141 seconds to the file.

### Local checks

**Founder-authorised 2026-10-23, narrowed 2026-11-19 (E11.6-11a):** a developer's machine runs the ticket's own tests; CI runs the full suite on the pull request.

| Command | Runs |
|---|---|
| `npm run check` | `npm run price-index -- validate` first, so an invalid price-index config file stops it at once (E11.6-02); then lint, format, typecheck, `npm run security` and the build, stamped so tests reuse it |
| `npm run test:changed -- <files>` | Exactly the files named on the command line, which are the ticket's Tests-line files plus any test a review finding names, and the test files the branch adds or changes since the merge base with `origin/main` (committed, uncommitted or untracked). Nothing else |
| `npm run test:changed -- --wide <files>` | The wider selection described below. **Not part of any gate** |
| `npm run test:changed -- --dry-run [--wide] <files>` | Prints the selection and the reason for each file (`named`, `changed`, or for `--wide` the import, read, dependency or browser reach), and runs nothing |

**The local gate runs the ticket's own tests.** By default `test:changed` follows no import graph, reads no `new URL(…, import.meta.url)` or string-literal file reference, follows no lockfile change, and adds no `test:privacy` or `test:a11y` suite. **The rule is the same for a dependency upgrade:** name the tests the ticket names, and CI's full suite runs every test that loads the upgraded package. Before E11.6-11a the gate added every test a change could reach. A change to a module almost every test imports, such as `src/server/flags/registry.ts`, then selected 135 of 237 test files, and each local run took 35 to 45 minutes.

**The trade-off.** A test outside the Tests line that the change breaks is caught in CI, not locally. It is handled by CI triage (`docs/engineering/prompts/05-ci-triage.md`) like any CI failure. CI's full suite is the safety net for everything the narrower gate no longer runs, and no CI job changed for it. A change that reaches the browser still says in its pull request what it loads (`AGENTS.md`, rule 1), and CI's privacy and accessibility gates still enforce it.

**When to use `--wide`.** To see, or run, what CI's full suite will cover for this change: before pushing a change to a module many tests share, or to reproduce locally a CI failure in a test the branch reaches but does not name. Its selection is the one `test:changed` made before E11.6-11a, file for file and reason for reason, and the tests that defined it still hold (`test/changed-tests.test.mjs`). It is never required by a gate or a prompt.

**What `--wide` selects.** Test files changed since the merge base; tests whose imports reach a changed file, or that read a changed file through `new URL(…, import.meta.url)`; tests whose code (or a test helper they import) names a repository file or directory in a string literal, when that file changes or anything beneath that directory changes or is added; tests that load, at runtime, a package a lockfile change reaches; the files named; and the `test:privacy` and `test:a11y` suites whenever a change touches `src/pages`, `src/components`, `src/islands`, `src/layouts`, `src/styles`, `src/copy`, `src/content`, `src/middleware.ts`, `public/` or `astro.config.mjs`.

**Under `--wide`, tests that read the repository through `fs` are selected too.** A closed-registry test, such as the zero-JS component list in `test/interface-primitives.test.mjs` or the content set in `test/e11-07-port-checklist.test.ts`, reads a directory rather than importing it, so an added component or content file never reaches it through imports. `test:changed` therefore reads every string and template literal in test code. A literal that resolves to an existing file or directory in the repository counts as a read: `'src/content'`, `` `${root}/src/pages` ``, `'../src/components/'` in a `new URL()`, or the static prefix of a glob. A directory covers every file beneath it, including one added after the test was written. Routes, URLs, messages and paths that do not exist name nothing. The rule errs toward selecting: a literal used as data, such as a coverage root in `test/ci-pipeline.test.mjs`, also selects its test. On 2026-10-27, pull request #122 added `src/components/hero-banner.astro` and `src/content/landing-hero.json`, and three such tests failed only in CI because import-based selection missed them.

**Under `--wide`, dependency changes are followed too.** When `package-lock.json` changes, `test:changed --wide` compares the installed packages with the merge base and follows each changed package up the installed tree to the direct dependencies that pull it in. It then selects the tests that load one of those packages at runtime; type-only imports load nothing and do not count. In the default gate, `npm run check` rebuilds the app and runs the dependency audit. **Do not run the full suite locally for a dependency upgrade:** CI runs it on the pull request.

**A run cannot hang.** Every suite entry point (`npm test`, `npm run test:privacy`, `npm run test:a11y` and the coverage runner) passes `--test-force-exit`, so a test file exits once its tests finish, even if a leaked handle would keep it alive. Each helper that starts a Playwright container stops the container itself when startup fails, and `publishedPort()` in `test/helpers/listen-port.mjs` returns a container's host port only once Docker's forward accepts connections, because a server inside a container can report that it is listening before the forward is ready. On a WSL host, `reserveListenPort()` also skips a port Windows has reserved or listens on, because the browser container reaches a test server through Windows (E11.6-11a; `docs/testing/strategy.md#known-flakes`). Every per-process container a test or script starts with `docker run` carries owner labels (host name, boot ID, PID namespace, process ID), and each start first removes the labelled containers whose owner is gone, so a run that was killed before its `after()` cleanup does not leave its containers running (`test/helpers/container-owner.mjs`; E11.6-11a, D-035 Q1). Before 2026-10-24, one failed browser start in `test/e11-05-page-inventory.test.mjs` left its `docker run` child running, and that local `npm test` waited on it for over 40 minutes. The full `npm test` and `npm run coverage` still work locally for diagnosing a failure that does not reproduce from its file, but they are not part of the routine gate.

**Reproducing a CI failure.** Run the failing file with `npm test -- <file>`, prefixed with `COVERAGE_SOURCE_MAPS=1` to match the CI build exactly. For a coverage-gate failure, rerun the gate on CI's own reports in seconds:

```sh
gh run download <run-id> -p 'coverage-shard-*' -D coverage-shards
node scripts/ci/merge-coverage.mjs coverage-shards
node scripts/ci/changed-coverage.mjs
```

### A monthly price-index data pull request

A `data/price-index-YYYY-MM` pull request (E11.6-15, `docs/price-index-runbook.md`) changes only `data/price-index/` and `reports/`, so it is not docs-only and runs the whole pipeline above, unchanged. Three parts of it are what make the data safe to merge:

- **The data validates.** `test/price-index/validate-data.test.ts` ("the committed data files are valid") runs `price-index validate`'s data check, `validateDataFiles`, over the committed tree on its test shard: `latest.json`, every snapshot, the overrides, approvals, change log, URL ledger, monthly reports, run logs and coverage reports. The configuration's own checks run in the same suite (`test/price-index/config-seed.test.ts`, `config-schema.test.ts`). Locally, `npm run check` runs `price-index validate` itself first.
- **The append-only files only grow.** `npm run security` runs the price-index append-only check against the pull request's merge base: an edit, removal or reorder of an existing entry in `approvals.json`, `changes.json` or `published-urls.json` fails it.
- **Every page builds.** The Astro build generates every price route, sitemap and social card from the new `latest.json`, and its build-time checks run on them.
- **Every page is audited (E11.6-16).** The price-page audit reads the routes from the committed data (`test/helpers/price-audit.mjs`), so the full suite audits the new month's pages:
  - the link graph, structured data, copy and claims, and the number-trace sweep (`test/e11-6-16-price-routes.test.mjs`);
  - the privacy crawl of every price route (`test/e11-05-page-inventory.test.mjs`);
  - axe at every design width in both themes, the lab performance run, and the text-link and narrow-table checks (`test/e11-6-16-price-browser.test.mjs`).

There is no scheduled job for the tool in any workflow, crontab or Compose file; the isolation scan fails one.

### The security and privacy stage

Twelve scans, each with a **planted red-path fixture committed in-repo** so a scan that silently stops working is caught:

| Scan | Fails on |
|---|---|
| **Secret scan** | Any committed credential, or a `.env` path added anywhere in the PR range. `.env.example` is scanned as ordinary content |
| **Dependency scan** | Any advisory not matched by an allowlist entry carrying a written justification **and a future expiry date** |
| **Cookie and storage rule** | `document.cookie`, `Set-Cookie`, `localStorage` or `sessionStorage` outside the single permitted theme-preference write |
| **Fingerprinting rule** | Canvas, font-enumeration, WebGL or timing-entropy APIs anywhere in the codebase |
| **Third-party request rule** | A network request in a rendered page to any off-origin host except Cloudflare Turnstile on protected forms; the retired Trustpilot host is a planted red path |
| **Vendor-boundary rule** | An email vendor SDK imported outside its own provider module. Runtime `import()` targets must resolve statically; **an unresolved target fails closed** |
| **Forbidden-copy scan** | A never-use string in `src/copy/`, `src/content/`, `packages/price-index/copy/` (the price-index report templates, E11.6-09) or any `.astro` file |
| **Inline-prose scan** | Customer-visible prose inline in an `src/**/*.astro` component instead of in the copy layer |
| **Price-index isolation scan** | A file under `src/` importing any part of `packages/price-index/` other than `src/publish` and `src/schema`; a package file importing from `src/`; a Dockerfile, Compose file, CI workflow or crontab naming the tool or running `npm run price-index`; a Dockerfile copying the whole context or `packages/`; the `dev`, `start`, `build` or `preview` script, their hooks or a script they run naming the tool (E11.6-02, ADR-033) |
| **Price-index float scan** | A `parseFloat` (bare or `Number.parseFloat`), a `Number(` call or a `new Number(` anywhere in `packages/price-index/src/`, comments included: a float never holds a price, and the tool reads prices into bigint minor units through `src/money/` (E11.6-03, epic rule 3). Its red paths are planted by `test/price-index/float-scan.test.mjs`, which also runs the whole gate over the repository |
| **Price-index evasion scan** | In any code file under `packages/price-index/`, comments included: the word CAPTCHA in any form, a proxy (`proxy`, `proxies`, `--proxy-server`, `HTTPS_PROXY`), a `socks://` address, a client-address header (`X-Forwarded-For`, `X-Real-IP`, `True-Client-IP`), a host mapped to a chosen address in resolver rules, or IP rotation; and any `package.json` dependency named for a CAPTCHA, proxy, SOCKS or rotation package. The fetcher presents as an ordinary browser, and it never solves a CAPTCHA and never rotates proxies or IP addresses (E11.6-04, founder decision 2 of 2026-11-17). The verbatim captures under `packages/price-index/test/fixtures/` are not code files and are not read. Its red paths are planted by `test/price-index/evasion-scan.test.mjs`, which also runs the whole gate over the repository |
| **Price-index append-only check** | An entry of `data/price-index/approvals.json` (E11.6-06), `data/price-index/changes.json` (E11.6-09) or `data/price-index/published-urls.json` (E11.6-10) that exists at the merge base and is edited, moved or removed, or the file deleted or unreadable: only additions at the end pass, compared as JSON values (E11.6-06, epic rule 7). CI compares with the merge base of `SECURITY_BASE_SHA` and HEAD; with no base, as in a local `npm run check`, it compares with HEAD. A base that cannot be resolved fails closed. Its red paths, an edit, a removal and a reorder from `test/fixtures/price-index/approvals/`, are committed in a real git repository by `test/price-index/approvals-append-only.test.mjs`, which also runs the check over this repository; `changes.json`'s, from `test/fixtures/price-index/changes/`, by `test/price-index/changes-append-only.test.mjs`; the ledger's, from `test/fixtures/price-index/published-urls/`, by `test/price-index/published-urls-append-only.test.mjs` |

**The cookie, fingerprinting and third-party rules are what make "no consent banner" a verified property rather than an intention.** They are the reason it is safe to have no banner at all.

**One path is excepted from the fingerprinting rule and from Prettier: `packages/price-index/test/fixtures/`** (E11.6-01, founder decision D-019 Q1, 2026-11-17). It holds the founder's verbatim capture of the price index's source site, third-party pages whose inline React code reads the high-resolution timer, a timing-entropy API the rule matches. Each file's SHA-256 is pinned in `fixtures/youfundceo/manifest.tsv`, so it cannot be edited or reformatted to pass. Those pages are test inputs: nothing in them is served, bundled or loaded by a rendered page. The exception covers that directory only. The fingerprinting rule still reads the rest of `packages/price-index/`, including the tool's own `src/` and the rest of its `test/`, and every other scan still reads the fixtures. The `fingerprinting-price-index` red path in `test/fixtures/security/gates.json` plants that timer call in `packages/price-index/test/` and proves the scan still fails there. `.prettierignore` lists the same directory.

`npm run security` runs the twelve scans. `npm run ci:security-red-paths` materialises the committed fixture definitions and proves each scan fails; it is mandatory beside the production scan. The policy files live in `scripts/ci/`, while `scripts/forbidden-copy.json` is seeded from the LOCKED never-use table.

## Main pipeline

Path-filtered. A push to `main` touching `src/**`, `infra/**` or `scripts/**` builds the Docker image and pushes it to GHCR tagged with the commit SHA, with the newest three retained. **It does not deploy.** A `docs/**` change builds nothing.

The image name is normalised to lowercase before it is sent to GHCR, and the
only published tag is the full 40-character `github.sha`. The workflow uses the
repository-scoped `GITHUB_TOKEN`; it requires `contents: read` and
`packages: write`, and no registry credential is stored separately. Build and
registry actions are pinned to commit SHAs. Package retention runs only after a
successful push and keeps the newest three versions.

The root multi-stage `Dockerfile` installs from the frozen lockfile once,
builds the Astro standalone output in one stage and prunes production
dependencies in another. Its final stage runs as the unprivileged `node` user,
carries a health check, and includes the existing forward-only migration runner
and SQL files used by the production Compose migration gate. The health check
requests the landing page and releases the response body once the status is
known. Left unread, the 68 KB landing response kept the probe process alive
for about six seconds, past its three-second timeout.

Three production services run TypeScript source under native Node rather than
the built bundle: the app's boot check (`src/server/config.ts`), the migration
runner and the maintenance worker (`src/server/subscriber/run-maintenance.ts`),
whose Compose health check also runs from source
(`src/server/subscriber/heartbeat-check.ts`, QA gate 7, G7-1-I2).
The runtime stage therefore copies every `src/server` module those entry points
load. `test/production-image-entry-closure.test.mjs` walks each entry point's
import closure and fails when a module it loads is not copied; that gap once
left the maintenance worker exiting at start with `ERR_MODULE_NOT_FOUND`
(QA gate 7, G7-1-B1).

The workflow builds the image into the runner's Docker first and **smoke-starts
its maintenance worker before anything is pushed**:
`infra/compose/assert-maintenance-start.mjs <image>` starts PostgreSQL, the
migration gate and the maintenance service from the production Compose file
with placeholder configuration, waits for its health check (a heartbeat file
the worker touches after each completed pass), and fails unless the worker is
still running, unrestarted, after a 20-second settle window with no module or
configuration error in its log. Only then does the same build push the SHA tag. Run it
locally against any built image:

```sh
docker build --tag ghcr.io/local/valstara-prelaunch:smoke .
node infra/compose/assert-maintenance-start.mjs ghcr.io/local/valstara-prelaunch:smoke
```

## Environments

**Two, deliberately: local and production.**

| Env | Purpose |
|---|---|
| **Local** | Docker Compose — PostgreSQL, the app, Umami. **Provider sandboxes and test keys only** |
| **Production** | The existing VPS behind Cloudflare. Not publicly announced until the campaign opens |

There is no staging. The compensating controls are mandatory CI gates, additive migrations, health-gated deploys, campaign flags defaulting off for incomplete work, and a rehearsed rollback.

**One consequence to hold onto:** production carries no visitors before the campaign opens, but **it carries real sending credentials and a real domain reputation the moment email is configured.** From the first live Resend key onward, a mistake in production is a deliverability event. Sandbox keys never reach production; live keys never reach local.

Production is defined by `infra/compose/docker-compose.production.yml`:
PostgreSQL, the one-shot migration gate, the SHA-tagged app image, the
verification-maintenance process, Umami and Caddy. Every service has a hard
memory limit with its memory-plus-swap limit set to the same value. Only Caddy
publishes host ports; the app, maintenance process, PostgreSQL and Umami remain
on an internal Docker network.
The maintenance process also joins an outbound bridge so its Resend dispatch,
weekly IMAP seed probes and Outlook OAuth refresh can reach their external
services. That bridge publishes no host port; PostgreSQL remains on the
internal network only.

Caddy terminates TLS with a mounted Cloudflare Origin CA certificate. It
matches the immediate socket peer against Cloudflare's published address
ranges and rejects every other source before proxying. The use of the socket
peer is deliberate: a direct caller cannot bypass the check with a forged
`X-Forwarded-For` or `CF-Connecting-IP` header. After that boundary, Caddy
trusts Cloudflare's forwarding headers and passes the visitor address through
the normal proxy header path.

The app upstream has active and passive health checks. Two failed active checks
remove it from service; two successful checks return it. With no healthy app,
Caddy responds `503` rather than sending traffic to the failed backend. The
production-stack drill in `infra/compose/assert-production-stack.mjs` proves
the removal and recovery behavior through the running proxy.

## Deploy and the migration audit

Deploy pulls the SHA-tagged image, runs migrations, and health-gates the restart.

**Every deploy records: the image SHA or tag, the migrations applied, the timestamp, and the outcome** — persisted, not logged. *Which migration ran, when, on which release* must be answerable from data.

A **checksum mismatch on an already-applied migration aborts the deploy** before anything restarts. A failed health check aborts the rollout, leaving the previous version serving.

Run a production deployment with an immutable image reference:

```sh
infra/deploy/deploy.sh ghcr.io/borislovrenovic/valstara-prelaunch:<40-character-commit-sha>
```

The script pulls the image, runs the one-shot migration service, then runs the
target app as an isolated health-checked candidate before replacing the serving
app. It appends a fsynced JSON record to `DEPLOY_AUDIT_FILE` (default
`/var/lib/valstara/deploy-audit.jsonl`). Each final record includes the start
and completion times, target and previous image identifiers, migrations whose
ledger release is the target release, and the outcome. A migration failure is
recorded after querying the ledger, so migrations committed before a later
failure remain visible in the attempt record. Failures before the migration
service starts record an empty migration list; if the ledger cannot be queried
after a migration attempt, the record preserves that uncertainty as `null`.

## Rollback

**Redeploy the previous release identifier — one command.** Because migrations
are additive-first, the previous image runs against the migrated schema. **A
migration that breaks this property is a blocking review finding.**

```sh
infra/deploy/rollback.sh
```

`rollback.sh` selects the most recent successful image in the durable audit
that differs from the currently serving image, then invokes the same
health-gated deployment path. Its audit outcome is `rollback_succeeded` or the
failure outcome from that path.

### Two drills, and they prove different things

Keeping these apart matters, because one produces a number the campaign relies
on and the other cannot.

**The logic drill — E1-07, local.** Runs against the production Compose
definition on a developer machine and proves the *path*: the script pulls,
applies migrations, health-gates the candidate, and restores the previous
release when the candidate fails. It is automated and runs unattended.
The drill bounds cold image builds separately from deployment commands: image
assembly may take up to five minutes, while pulls, migrations, and health-gated
operations retain their 45-second command deadline. The build limit is a test
harness guard, not a recovery-time target.

**It does not produce an RTO.** Its duration is dominated by whatever the local
image cache already holds, so a local figure must never be recorded as the
recovery-time objective.

**The timed drill — E12-03, on the host.** Deploys release A, deploys release B,
rolls back to A, and times it with a monotonic clock from command to the
previous release verifiably serving through the proxy — warm cache and cold
cache both. **That measurement is the RTO**, and the five-minute target applies
to it. A cold-cache figure above five minutes is a blocking finding: fix the
deploy path or change the documented objective, never neither.

Until E12-03 has run, **this system has no measured RTO**, and no document
should imply otherwise.

## Backups

The E1-08 local stack uses pgBackRest with weekly full, daily differential and
continuous WAL configuration, with repository encryption enabled. Its
unattended drill creates a full and a differential backup, verifies WAL
archiving, and restores known rows into a scratch container.
Umami's separate `umami` database is in the same PostgreSQL cluster, so the
physical pgBackRest backup and restore include it alongside `valstara_waitlist`.

**The E1-08 restore timing is recorded as a local floor, not the production
RTO.** R2, the production schedule, the off-host passphrase procedure, and the
production restore measurement are E12-04.

## Secrets

Never committed; the secret scan is a mandatory gate. Every variable documented in `infra/ENV.md` with its purpose and whether it is live. Two have handling procedures of their own because losing or leaking them is expensive:

- **The pgBackRest repository passphrase** — stored off the VPS; losing it makes the backups unreadable.
- **The IP-prefix hashing pepper** — held outside the database. Rotating it invalidates every existing prefix hash, which is acceptable but must be deliberate and recorded.

A leaked secret means **rotate, then purge**. Committing over it is not remediation.

## Campaign-open sequencing

Three things must be true before the DNS record points at this site publicly, and they are gates rather than checklist items because each is unrecoverable if missed:

1. **The privacy notice and terms are published**, with the founder's Article 27 decision recorded in ADR-029. The E11-05 legal finding covering Turnstile's `cf.turnstile.u` basis, the Cloudflare processor wording and the draft `/privacy` and `/terms` is closed by the founder's risk acceptance in ADR-030 (2026-10-18). It is **waived**, not legally reviewed; the E12-05 production privacy check remains required.
2. **SPF, DKIM and DMARC verify on every sending domain**, and the seed test round-trips.
3. **The ESP tiers are upgraded past the free caps** before `giveaway.open` is turned on. E11-08 records each provider's founder-supplied account plan and limit; only then may its configured cap and `RESEND_TIER`/`BREVO_TIER` move to `paid` and P5 be marked complete (founder decision, 2026-10-18).

The per-line local evidence and open founder inputs are in [the E11-08 readiness checklist](../ops/e11-08-launch-readiness.md). E12-07 repeats that gate on the production host; the first live four-provider seed test and live-key installation belong there.

E8-02 runs `domainAuthenticationHealth()` for `send.valstara.com` when the
maintenance process starts. A failed SPF, DKIM or DMARC check does not prevent
boot; it emits a sanitized code and a P1 alert through the existing operator
webhook. E10-05 later surfaces the exported result in the admin health view
(founder-authorised 2026-09-28). The send path uses the Resend provider through
E8-01's dispatcher; the direct E1-11 test-mode sender is removed.
