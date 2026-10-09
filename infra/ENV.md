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

| Variable                               | Purpose                                                                                               | Used by                                 | Value class                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_CREDENTIAL`                     | First factor for the single-operator admin boundary                                                   | App boot, admin middleware              | Disposable test credential locally; separately generated live credential only in the production secret manager                                                         |
| `ADMIN_TOTP_SECRET`                    | Base32 seed for the single operator's TOTP second factor                                              | App boot, admin middleware              | Disposable test seed locally; separately generated live seed only in the production secret manager                                                                     |
| `DATABASE_URL`                         | Authenticates the long-running application role against `valstara_waitlist`                           | App boot, database pool                 | Local credentials locally; live credentials in production                                                                                                              |
| `EMAIL_BASE_URL`                       | Bare public origin used to build RFC 8058 unsubscribe URLs                                            | App boot, email dispatch                | Local origin in development; HTTPS `valstara.com` origin in production                                                                                                 |
| `EMAIL_TOKEN_SECRET`                   | HMAC key for reconstructible verify, status and unsubscribe tokens                                    | App boot, email and verification        | Test-only 32+ character secret locally; independent live secret in production. Rotation invalidates all outstanding links                                              |
| `WEEKLY_SEND_UTC`                      | ISO weekday and UTC time for the weekly broadcast, formatted `2@09:00` for Tuesday at 09:00           | App, maintenance                        | Local Compose defaults to `2@09:00`; production requires an explicit value. The app uses it to pin the served snapshot during the weekly send window                   |
| `RESEND_TIER`                          | Founder-confirmed Resend account tier for the giveaway enable guard                                   | App boot, flags, maintenance            | `free` or `paid`; defaults to `free`. Set paid only after P5 verification                                                                                              |
| `BREVO_TIER`                           | Founder-confirmed Brevo account tier for the giveaway enable guard                                    | App boot, flags, maintenance            | `free` or `paid`; defaults to `free`. Set paid only after P5 verification                                                                                              |
| `RESEND_DAILY_CAP`                     | Configured Resend daily accepted-send cap for quota projection                                        | App boot, maintenance                   | Positive integer, defaults to `100`; paid tier requires a value above `100`                                                                                            |
| `BREVO_DAILY_CAP`                      | Configured Brevo daily accepted-send cap for quota projection                                         | App boot, maintenance                   | Positive integer, defaults to `300`; paid tier requires a value above `300`                                                                                            |
| `DRAND_CHAIN_HASH`                     | Pins the public drand chain whose future round seeds the draw                                         | App boot, draw, maintenance             | Optional until draw configuration; exactly 64 lowercase hex characters. Set with both drand variables below                                                            |
| `DRAND_CHAIN_PUBLIC_KEY`               | Pins the drand chain's signature-verification key                                                     | App boot, draw, maintenance             | Optional until draw configuration; lowercase hex public key. Public configuration, not a secret                                                                        |
| `DRAND_RELAY_URLS`                     | At least two distinct HTTPS drand relay origins, comma separated                                      | App boot, draw, maintenance             | Optional until draw configuration; server-side outbound endpoints. Set with the chain hash and key                                                                     |
| `GIVEAWAY_SANCTIONED_COUNTRIES`        | Country codes blocked at award time for sanctions compliance                                          | App boot, award checks                  | Optional comma-separated uppercase two-letter country codes; empty is valid until the founder supplies the list                                                        |
| `GIVEAWAY_SUBSTITUTION_DAYS`           | Days from a recorded substitution offer until silence settles cash for the unavailable item           | App boot, award checks, maintenance     | Optional positive integer; defaults to `14`                                                                                                                            |
| `HOST`                                 | Selects the Node adapter listen address                                                               | App boot, Node adapter                  | Runtime setting; neither live nor sandbox                                                                                                                              |
| `IP_PREFIX_PEPPER`                     | HMAC pepper for truncated IP-prefix rate-limit keys and fraud velocity hashes                         | App boot, signup                        | Test-only secret locally; live secret in production                                                                                                                    |
| `IP_VELOCITY_WINDOW_MINUTES`           | Rolling window for hashed-prefix velocity review                                                      | App boot, signup                        | Optional; defaults to `60`                                                                                                                                             |
| `IP_VELOCITY_THRESHOLD`                | Signups in the window that trigger a velocity review flag                                             | App boot, signup                        | Optional; defaults to `10`                                                                                                                                             |
| `REFERRAL_SIGNING_SECRET`              | HMAC-SHA256 key for the signed, 24-hour referral/UTM form field                                       | App boot, referral capture              | Test-only secret locally; live secret in production                                                                                                                    |
| `NODE_ENV`                             | Selects the Node runtime mode                                                                         | App boot, Node runtime                  | `development` locally; `production` on the host; neither is a credential                                                                                               |
| `PORT`                                 | Selects the Node adapter listen port                                                                  | App boot, Node adapter                  | Runtime setting; neither live nor sandbox                                                                                                                              |
| `RESEND_API_KEY`                       | Authenticates the server-only Resend transactional provider                                           | App and maintenance boot, dispatch      | Local test credential only; live credential only on the production host after E12-07                                                                                   |
| `RESEND_WEBHOOK_SECRET`                | Svix signing secret for raw-body Resend webhook authentication                                        | App boot, webhook                       | Required `whsec_` secret; local-only fixture locally, real secret on the host; never logged                                                                            |
| `BREVO_WEBHOOK_TOKEN`                  | Bearer secret checked before reading Brevo webhook bodies                                             | App boot, webhook                       | Required, at least 32 printable ASCII characters; local-only fixture locally, real secret on the host; never logged                                                    |
| `RESEND_WEBHOOK_GAP_MINUTES`           | Wait before flagging a Resend sent row with no terminal event                                         | Maintenance boot, reconciliation        | Optional positive integer up to 1440; defaults to `120`                                                                                                                |
| `BREVO_API_KEY`                        | Authenticates the server-only Brevo broadcast provider and contact sync                               | Maintenance boot, broadcast             | Optional while `email.broadcast` is off; live credential only on the production host after E12-07                                                                      |
| `BREVO_LIST_ID`                        | Existing Brevo broadcast-list ID                                                                      | Maintenance boot, contact sync          | Positive integer, required with `BREVO_API_KEY`                                                                                                                        |
| `BREVO_SENDING_DOMAIN`                 | Isolates broadcast From addresses to `mail.valstara.com`                                              | Maintenance boot, broadcast             | Required with `BREVO_API_KEY`; exactly `mail.valstara.com`                                                                                                             |
| `RESEND_DKIM_EXPECTED_VALUE`           | Exact public DKIM TXT value expected by the startup domain-authentication check                       | App and maintenance boot, health check  | Required non-secret public configuration                                                                                                                               |
| `RESEND_KEY_MODE`                      | Declares whether Resend configuration is `test` or `live`                                             | App and maintenance boot                | Production requires `live`; all other environments reject `live`. This marker cannot identify the installed API key                                                    |
| `RESEND_RSEND_CNAME_EXPECTED_TARGET`   | Exact public CNAME target expected for `rsend.send.valstara.com`                                      | App and maintenance boot, health check  | Required non-secret public configuration                                                                                                                               |
| `RESEND_SEND_CNAME_EXPECTED_TARGET`    | Exact public CNAME target expected for `send.send.valstara.com`                                       | App and maintenance boot, health check  | Required non-secret public configuration                                                                                                                               |
| `RESEND_SENDING_DOMAIN`                | Restricts transactional From addresses and DNS health checks to `send.valstara.com`                   | App and maintenance boot, dispatch      | Required; any other domain is rejected                                                                                                                                 |
| `RESEND_TEST_RECIPIENT`                | Optional local test-delivery override marker                                                          | App and maintenance boot                | Must be absent in production                                                                                                                                           |
| `SEED_TEST_CONFIG_PATH`                | Absolute path to the four seed mailbox credentials and Outlook OAuth rotation hook                    | Maintenance boot, weekly seed test      | Optional until E12-07; points to a production secret-manager mount. Never set locally                                                                                  |
| `TURNSTILE_SECRET_KEY`                 | Verifies every public write challenge server-side                                                     | App boot, signup route                  | Turnstile test key locally; live key in production                                                                                                                     |
| `TURNSTILE_SITE_KEY`                   | Public Turnstile site key rendered into the signup form island (E3-05)                                | App boot, signup form                   | Optional; defaults to Cloudflare's always-pass test key. **Temporary placeholder — the founder provisions the real key, and E12-05 swaps it in.** Public, not a secret |
| `VERIFICATION_RATE_BASELINE_DAYS`      | Prior whole days used as the rolling verification-rate baseline                                       | App boot, maintenance, admin health     | Optional; defaults to `7`                                                                                                                                              |
| `VERIFICATION_RATE_COHORT_HOURS`       | Hours in the rolling signup cohort used by the verification-rate monitor                              | App boot, maintenance, admin health     | Optional; defaults to `24`                                                                                                                                             |
| `VERIFICATION_RATE_COLLAPSE_PERCENT`   | Relative verification-rate drop that raises P1                                                        | App boot, maintenance, admin health     | Optional; defaults to `50`                                                                                                                                             |
| `VERIFICATION_RATE_MINIMUM_SIGNUPS`    | Minimum current-cohort signups before the monitor can alert                                           | App boot, maintenance, admin health     | Optional; defaults to `50`                                                                                                                                             |
| `REFERRAL_ATTRIBUTION_BASELINE_DAYS`   | Prior days in the referral-attribution baseline                                                       | App boot, maintenance, admin health     | Optional positive integer; defaults to `7`                                                                                                                             |
| `REFERRAL_ATTRIBUTION_COHORT_HOURS`    | Hours in the current referral-attribution cohort                                                      | App boot, maintenance, admin health     | Optional positive integer; defaults to `24`                                                                                                                            |
| `REFERRAL_ATTRIBUTION_DROP_PERCENT`    | Relative attributed-share drop that raises P1                                                         | App boot, maintenance, admin health     | Optional integer from `1` to `100`; defaults to `50`                                                                                                                   |
| `REFERRAL_ATTRIBUTION_MINIMUM_SIGNUPS` | Minimum current-cohort signups before evaluating attribution                                          | App boot, maintenance, admin health     | Optional positive integer; defaults to `50`                                                                                                                            |
| `WAITLIST_LIVE_AT`                     | Actual waitlist launch time; giveaway entry period starts at the later of this and 1 October 2026 UTC | App boot, giveaway accrual, maintenance | Optional before launch; a UTC ISO timestamp with milliseconds, required in production before enabling `giveaway.open`; set identically for app and maintenance         |

Resend API keys do not expose a sandbox marker. `RESEND_KEY_MODE` records the
intended configuration and boot enforces its environment rules, but it cannot
prove which key is installed. E12-07 supplies that evidence in the Resend
dashboard by checking that the production key is sending-only and restricted to
`send.valstara.com`.

`SEED_TEST_CONFIG_PATH` points to a secret-manager-mounted JSON file with
exactly `gmail`, `outlook`, `gmx` and `web_de`. Each mailbox has `address`,
`host`, `username`, `inboxPath` and `spamPath`; Gmail, GMX and Web.de also have
`password`. Outlook instead has `oauth` containing `clientId`, `clientSecret`,
`refreshToken`, `rotationUrl` and `rotationToken`. The Outlook account must
grant delegated IMAP access and `offline_access`.

The HTTPS rotation hook accepts an authenticated POST with
`{ "refresh_token": "..." }`, writes the replacement to the production secret
manager, and responds with success only after that write is durable and the
mounted file has been refreshed. The maintenance process keeps the replacement
in memory and reads the refreshed file again on restart. A failed rotation
stops the probe and raises P1 through the maintenance failure path. Provision
the four mailboxes and hook at E12-07; no seed credentials are needed for
E8-04's fake mailbox tests. The variable is absent locally and never reaches
a browser.
The required IMAP hosts are `imap.gmail.com`, `outlook.office365.com`,
`imap.gmx.net` and `imap.web.de`, respectively, all on TLS port 993. Each
username equals its seed address. Gmail uses an app password, not the account
password. The configured mailbox address must belong to its named provider.

`SEED_TEST_SECRETS_HOST_DIR` is the production Compose host directory mounted
read-only at `/run/seed-secrets` in the maintenance container; it defaults to
`/var/lib/valstara/seed-secrets`. E12-07 sets `SEED_TEST_CONFIG_PATH` to
`/run/seed-secrets/config.json` after the secret manager has populated that
file. The rotation hook is responsible for updating the secret manager and
this mounted file atomically before it acknowledges the request.
The mounted directory and file must be readable by the image's `node` user
(UID 1000) and inaccessible to other host users; the maintenance container
mounts them read-only.

All remaining variables below configure infrastructure, one-shot processes, or
tooling and therefore are not part of the long-running application's boot
schema. Provider keys and cryptographic material are **sandbox/test values in
local development and CI, and live values only on the production host**.
Operational settings such as ports, memory limits, paths, release identifiers,
and telemetry switches are neither live nor sandbox credentials.

## Infrastructure and tooling inventory

| Variable                             | Purpose                                                                                                        | Used by                     | Local default                                                                 | Secret                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| `VALSTARA_DB_USER`                   | PostgreSQL role that owns and migrates `valstara_waitlist`                                                     | PostgreSQL, migrate         | `valstara`                                                                    | No                            |
| `VALSTARA_DB_PASSWORD`               | Password for the waitlist owner/migration role; URL-safe characters are required                               | PostgreSQL, migrate         | Local-only value in Compose                                                   | Yes outside local development |
| `VALSTARA_APP_DB_PASSWORD`           | Password provisioned for the non-owner `valstara_app` login by migrations                                      | Migrate, app, maintenance   | Local-only value in Compose                                                   | Yes outside local development |
| `TURNSTILE_SECRET_KEY`               | Server-side key for E1-11's inline signup challenge verification                                               | App                         | None                                                                          | Yes                           |
| `IP_PREFIX_PEPPER`                   | Server-side HMAC pepper for truncated IP-prefix rate-limit keys and E5-03 velocity hashes                      | App                         | None                                                                          | Yes                           |
| `REFERRAL_SIGNING_SECRET`            | Server-only HMAC-SHA256 key for E4-02's 24-hour referral/UTM field                                             | App                         | None                                                                          | Yes                           |
| `EMAIL_TOKEN_SECRET`                 | Server-only HMAC-SHA256 key for reconstructible email tokens                                                   | App, maintenance            | Local-only Compose default; production requires a separately generated secret | Yes                           |
| `EMAIL_BASE_URL`                     | Public origin for one-click unsubscribe headers                                                                | App, maintenance            | `http://localhost:4321` locally                                               | No                            |
| `WEEKLY_SEND_UTC`                    | ISO weekday and UTC time for the weekly campaign update (`2@09:00`)                                            | App, maintenance            | `2@09:00` locally; required in production                                     | No                            |
| `RESEND_TIER`                        | Founder-confirmed transactional provider account tier                                                          | App, maintenance            | `free` locally; `paid` only after P5 verification                             | No                            |
| `BREVO_TIER`                         | Founder-confirmed broadcast provider account tier                                                              | App, maintenance            | `free` locally; `paid` only after P5 verification                             | No                            |
| `RESEND_DAILY_CAP`                   | Resend accepted-send cap for the quota projection                                                              | App, maintenance            | `100` locally; set to the verified paid allowance after P5                    | No                            |
| `BREVO_DAILY_CAP`                    | Brevo accepted-send cap for the quota projection                                                               | App, maintenance            | `300` locally; set to the verified paid allowance after P5                    | No                            |
| `RESEND_API_KEY`                     | Resend API key for E8-02 transactional dispatch                                                                | App, maintenance            | None                                                                          | Yes                           |
| `RESEND_WEBHOOK_SECRET`              | Raw-body Svix verification secret for Resend inbound events                                                    | App, maintenance            | Local-only Compose fixture; production requires a separate live secret        | Yes                           |
| `BREVO_WEBHOOK_TOKEN`                | Brevo inbound bearer token, compared before body read                                                          | App, maintenance            | Local-only Compose fixture; production requires a separate live secret        | Yes                           |
| `RESEND_WEBHOOK_GAP_MINUTES`         | Resend missing-terminal-event window                                                                           | Maintenance                 | `120` minutes                                                                 | No                            |
| `BREVO_API_KEY`                      | Server-only Brevo key for broadcast sends and contact sync; absent until E12-07 live-key installation          | Maintenance                 | Empty; needed before `email.broadcast` is enabled                             | Yes                           |
| `BREVO_LIST_ID`                      | Existing Brevo broadcast-list ID used for contact membership                                                   | Maintenance                 | Empty; a positive integer when Brevo is configured                            | No                            |
| `BREVO_SENDING_DOMAIN`               | Broadcast From-domain assertion                                                                                | Maintenance                 | Empty until Brevo is configured; then exactly `mail.valstara.com`             | No                            |
| `SEED_TEST_CONFIG_PATH`              | Mounted file with four IMAP seed accounts and Outlook OAuth rotation credentials                               | Maintenance                 | Empty until E12-07; then `/run/seed-secrets/config.json`                      | No                            |
| `SEED_TEST_SECRETS_HOST_DIR`         | Host directory synchronized from the production secret manager                                                 | Production Compose          | `/var/lib/valstara/seed-secrets`                                              | No                            |
| `RESEND_DKIM_EXPECTED_VALUE`         | Exact expected public DKIM TXT value for domain health                                                         | App, maintenance            | Local placeholder; production requires the current public value               | No                            |
| `RESEND_KEY_MODE`                    | Declares test or live Resend configuration                                                                     | App, maintenance            | `test` locally; production requires `live`                                    | No                            |
| `RESEND_RSEND_CNAME_EXPECTED_TARGET` | Expected `rsend.send` return-path CNAME target                                                                 | App, maintenance            | `rsend-euw1.forge.rmta.net`                                                   | No                            |
| `RESEND_SEND_CNAME_EXPECTED_TARGET`  | Expected `send.send` return-path CNAME target                                                                  | App, maintenance            | `send.forge.rmta.net`                                                         | No                            |
| `RESEND_SENDING_DOMAIN`              | Transactional From domain and health-check domain                                                              | App, maintenance            | `send.valstara.com`                                                           | No                            |
| `RESEND_TEST_RECIPIENT`              | Optional test-delivery recipient marker; forbidden in production                                               | App, maintenance            | Empty                                                                         | No                            |
| `UMAMI_DB_USER`                      | PostgreSQL role that owns and connects to the separate `umami` database                                        | PostgreSQL, Umami           | `umami`                                                                       | No                            |
| `UMAMI_DB_PASSWORD`                  | Password for the Umami database role; URL-safe characters are required                                         | PostgreSQL, Umami           | Local-only value in Compose                                                   | Yes outside local development |
| `UMAMI_APP_SECRET`                   | Signs and encrypts Umami authentication tokens                                                                 | Umami                       | Local-only value in Compose                                                   | Yes                           |
| `PGBACKREST_REPO1_CIPHER_PASS`       | Encrypts the pgBackRest repository                                                                             | PostgreSQL, restore drill   | `pgbackrest-local-only`                                                       | Yes outside local development |
| `P1_ALERT_WEBHOOK_TOKEN`             | Authenticates P1 and P2 notifications to the operator-owned alert webhook; the `P1_` prefix is historical      | App draw route, maintenance | `local-only-alert-token`                                                      | Yes outside local development |
| `P1_ALERT_WEBHOOK_URL`               | Endpoint for severity-bearing P1 and P2 notifications; the receiver owns paging versus within-the-hour routing | App draw route, maintenance | Unroutable local sink unless overridden                                       | No                            |
| `POSTGRES_HOST_PORT`                 | Loopback-only host port for local PostgreSQL access                                                            | Docker Compose              | `5434`                                                                        | No                            |
| `POSTGRES_MEM_LIMIT`                 | Hard memory and equal memory-plus-swap limit for PostgreSQL                                                    | Docker Compose              | `512m`                                                                        | No                            |
| `APP_MEM_LIMIT`                      | Hard memory and equal memory-plus-swap limit for the Astro app                                                 | Docker Compose              | `768m`                                                                        | No                            |
| `MIGRATION_MEM_LIMIT`                | Hard memory and equal memory-plus-swap limit for the one-shot migration service                                | Docker Compose              | `768m`                                                                        | No                            |
| `MAINTENANCE_MEM_LIMIT`              | Hard memory and equal memory-plus-swap limit for reminder and expiry jobs                                      | Docker Compose              | `128m`                                                                        | No                            |
| `UMAMI_MEM_LIMIT`                    | Hard memory and equal memory-plus-swap limit for Umami                                                         | Docker Compose              | `768m`                                                                        | No                            |
| `CADDY_MEM_LIMIT`                    | Hard memory and equal memory-plus-swap limit for the production TLS proxy                                      | Production Compose          | `128m`                                                                        | No                            |
| `VALSTARA_IMAGE`                     | Exact GHCR image reference, including the 40-character commit-SHA tag                                          | Production Compose          | None                                                                          | No                            |
| `VALSTARA_RELEASE`                   | Commit SHA recorded by the migration ledger for the production image                                           | Migration service           | None                                                                          | No                            |
| `DEPLOY_AUDIT_FILE`                  | Host path for the fsynced, append-only deployment and rollback audit records                                   | Deploy scripts              | `/var/lib/valstara/deploy-audit.jsonl`                                        | No                            |
| `DEPLOY_COMPOSE_FILE`                | Production Compose file used by deploy and rollback scripts                                                    | Deploy scripts              | Production Compose path                                                       | No                            |
| `DEPLOY_HEALTH_TIMEOUT_SECONDS`      | Candidate and restarted-app health deadline                                                                    | Deploy scripts              | `60`                                                                          | No                            |
| `DEPLOY_HEALTH_POLL_SECONDS`         | Health polling interval                                                                                        | Deploy scripts              | `2`                                                                           | No                            |
| `SITE_HOST`                          | Hostname on the Cloudflare-proxied DNS record                                                                  | Caddy                       | `valstara.com`                                                                | No                            |
| `CADDY_ORIGIN_CERT_PATH`             | Host path to the Cloudflare Origin CA certificate mounted read-only into Caddy                                 | Production Compose          | None                                                                          | No                            |
| `CADDY_ORIGIN_KEY_PATH`              | Host path to the Cloudflare Origin CA private key mounted read-only into Caddy                                 | Production Compose          | None                                                                          | Yes                           |
| `CADDY_BIND_ADDRESS`                 | Address on which Caddy publishes the origin HTTP and HTTPS ports                                               | Production Compose          | `0.0.0.0`                                                                     | No                            |
| `CADDY_HTTP_PORT`                    | Host HTTP port; override only for a local production-stack drill                                               | Production Compose          | `80`                                                                          | No                            |
| `CADDY_HTTPS_PORT`                   | Host HTTPS port; override only for a local production-stack drill                                              | Production Compose          | `443`                                                                         | No                            |

