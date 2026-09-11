# Environment inventory

This inventory starts with the local Compose stack from E1-02. Values shown as
defaults in `infra/compose/docker-compose.yml` are local-development credentials
only. They are never suitable for production, and local overrides belong in an
untracked root `.env` file.

## Application boot schema

The Astro application validates this complete schema before it begins serving.
Required variables have no application fallback. `HOST`, `NODE_ENV`, and `PORT`
are optional because the Node adapter supplies development defaults; when set,
their shapes are still validated. The inventory reconciliation test reads this
table and fails if it differs from `src/server/config.ts`.

| Variable                             | Purpose                                                                     | Used by                             | Value class                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                       | Authenticates the long-running application role against `valstara_waitlist` | App boot, database pool             | Local credentials locally; live credentials in production                                                                                                              |
| `HOST`                               | Selects the Node adapter listen address                                     | App boot, Node adapter              | Runtime setting; neither live nor sandbox                                                                                                                              |
| `IP_PREFIX_PEPPER`                   | HMAC pepper for the signup route's truncated IP-prefix rate-limit key       | App boot, signup                    | Test-only secret locally; live secret in production                                                                                                                    |
| `NODE_ENV`                           | Selects the Node runtime mode                                               | App boot, Node runtime              | `development` locally; `production` on the host; neither is a credential                                                                                               |
| `PORT`                               | Selects the Node adapter listen port                                        | App boot, Node adapter              | Runtime setting; neither live nor sandbox                                                                                                                              |
| `RESEND_API_KEY`                     | Authenticates the signup route's transactional test-mode verification mail  | App boot, signup mail               | Sandbox/test key locally; live key only on the production host after E12-07                                                                                            |
| `RESEND_TEST_RECIPIENT`              | Fixed test-mode destination; never a subscriber address                     | App boot, signup mail               | Resend sandbox/test address in E1; production mail configuration is owned by E8                                                                                        |
| `TURNSTILE_SECRET_KEY`               | Verifies every public write challenge server-side                           | App boot, signup route              | Turnstile test key locally; live key in production                                                                                                                     |
| `TURNSTILE_SITE_KEY`                 | Public Turnstile site key rendered into the signup form island (E3-05)      | App boot, signup form               | Optional; defaults to Cloudflare's always-pass test key. **Temporary placeholder — the founder provisions the real key, and E12-05 swaps it in.** Public, not a secret |
| `VERIFICATION_RATE_BASELINE_DAYS`    | Prior whole days used as the rolling verification-rate baseline             | App boot, maintenance, admin health | Optional; defaults to `7`                                                                                                                                              |
| `VERIFICATION_RATE_COHORT_HOURS`     | Hours in the rolling signup cohort used by the verification-rate monitor    | App boot, maintenance, admin health | Optional; defaults to `24`                                                                                                                                             |
| `VERIFICATION_RATE_COLLAPSE_PERCENT` | Relative verification-rate drop that raises P1                              | App boot, maintenance, admin health | Optional; defaults to `50`                                                                                                                                             |
| `VERIFICATION_RATE_MINIMUM_SIGNUPS`  | Minimum current-cohort signups before the monitor can alert                 | App boot, maintenance, admin health | Optional; defaults to `50`                                                                                                                                             |

All remaining variables below configure infrastructure, one-shot processes, or
tooling and therefore are not part of the long-running application's boot
schema. Provider keys and cryptographic material are **sandbox/test values in
local development and CI, and live values only on the production host**.
Operational settings such as ports, memory limits, paths, release identifiers,
and telemetry switches are neither live nor sandbox credentials.

## Infrastructure and tooling inventory

