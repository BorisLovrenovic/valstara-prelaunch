# Environment inventory

This inventory starts with the local Compose stack from E1-02. Values shown as
defaults in `infra/compose/docker-compose.yml` are local-development credentials
only. They are never suitable for production, and local overrides belong in an
untracked root `.env` file.

| Variable                        | Purpose                                                                          | Used by                   | Local default                          | Secret                        |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------- | -------------------------------------- | ----------------------------- |
| `VALSTARA_DB_USER`              | PostgreSQL role that owns and migrates `valstara_waitlist`                       | PostgreSQL, migrate       | `valstara`                             | No                            |
| `VALSTARA_DB_PASSWORD`          | Password for the waitlist owner/migration role; URL-safe characters are required | PostgreSQL, migrate       | Local-only value in Compose            | Yes outside local development |
| `VALSTARA_APP_DB_PASSWORD`      | Password provisioned for the non-owner `valstara_app` login by migrations        | Migrate, app              | Local-only value in Compose            | Yes outside local development |
| `UMAMI_DB_USER`                 | PostgreSQL role that owns and connects to the separate `umami` database          | PostgreSQL, Umami         | `umami`                                | No                            |
| `UMAMI_DB_PASSWORD`             | Password for the Umami database role; URL-safe characters are required           | PostgreSQL, Umami         | Local-only value in Compose            | Yes outside local development |
| `UMAMI_APP_SECRET`              | Signs and encrypts Umami authentication tokens                                   | Umami                     | Local-only value in Compose            | Yes                           |
| `PGBACKREST_REPO1_CIPHER_PASS`  | Encrypts the pgBackRest repository; supply from the shell or secret manager      | PostgreSQL, restore drill | None                                   | Yes                           |
| `POSTGRES_HOST_PORT`            | Loopback-only host port for local PostgreSQL access                              | Docker Compose            | `5434`                                 | No                            |
| `POSTGRES_MEM_LIMIT`            | Hard memory and equal memory-plus-swap limit for PostgreSQL                      | Docker Compose            | `512m`                                 | No                            |
| `APP_MEM_LIMIT`                 | Hard memory and equal memory-plus-swap limit for the Astro app                   | Docker Compose            | `768m`                                 | No                            |
| `MIGRATION_MEM_LIMIT`           | Hard memory and equal memory-plus-swap limit for the one-shot migration service  | Docker Compose            | `768m`                                 | No                            |
| `UMAMI_MEM_LIMIT`               | Hard memory and equal memory-plus-swap limit for Umami                           | Docker Compose            | `768m`                                 | No                            |
| `CADDY_MEM_LIMIT`               | Hard memory and equal memory-plus-swap limit for the production TLS proxy        | Production Compose        | `128m`                                 | No                            |
| `VALSTARA_IMAGE`                | Exact GHCR image reference, including the 40-character commit-SHA tag            | Production Compose        | None                                   | No                            |
| `VALSTARA_RELEASE`              | Commit SHA recorded by the migration ledger for the production image             | Migration service         | None                                   | No                            |
| `DEPLOY_AUDIT_FILE`             | Host path for the fsynced, append-only deployment and rollback audit records     | Deploy scripts            | `/var/lib/valstara/deploy-audit.jsonl` | No                            |
| `DEPLOY_COMPOSE_FILE`           | Production Compose file used by deploy and rollback scripts                      | Deploy scripts            | Production Compose path                | No                            |
| `DEPLOY_HEALTH_TIMEOUT_SECONDS` | Candidate and restarted-app health deadline                                      | Deploy scripts            | `60`                                   | No                            |
| `DEPLOY_HEALTH_POLL_SECONDS`    | Health polling interval                                                          | Deploy scripts            | `2`                                    | No                            |
| `SITE_HOST`                     | Hostname on the Cloudflare-proxied DNS record                                    | Caddy                     | `valstara.com`                         | No                            |
| `CADDY_ORIGIN_CERT_PATH`        | Host path to the Cloudflare Origin CA certificate mounted read-only into Caddy   | Production Compose        | None                                   | No                            |
| `CADDY_ORIGIN_KEY_PATH`         | Host path to the Cloudflare Origin CA private key mounted read-only into Caddy   | Production Compose        | None                                   | Yes                           |
| `CADDY_BIND_ADDRESS`            | Address on which Caddy publishes the origin HTTP and HTTPS ports                 | Production Compose        | `0.0.0.0`                              | No                            |
| `CADDY_HTTP_PORT`               | Host HTTP port; override only for a local production-stack drill                 | Production Compose        | `80`                                   | No                            |
| `CADDY_HTTPS_PORT`              | Host HTTPS port; override only for a local production-stack drill                | Production Compose        | `443`                                  | No                            |