### CI, test, and process environment

These values control repository tooling or are supplied by its execution
platform. They are part of the complete environment inventory even though they
do not configure the long-running application. None is a live or sandbox
provider credential.

| Variable                          | Purpose                                                                                 | Used by                              | Value class                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `CHAOS_APP_PORT`                  | Loopback host port for the disposable E11-02 application                                | Chaos Compose overlay                | Optional local port; defaults to `54322`                      |
| `CHAOS_CLOCK`                     | Injected UTC clock for the E11-02 one-shot maintenance and snapshot workers             | Chaos drill workers                  | Per-run ISO timestamp; local test input only                  |
| `CHAOS_POSTGRES_PORT`             | Loopback host port for the disposable E11-02 PostgreSQL instance                        | Chaos Compose overlay                | Optional local port; defaults to `55435`                      |
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
| `NODE_OPTIONS`                    | Loads the local E11-02 provider fault-injection preload into the drill app              | Chaos Compose app                    | Fixed to the local preload path; no browser script            |
| `PATH`                            | Supplies the host executable search path; tests prepend their fake command directory    | Deploy tests                         | Host process setting; neither live nor sandbox                |
| `RESTORE_DRILL_KEEP_SCRATCH`      | Retains the scratch restore container and volume for local diagnosis when requested     | Backup restore drill                 | Optional diagnostic switch; defaults to `0`                   |
| `RULES_BASE_SHA`                  | Selects the pull request base revision for the immutable giveaway-rules check           | PR workflow, rules history test      | CI revision identifier; neither live nor sandbox              |
| `SECURITY_BASE_SHA`               | Selects the pull request base revision inspected by the secret and security gates       | PR workflow, security scripts        | CI revision identifier; neither live nor sandbox              |
| `TEST_DATABASE_URL`               | Selects the administrator database used to create disposable integration-test databases | Database integration tests, CI       | Local/CI test credential; never a production application URL  |
| `VALSTARA_CHAOS_SCRIPTS_DIR`      | Host path of the E11-02 drill scripts mounted read-only into the disposable app         | Chaos Compose overlay                | Absolute local `scripts/chaos` path; set by the runner        |
| `VALSTARA_CHAOS_SOURCE_DIR`       | Host path of server modules mounted read-only into the disposable app                   | Chaos Compose overlay                | Absolute local `src/server` path; set by the runner           |
| `VALSTARA_CHAOS_STATE_DIR`        | Host path of disposable provider modes and alert output mounted into the drill app      | Chaos Compose overlay                | Temporary local directory; created and removed by the runner  |
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
populate it with local sandbox or test values for `ADMIN_CREDENTIAL`,
`ADMIN_TOTP_SECRET`, `TURNSTILE_SECRET_KEY`, `IP_PREFIX_PEPPER`,
`REFERRAL_SIGNING_SECRET`, and `RESEND_API_KEY`.
Obtain the provider test values from the matching provider account, and
generate the disposable local secrets using the procedures below. Do not put
live values in the local file, and do not commit it.