| Variable                        | Purpose                                                                          | Used by                   | Local default                           | Secret                        |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------- | --------------------------------------- | ----------------------------- |
| `VALSTARA_DB_USER`              | PostgreSQL role that owns and migrates `valstara_waitlist`                       | PostgreSQL, migrate       | `valstara`                              | No                            |
| `VALSTARA_DB_PASSWORD`          | Password for the waitlist owner/migration role; URL-safe characters are required | PostgreSQL, migrate       | Local-only value in Compose             | Yes outside local development |
| `VALSTARA_APP_DB_PASSWORD`      | Password provisioned for the non-owner `valstara_app` login by migrations        | Migrate, app, maintenance | Local-only value in Compose             | Yes outside local development |
| `TURNSTILE_SECRET_KEY`          | Server-side key for E1-11's inline signup challenge verification                 | App                       | None                                    | Yes                           |
| `IP_PREFIX_PEPPER`              | Server-side HMAC pepper for E1-11's truncated IP-prefix rate-limit key           | App                       | None                                    | Yes                           |
| `RESEND_API_KEY`                | Resend API key used only for E1-11's transactional test-mode mail                | App                       | None                                    | Yes                           |
| `RESEND_TEST_RECIPIENT`         | Resend test address, normally `delivered@resend.dev`; never a subscriber address | App                       | None                                    | No                            |
| `UMAMI_DB_USER`                 | PostgreSQL role that owns and connects to the separate `umami` database          | PostgreSQL, Umami         | `umami`                                 | No                            |
| `UMAMI_DB_PASSWORD`             | Password for the Umami database role; URL-safe characters are required           | PostgreSQL, Umami         | Local-only value in Compose             | Yes outside local development |
| `UMAMI_APP_SECRET`              | Signs and encrypts Umami authentication tokens                                   | Umami                     | Local-only value in Compose             | Yes                           |
| `PGBACKREST_REPO1_CIPHER_PASS`  | Encrypts the pgBackRest repository                                               | PostgreSQL, restore drill | `pgbackrest-local-only`                 | Yes outside local development |
| `P1_ALERT_WEBHOOK_TOKEN`        | Authenticates P1 notifications to the operator-owned paging webhook              | Maintenance               | `local-only-alert-token`                | Yes outside local development |
| `P1_ALERT_WEBHOOK_URL`          | Endpoint for immediate operator-consumed P1 notifications                        | Maintenance               | Unroutable local sink unless overridden | No                            |
| `POSTGRES_HOST_PORT`            | Loopback-only host port for local PostgreSQL access                              | Docker Compose            | `5434`                                  | No                            |
| `POSTGRES_MEM_LIMIT`            | Hard memory and equal memory-plus-swap limit for PostgreSQL                      | Docker Compose            | `512m`                                  | No                            |
| `APP_MEM_LIMIT`                 | Hard memory and equal memory-plus-swap limit for the Astro app                   | Docker Compose            | `768m`                                  | No                            |
| `MIGRATION_MEM_LIMIT`           | Hard memory and equal memory-plus-swap limit for the one-shot migration service  | Docker Compose            | `768m`                                  | No                            |
| `MAINTENANCE_MEM_LIMIT`         | Hard memory and equal memory-plus-swap limit for reminder and expiry jobs        | Docker Compose            | `128m`                                  | No                            |
| `UMAMI_MEM_LIMIT`               | Hard memory and equal memory-plus-swap limit for Umami                           | Docker Compose            | `768m`                                  | No                            |
| `CADDY_MEM_LIMIT`               | Hard memory and equal memory-plus-swap limit for the production TLS proxy        | Production Compose        | `128m`                                  | No                            |
| `VALSTARA_IMAGE`                | Exact GHCR image reference, including the 40-character commit-SHA tag            | Production Compose        | None                                    | No                            |
| `VALSTARA_RELEASE`              | Commit SHA recorded by the migration ledger for the production image             | Migration service         | None                                    | No                            |
| `DEPLOY_AUDIT_FILE`             | Host path for the fsynced, append-only deployment and rollback audit records     | Deploy scripts            | `/var/lib/valstara/deploy-audit.jsonl`  | No                            |
| `DEPLOY_COMPOSE_FILE`           | Production Compose file used by deploy and rollback scripts                      | Deploy scripts            | Production Compose path                 | No                            |
| `DEPLOY_HEALTH_TIMEOUT_SECONDS` | Candidate and restarted-app health deadline                                      | Deploy scripts            | `60`                                    | No                            |
| `DEPLOY_HEALTH_POLL_SECONDS`    | Health polling interval                                                          | Deploy scripts            | `2`                                     | No                            |
| `SITE_HOST`                     | Hostname on the Cloudflare-proxied DNS record                                    | Caddy                     | `valstara.com`                          | No                            |
| `CADDY_ORIGIN_CERT_PATH`        | Host path to the Cloudflare Origin CA certificate mounted read-only into Caddy   | Production Compose        | None                                    | No                            |
| `CADDY_ORIGIN_KEY_PATH`         | Host path to the Cloudflare Origin CA private key mounted read-only into Caddy   | Production Compose        | None                                    | Yes                           |
| `CADDY_BIND_ADDRESS`            | Address on which Caddy publishes the origin HTTP and HTTPS ports                 | Production Compose        | `0.0.0.0`                               | No                            |
| `CADDY_HTTP_PORT`               | Host HTTP port; override only for a local production-stack drill                 | Production Compose        | `80`                                    | No                            |
| `CADDY_HTTPS_PORT`              | Host HTTPS port; override only for a local production-stack drill                | Production Compose        | `443`                                   | No                            |