Compose derives or fixes the following container variables. They are listed
separately because developers do not override them directly:

| Variable                   | Purpose                                                                | Used by           | Source                                      | Secret |
| -------------------------- | ---------------------------------------------------------------------- | ----------------- | ------------------------------------------- | ------ |
| `POSTGRES_DB`              | Names the waitlist database                                            | PostgreSQL        | Fixed to `valstara_waitlist`                | No     |
| `POSTGRES_USER`            | Configures the waitlist database owner                                 | PostgreSQL        | `VALSTARA_DB_USER`                          | No     |
| `POSTGRES_PASSWORD`        | Authenticates the waitlist database owner                              | PostgreSQL        | `VALSTARA_DB_PASSWORD`                      | Yes    |
| `PGBACKREST_PG1_USER`      | Gives pgBackRest the PostgreSQL owner role for source-cluster checks   | PostgreSQL        | Derived from `VALSTARA_DB_USER`             | No     |
| `MIGRATION_DATABASE_URL`   | Connects the one-shot migration runner as the waitlist database owner  | Migration service | Constructed from `VALSTARA_DB_*` settings   | Yes    |
| `UMAMI_DB_NAME`            | Names Umami's separate database                                        | PostgreSQL        | Fixed to `umami`                            | No     |
| `DATABASE_URL`             | Connects each long-running application to its assigned database        | App, Umami        | Constructed from the matching role settings | Yes    |
| `APP_SECRET`               | Supplies Umami's token-signing and encryption secret                   | Umami             | `UMAMI_APP_SECRET`                          | Yes    |
| `ASTRO_TELEMETRY_DISABLED` | Prevents optional Astro developer telemetry from the local app service | App               | Fixed to `1`                                | No     |
| `DISABLE_TELEMETRY`        | Prevents optional Umami telemetry                                      | Umami             | Fixed to `1`                                | No     |
| `PRIVATE_MODE`             | Prevents Umami from making optional external requests                  | Umami             | Fixed to `1`                                | No     |

Generate the Umami application secret for any non-local environment with
`openssl rand -hex 32`. No generated value belongs in this repository.

## Local stack

Start and verify the stack from the repository root:

```sh
docker compose -f infra/compose/docker-compose.yml up -d --wait
npm run test:stack
```

Compose runs migrations in an isolated one-shot `migrate` service before
starting the app.

Before starting the backup-enabled stack, supply a repository passphrase from
your shell or secret manager. It is never written to this repository:

```sh
export PGBACKREST_REPO1_CIPHER_PASS='obtain-this-from-your-secret-manager'
```

Run the unattended local backup and restore proof after the stack is healthy:

```sh
npm run backup:drill
```

The drill creates a full backup, forces and verifies WAL archiving, creates a
differential backup, restores into an isolated scratch container, compares the
restored migration-ledger rows with the source database, and prints a local
timing floor. That timing is not a production RTO; E12-04 records the R2
restore measurement.

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

`app` and `migrate` run `node:22-bookworm-slim`, not `node:22-alpine`. The
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