Start and verify the stack from the repository root:

```sh
docker compose -f infra/compose/docker-compose.yml up -d --wait
npm run test:stack
```

Compose runs migrations in an isolated one-shot `migrate` service before
starting the app and the maintenance process. The latter queues verification
reminders and checks the verification rate and referral-attribution share hourly, and expires unverified rows
and purges rate-limit buckets older than seven days once per UTC day; every
invocation is batch-capped where it reads or writes a set of rows. P1 failures,
verification-rate collapses, and P2 referral-counter corrections are delivered
to the authenticated webhook with their severity; production refuses to start
maintenance without an HTTPS destination and token.
The monitoring defaults are a 24-hour cohort, seven prior days,
at least 50 signups, and a 50% relative-rate collapse threshold.

Before starting the backup-enabled stack, supply a repository passphrase from
your shell or secret manager. It is never written to this repository:

```sh
export PGBACKREST_REPO1_CIPHER_PASS='obtain-this-from-your-secret-manager'
```

Generate the IP-prefix hashing pepper with a cryptographically secure secret
generator, and generate the referral signing secret the same way. Store both in
the environment's secret manager, outside both the repository and PostgreSQL.
Local and CI values are disposable test secrets; production uses separately
generated live secrets. Pepper rotation invalidates all existing prefix hashes,
so record and schedule it deliberately. Never print either value or pass it to
logs, database columns, or client code.