### CI, test, and process environment

These values control repository tooling or are supplied by its execution
platform. They are part of the complete environment inventory even though they
do not configure the long-running application. None is a live or sandbox
provider credential.

| Variable                          | Purpose                                                                                 | Used by                              | Value class                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `CI_RED_PATH_CHILD`               | Prevents the CI gate fixture harness from recursively launching itself                  | CI red-path tests, coverage runner   | Internal test switch; fixed to `1` for child runs             |
| `CI_SECURITY_RED_PATH_CHILD`      | Prevents the security fixture harness from recursively launching itself                 | Security red-path tests              | Internal test switch; fixed to `1` for child runs             |
| `COVERAGE_BASE_SHA`               | Selects the pull request base revision for changed-line coverage                        | PR workflow, coverage scripts        | CI revision identifier; neither live nor sandbox              |
| `COVERAGE_SOURCE_MAPS`            | Enables build source maps while the coverage runner maps built server code to sources   | Coverage runner, Astro configuration | Internal coverage switch; fixed to `1` for coverage runs      |
| `DEPLOY_AUDIT_SUCCESS_OUTCOME`    | Overrides the successful deploy outcome label so the rollback drill can identify itself | Deploy script, rollback tests        | Internal test override; defaults to `succeeded`               |
| `GITHUB_ENV`                      | Names GitHub Actions' command file for exporting values to later workflow steps         | PR workflow                          | GitHub Actions-provided file path; neither live nor sandbox   |
| `GITHUB_OUTPUT`                   | Names GitHub Actions' command file for publishing step outputs                          | Main-image workflow                  | GitHub Actions-provided file path; neither live nor sandbox   |
| `GITHUB_REPOSITORY`               | Supplies the repository owner and name used to derive the GHCR image name               | Main-image workflow                  | GitHub Actions repository metadata; neither live nor sandbox  |
| `NPM_CONFIG_AUDIT`                | Disables npm's network audit during deterministic container installs                    | Docker image, local Compose          | Fixed tooling switch set to `false`; neither live nor sandbox |
| `NPM_CONFIG_FUND`                 | Disables npm's funding output during deterministic container installs                   | Docker image, local Compose          | Fixed tooling switch set to `false`; neither live nor sandbox |
| `NPM_CONFIG_MAXSOCKETS`           | Caps npm install concurrency so container memory use is repeatable                      | Docker image, local Compose          | Fixed tooling limit set to `4`; neither live nor sandbox      |
| `PATH`                            | Supplies the host executable search path; tests prepend their fake command directory    | Deploy tests                         | Host process setting; neither live nor sandbox                |
| `RESTORE_DRILL_KEEP_SCRATCH`      | Retains the scratch restore container and volume for local diagnosis when requested     | Backup restore drill                 | Optional diagnostic switch; defaults to `0`                   |
| `SECURITY_BASE_SHA`               | Selects the pull request base revision inspected by the secret and security gates       | PR workflow, security scripts        | CI revision identifier; neither live nor sandbox              |
| `TEST_DATABASE_URL`               | Selects the administrator database used to create disposable integration-test databases | Database integration tests, CI       | Local/CI test credential; never a production application URL  |
| `VALSTARA_E107_DRILL_DIAGNOSTICS` | Enables per-command timing diagnostics for the local E1-07 deploy drill                 | Deploy tests                         | Optional diagnostic switch; defaults to `0`                   |

Compose derives or fixes the following container variables. They are listed
separately because developers do not override them directly:

