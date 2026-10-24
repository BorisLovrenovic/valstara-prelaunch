# CI/CD, Environments and Rollback

Status: authoritative.

## PR pipeline

Checks only, no build artifacts are published.

1. Install with a frozen lockfile
2. **Lint · format · typecheck**
3. **Unit, module-contract and integration tests** against a disposable PostgreSQL service container — run once, under coverage, split across four parallel runners ([below](#how-the-suite-runs))
4. **The Astro production build** — a build failure is a blocker, and several gates below are build-time assertions
5. **Coverage gate** — on the merged report of all four shards: ≥80% changed code; ≥90% in `subscriber`, `verification`, `referral`, `giveaway`, `email`
6. **Security and privacy gates** (below)
7. **Migration check** — the ledger's checksums match, and the schema is reproducible from the migration files alone
8. **Accessibility pass** — automated axe run over the built pages, at both themes

**All are mandatory review gates. Never skip, delete or weaken one to get green.** Docs-only changes (`docs/**`) run nothing. The workflow can also be started by hand on any branch (`gh workflow run pr.yml --ref main`), which is how a QA gate runs the full suite on `main`; with no pull request, the base revisions for the rules, coverage and secret checks fall back to the run's own commit.

The five critical-module thresholds are registered in `coverage.config.json` but remain unenforced until those modules exist. E1-04 enforces the 80% changed-line threshold from the first PR pipeline; the owning module tickets activate their 90% thresholds as the modules arrive. The lint, typecheck, test, build and coverage checks each have a committed red-path fixture exercised with `npm run ci:red-paths`. That harness runs every gate, coverage included, inside fixture repositories, so the coverage run skips it; the `red-paths` job runs it on every pull request instead.

### How the suite runs

**Founder-authorised 2026-10-23.** The suite runs once per pull request, under coverage, on four GitHub-hosted runners in parallel. Before this, the `test` and `coverage` jobs each ran the whole suite serially, about 21 minutes apiece.

- **Planning.** `scripts/ci/shard-plan.mjs` lets Node discover the test files: a hook records each test-file child's path and exits before any test runs, so the list is exactly what `npm test` runs. It splits them by the per-file durations in `scripts/ci/shard-timings.json`, longest first, each onto the shard with the least recorded time. A file with no recorded time weighs the median, so a new file is still placed exactly once.
- **Shards.** Each `test (n/4)` job builds the app once with `node scripts/ci/app-build.mjs`, starts the CI Compose stack and runs its files with `npm run coverage -- --shard n/4`. It uploads its LCOV report, the list of files it ran and each file's measured time.
- **Merging.** `coverage` downloads the four reports. `scripts/ci/merge-coverage.mjs` fails unless all four are present, all discovered the same files, and together ran each discovered file exactly once. It then sums each line's hits, and `changed-coverage.mjs` applies the gate. If any shard fails, `coverage` fails too instead of being skipped. **The merged report carries line coverage only**, which is what the gates measure. Line hits from separate runs sum to exactly what one run over every file reports: a test in `test/ci-sharding.test.mjs` proves this on real c8 output. c8 derives function and branch entries per run, including placeholders for files a run never loaded, so those cannot be combined faithfully and are not reported.
- **Build reuse.** Tests that need the built app call `ensureAppBuild()` from `scripts/ci/app-build.mjs` instead of running `npm run build`. It rebuilds only when the build inputs, the build-relevant environment or `dist/` itself changed since the stamped build. The build-relevant environment is `NODE_ENV`, `COVERAGE_SOURCE_MAPS`, `PUBLIC_*` variables and any `.env*` file: on 2026-10-23 these were measured to be the only environment that changes the output, because secrets and URLs are read at runtime. A test that changes `dist/`, such as one deleting an image to exercise a fallback, makes the stamp stale, so the next test rebuilds. Tests that build a temporary copy of the project still build that copy.

**Refreshing the shard plan.** The `coverage` job prints each shard's measured and planned time, and uploads the merged per-file times as the `shard-timings` artifact. When the shards drift noticeably apart, or after adding a slow test file, replace `scripts/ci/shard-timings.json` with that artifact in a small pull request. The plan only affects balance: a stale or missing time can make one shard slower, but it can never skip or repeat a file.

### Local checks

**Founder-authorised 2026-10-23:** a developer's machine runs quick, targeted checks; CI runs the full suite on the pull request.

| Command | Runs |
|---|---|
| `npm run check` | Lint, format, typecheck, `npm run security` and the build, stamped so tests reuse it |
| `npm run test:changed -- <files>` | Test files changed since the merge base with `origin/main` (committed, uncommitted or untracked); tests whose imports reach a changed file, or that read a changed file through `new URL(…, import.meta.url)`; tests that load, at runtime, a package a lockfile change reaches; the files named; and the `test:privacy` and `test:a11y` suites whenever a change touches `src/pages`, `src/components`, `src/islands`, `src/layouts`, `src/styles`, `src/copy`, `src/content`, `src/middleware.ts`, `public/` or `astro.config.mjs` |

A ticket names its Tests-line files explicitly, because rendered-page tests reach pages over HTTP, not by import.

**Dependency changes are no exception.** When `package-lock.json` changes, `test:changed` compares the installed packages with the merge base and follows each changed package up the installed tree to the direct dependencies that pull it in. It then selects the tests that load one of those packages at runtime; type-only imports load nothing and do not count. `npm run check` rebuilds the app and runs the dependency audit. **Do not run the full suite locally for a dependency upgrade:** CI runs it on the pull request.

**A run cannot hang.** Every suite entry point (`npm test`, `npm run test:privacy`, `npm run test:a11y` and the coverage runner) passes `--test-force-exit`, so a test file exits once its tests finish, even if a leaked handle would keep it alive. Each helper that starts a Playwright container stops the container itself when startup fails, and `publishedPort()` in `test/helpers/listen-port.mjs` returns a container's host port only once Docker's forward accepts connections, because a server inside a container can report that it is listening before the forward is ready. Before 2026-10-24, one failed browser start in `test/e11-05-page-inventory.test.mjs` left its `docker run` child running, and that local `npm test` waited on it for over 40 minutes. `npm run test:changed -- --dry-run` prints the selection and the reason for each file without running it. The full `npm test` and `npm run coverage` still work locally for diagnosing a failure that does not reproduce from its file, but they are not part of the routine gate.

**Reproducing a CI failure.** Run the failing file with `npm test -- <file>`, prefixed with `COVERAGE_SOURCE_MAPS=1` to match the CI build exactly. For a coverage-gate failure, rerun the gate on CI's own reports in seconds:

```sh
gh run download <run-id> -p 'coverage-shard-*' -D coverage-shards
node scripts/ci/merge-coverage.mjs coverage-shards
node scripts/ci/changed-coverage.mjs
```

### The security and privacy stage

Seven scans, each with a **planted red-path fixture committed in-repo** so a scan that silently stops working is caught:

| Scan | Fails on |
|---|---|
| **Secret scan** | Any committed credential, or a `.env` path added anywhere in the PR range. `.env.example` is scanned as ordinary content |
| **Dependency scan** | Any advisory not matched by an allowlist entry carrying a written justification **and a future expiry date** |
| **Cookie and storage rule** | `document.cookie`, `Set-Cookie`, `localStorage` or `sessionStorage` outside the single permitted theme-preference write |
| **Fingerprinting rule** | Canvas, font-enumeration, WebGL or timing-entropy APIs anywhere in the codebase |
| **Third-party request rule** | A network request in a rendered page to any off-origin host except Cloudflare Turnstile on protected forms; the retired Trustpilot host is a planted red path |
| **Vendor-boundary rule** | An email vendor SDK imported outside its own provider module. Runtime `import()` targets must resolve statically; **an unresolved target fails closed** |
| **Forbidden-copy scan** | A never-use string in `src/copy/`, `src/content/` or any `.astro` file |
| **Inline-prose scan** | Customer-visible prose inline in an `src/**/*.astro` component instead of in the copy layer |

**The cookie, fingerprinting and third-party rules are what make "no consent banner" a verified property rather than an intention.** They are the reason it is safe to have no banner at all.

`npm run security` runs the eight scans. `npm run ci:security-red-paths` materialises the committed fixture definitions and proves each scan fails; it is mandatory beside the production scan. The policy files live in `scripts/ci/`, while `scripts/forbidden-copy.json` is seeded from the LOCKED never-use table.

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
and SQL files used by the production Compose migration gate.

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