Generate the admin credential with at least 32 random bytes and generate the
TOTP seed as an unpadded, uppercase Base32 encoding of at least 20 random bytes.
Enroll that TOTP seed in the single operator's authenticator, then store both
values only in the environment's secret manager. The app accepts the credential
as an `Authorization: Bearer` value and the current six-digit code in
`X-Valstara-TOTP`; neither value may be logged, audited, returned, or committed.
Local and CI values are disposable and must never be reused in production.

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

The first-party local entry point is `http://127.0.0.1:8080`; it routes
`/analytics/api/send` to Umami and every other public page to the app. The app
is also available directly at `http://127.0.0.1:4321` and Umami's operator UI at
`http://127.0.0.1:3000`. PostgreSQL is exposed only on the loopback interface
at port 5434 for local development. All these ports are loopback-only. The
production Caddy proxy exposes only Umami's collector endpoint under
`/analytics/`; it returns 404 for `/analytics/script.js` and every other Umami
path.

The initial Umami login is `admin` / `umami`; change it immediately after the
first login. The Umami service runs with telemetry disabled and private mode on,
so this local stack makes no optional external requests.

Create the Valstara website in each Umami database with public ID
`a4041033-3269-4a73-8772-c16f9bdf1a33`, name `Valstara`, and domain
`valstara.com` through Umami's authenticated `POST /api/websites` endpoint.
The `id` request field accepts that explicit UUID. This ID is fixed in
`src/layouts/page-view-emitter.astro`; it is public, not a secret. The
operator provisions the production website at E12-07 before enabling traffic.

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