| Variable                   | Purpose                                                                | Used by                 | Source                                      | Secret |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------- | ------------------------------------------- | ------ |
| `POSTGRES_DB`              | Names the waitlist database                                            | PostgreSQL              | Fixed to `valstara_waitlist`                | No     |
| `POSTGRES_USER`            | Configures the waitlist database owner                                 | PostgreSQL              | `VALSTARA_DB_USER`                          | No     |
| `POSTGRES_PASSWORD`        | Authenticates the waitlist database owner                              | PostgreSQL              | `VALSTARA_DB_PASSWORD`                      | Yes    |
| `PGBACKREST_PG1_USER`      | Gives pgBackRest the PostgreSQL owner role for source-cluster checks   | PostgreSQL              | Derived from `VALSTARA_DB_USER`             | No     |
| `MIGRATION_DATABASE_URL`   | Connects the one-shot migration runner as the waitlist database owner  | Migration service       | Constructed from `VALSTARA_DB_*` settings   | Yes    |
| `UMAMI_DB_NAME`            | Names Umami's separate database                                        | PostgreSQL              | Fixed to `umami`                            | No     |
| `DATABASE_URL`             | Connects each long-running application to its assigned database        | App, maintenance, Umami | Constructed from the matching role settings | Yes    |
| `APP_SECRET`               | Supplies Umami's token-signing and encryption secret                   | Umami                   | `UMAMI_APP_SECRET`                          | Yes    |
| `ASTRO_TELEMETRY_DISABLED` | Prevents optional Astro developer telemetry from the local app service | App                     | Fixed to `1`                                | No     |
| `DISABLE_TELEMETRY`        | Prevents optional Umami telemetry                                      | Umami                   | Fixed to `1`                                | No     |
| `PRIVATE_MODE`             | Prevents Umami from making optional external requests                  | Umami                   | Fixed to `1`                                | No     |

Generate the Umami application secret for any non-local environment with
`openssl rand -hex 32`. No generated value belongs in this repository.

## Local stack

Before the first start, create the untracked `infra/compose/.env` file and
populate it with local sandbox or test values for `TURNSTILE_SECRET_KEY`,
`IP_PREFIX_PEPPER`, `RESEND_API_KEY`, and `RESEND_TEST_RECIPIENT`. Obtain the
provider test values from the matching provider account, and generate the
disposable local pepper using the procedure below. Do not put live values in
the local file, and do not commit it.

Start and verify the stack from the repository root:

```sh
docker compose -f infra/compose/docker-compose.yml up -d --wait
npm run test:stack
```

Compose runs migrations in an isolated one-shot `migrate` service before
starting the app and the maintenance process. The latter queues verification
reminders and checks the verification rate hourly, and expires unverified rows
and purges rate-limit buckets older than seven days once per UTC day; every
invocation is batch-capped where it reads or writes a set of rows. P1 failures
and verification-rate collapses are delivered to the authenticated webhook;
production refuses to start maintenance without an HTTPS destination and token.
The monitoring defaults are a 24-hour cohort, seven prior days,
at least 50 signups, and a 50% relative-rate collapse threshold.

Before starting the backup-enabled stack, supply a repository passphrase from
your shell or secret manager. It is never written to this repository:

```sh
export PGBACKREST_REPO1_CIPHER_PASS='obtain-this-from-your-secret-manager'
```

Generate the IP-prefix hashing pepper with a cryptographically secure secret
generator and store it in the environment's secret manager, outside both the
repository and PostgreSQL. Local and CI values are disposable test secrets;
production uses a separately generated live secret. Rotation invalidates all
existing prefix hashes, so record and schedule it deliberately. Never print the
pepper or pass it to logs, database columns, or client code.

The production pgBackRest passphrase is generated separately, stored off-host,
and recovered through the secret-manager procedure before a restore. Losing it
makes every encrypted backup unreadable. Rotation therefore requires a verified
backup-and-restore cycle under the replacement passphrase before retiring the
old value. Never store either passphrase in this repository or on the VPS.

Run the unattended local backup and restore proof after the stack is healthy:

```sh
npm run backup:drill
```

The drill creates a full backup, forces and verifies WAL archiving, creates a
differential backup, restores into an isolated scratch container, compares the
restored migration-ledger rows with the source database, and prints a local
restore-time floor. That figure is explicitly not the production RTO; E12-04
owns the remote repository, schedule, and production timing measurement. It
also removes only unreadable local stanza metadata left by a changed local
passphrase before creating the drill's replacement backup.

