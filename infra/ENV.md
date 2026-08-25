# Environment inventory

This inventory starts with the local Compose stack from E1-02. Values shown as
defaults in `infra/compose/docker-compose.yml` are local-development credentials
only. They are never suitable for production, and local overrides belong in an
untracked root `.env` file.

| Variable               | Purpose                                                                   | Used by           | Local default               | Secret                        |
| ---------------------- | ------------------------------------------------------------------------- | ----------------- | --------------------------- | ----------------------------- |
| `VALSTARA_DB_USER`     | PostgreSQL role that owns and connects to `valstara_waitlist`             | PostgreSQL, app   | `valstara`                  | No                            |
| `VALSTARA_DB_PASSWORD` | Password for the waitlist database role; URL-safe characters are required | PostgreSQL, app   | Local-only value in Compose | Yes outside local development |
| `UMAMI_DB_USER`        | PostgreSQL role that owns and connects to the separate `umami` database   | PostgreSQL, Umami | `umami`                     | No                            |
| `UMAMI_DB_PASSWORD`    | Password for the Umami database role; URL-safe characters are required    | PostgreSQL, Umami | Local-only value in Compose | Yes outside local development |
| `UMAMI_APP_SECRET`     | Signs and encrypts Umami authentication tokens                            | Umami             | Local-only value in Compose | Yes                           |
| `POSTGRES_HOST_PORT`   | Loopback-only host port for local PostgreSQL access                       | Docker Compose    | `5434`                      | No                            |
| `POSTGRES_MEM_LIMIT`   | Hard memory and equal memory-plus-swap limit for PostgreSQL               | Docker Compose    | `512m`                      | No                            |
| `APP_MEM_LIMIT`        | Hard memory and equal memory-plus-swap limit for the Astro app            | Docker Compose    | `768m`                      | No                            |
| `UMAMI_MEM_LIMIT`      | Hard memory and equal memory-plus-swap limit for Umami                    | Docker Compose    | `768m`                      | No                            |

Compose derives or fixes the following container variables. They are listed
separately because developers do not override them directly:

| Variable                   | Purpose                                                                | Used by    | Source                                      | Secret |
| -------------------------- | ---------------------------------------------------------------------- | ---------- | ------------------------------------------- | ------ |
| `POSTGRES_DB`              | Names the waitlist database                                            | PostgreSQL | Fixed to `valstara_waitlist`                | No     |
| `POSTGRES_USER`            | Configures the waitlist database owner                                 | PostgreSQL | `VALSTARA_DB_USER`                          | No     |
| `POSTGRES_PASSWORD`        | Authenticates the waitlist database owner                              | PostgreSQL | `VALSTARA_DB_PASSWORD`                      | Yes    |
| `UMAMI_DB_NAME`            | Names Umami's separate database                                        | PostgreSQL | Fixed to `umami`                            | No     |
| `DATABASE_URL`             | Connects each application to its assigned database                     | App, Umami | Constructed from the matching role settings | Yes    |
| `APP_SECRET`               | Supplies Umami's token-signing and encryption secret                   | Umami      | `UMAMI_APP_SECRET`                          | Yes    |
| `ASTRO_TELEMETRY_DISABLED` | Prevents optional Astro developer telemetry from the local app service | App        | Fixed to `1`                                | No     |
| `DISABLE_TELEMETRY`        | Prevents optional Umami telemetry                                      | Umami      | Fixed to `1`                                | No     |
| `PRIVATE_MODE`             | Prevents Umami from making optional external requests                  | Umami      | Fixed to `1`                                | No     |

Generate the Umami application secret for any non-local environment with
`openssl rand -hex 32`. No generated value belongs in this repository.

## Local stack

Start and verify the stack from the repository root:

```sh
docker compose -f infra/compose/docker-compose.yml up -d --wait
npm run test:stack
```

The app is available at `http://127.0.0.1:4321` and Umami at
`http://127.0.0.1:3000`. PostgreSQL is exposed only on the loopback interface at
port 5434 for local development. The app and Umami ports are also loopback-only.

The initial Umami login is `admin` / `umami`; change it immediately after the
first login. The Umami service runs with telemetry disabled and private mode on,
so this local stack makes no optional external requests.