## E11-01 disposable load exercise

`scripts/load/docker-compose.load.yml` overlays the production Compose file only
for the local load exercise. Its variables are not application boot settings.
Keep the values and the test database outside the repository; the runner accepts
only a loopback target. The command and profile are in
[`docs/testing/e11-01-load-report.md`](../docs/testing/e11-01-load-report.md).

| Variable                    | Purpose                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `VALSTARA_LOAD_SCRIPTS_DIR` | Absolute host path of `scripts/load`, mounted read-only into the test app for the fake email sink  |
| `LOAD_APP_PORT`             | Optional loopback app port override; default is `54321`                                            |
| `LOAD_POSTGRES_PORT`        | Optional loopback PostgreSQL port override; default is `55434`                                     |
| `LOAD_BASE_URL`             | Loopback app URL used by the runner                                                                |
| `LOAD_REQUEST_ORIGIN`       | `http://valstara.com` Host and Origin for the local trusted-proxy test                             |
| `LOAD_DATABASE_URL`         | Owner URL for the disposable PostgreSQL database, used only by the runner for seeds and assertions |
| `LOAD_APP_CONTAINER`        | App container name for memory sampling and the fake mail drain                                     |
| `LOAD_POSTGRES_CONTAINER`   | PostgreSQL container name for memory sampling                                                      |
| `LOAD_UMAMI_CONTAINER`      | Umami container name for memory sampling                                                           |
| `LOAD_ADMIN_CREDENTIAL`     | Disposable admin bearer credential for the deliberately large CSV export                           |
| `LOAD_ADMIN_TOTP_SECRET`    | Disposable admin TOTP secret for the deliberately large CSV export                                 |