The app is available at `http://127.0.0.1:4321` and Umami at
`http://127.0.0.1:3000`. PostgreSQL is exposed only on the loopback interface at
port 5434 for local development. The app and Umami ports are also loopback-only.

The initial Umami login is `admin` / `umami`; change it immediately after the
first login. The Umami service runs with telemetry disabled and private mode on,
so this local stack makes no optional external requests.

## GitHub repository controls

GitHub branch protection is unavailable on the current private-repository plan,
as verified through the repository API on 2026-08-26. The mandatory review gates
and merge rules in `docs/engineering/git-workflow.md` are therefore enforced
procedurally, with the CI results retained as required review evidence.

## Why the migration service is sized like the application

`migrate` runs `npm ci` on a cold `app-node-modules` volume before applying
migrations, so its peak memory is an install, not a migration. It was capped at
`256m`, which held on a developer machine and was OOM-killed on a CI runner —
exit 137 — because npm's install concurrency follows the host CPU count. The
ceiling is now `768m`, matching `app`, which performs the identical install, and
both services pin `NPM_CONFIG_MAXSOCKETS` so the limit means the same thing on
every host.

The hard-limit-and-no-swap rule from ADR-003 is unchanged. A limit that is
correct on one machine and fatal on another is a mis-sized limit, not a
tighter one.

## Why the containers are Debian rather than Alpine

`app`, `migrate`, and `maintenance` run `node:22.22.3-bookworm-slim`, not `node:22-alpine`. The
lockfile pins platform-specific native binaries built for glibc —
`@astrojs/compiler-binding-linux-x64-gnu`, `@rolldown/binding-linux-x64-gnu`,
`@esbuild/linux-x64` and `sharp`. Alpine is musl and cannot load them, which is
why the containers previously needed an entirely separate `node_modules` from
the host.

With both sides on glibc, CI can share one install. `docker-compose.ci.yml`
replaces the named `app-node-modules` volume with a bind to the runner's own
`node_modules`, so nothing installs inside a container on CI at all. That
overlay is **CI-only** — locally the named volume is still correct, because a
developer's host may not be Linux, and because the containers run as root and
would leave root-owned files in a host `node_modules`.

The overlay also runs the built server instead of `astro dev`. The dev server
optimises Vite dependencies on first boot and restarts itself once when it
does, which races `docker compose up --wait` and fails it intermittently. CI has
nothing to hot-reload, so both jobs build first and the container runs
`./dist/server/entry.mjs`.

## Production image and origin stack

A push to `main` that changes `src/**`, `infra/**` or `scripts/**` publishes
`ghcr.io/borislovrenovic/valstara-prelaunch:<40-character-commit-sha>`. The
workflow retains the newest three package versions. It builds only; deployment
remains a deliberate operation owned by E1-07.

Production uses `infra/compose/docker-compose.production.yml`. Set
`VALSTARA_IMAGE` to the complete SHA-tagged reference and set
`VALSTARA_RELEASE` to the same SHA. Supply every production secret from the
host environment or its secret manager; Compose intentionally has no
production credential defaults.

Caddy terminates origin TLS with a Cloudflare Origin CA certificate. Store the
certificate and key outside the repository and point
`CADDY_ORIGIN_CERT_PATH` and `CADDY_ORIGIN_KEY_PATH` at those host files. The
key must be readable only by the account running Compose. The Cloudflare DNS
record for `SITE_HOST` must remain proxied and Cloudflare SSL/TLS mode must be
Full (strict).

The Caddy configuration accepts origin requests only when the socket peer is
in Cloudflare's published IPv4 or IPv6 ranges. Requests from any other peer
receive `403` before the app is reached, on both HTTP and HTTPS. When
Cloudflare publishes a range change, update both occurrences in
`infra/compose/Caddyfile` in one reviewed change before the new range begins
sending traffic.

Render the production configuration without starting it:

```sh
docker compose -f infra/compose/docker-compose.production.yml config --quiet
```

Run the isolated production-image and proxy drill:

```sh
npm run test:production-stack
```

The drill builds the image, starts the complete stack with temporary
credentials and a temporary TLS certificate, verifies hard memory/no-swap
limits, proves that a non-Cloudflare peer receives `403`, stops the app until
Caddy returns `503`, then starts it and waits for Caddy to serve it again. The
drill removes its containers, volumes, test network and temporary certificate
when it finishes.
