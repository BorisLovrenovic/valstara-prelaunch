# Modules: db, geo, turnstile, ratelimit, content

The five small modules, documented together because each is a few hundred lines and none owns a domain concept.

---

## `db`

**Responsibility:** the only place SQL lives. Connection pool, transactions, migrations and the migration ledger.

**Rules**
- **No server module opens its own connection or embeds a query.** Everything goes through here, which is what makes batch caps and retention sweeps auditable in one place.
- **Migrations are forward-only checked-in SQL with a checksum in the ledger.** A checksum mismatch on an already-applied migration **aborts the deploy** — an edited migration is a defect, not a difference to tolerate.
- **Additive first**: add nullable, backfill, then constrain, so the previous image still runs against the migrated schema.
- Every query that can return an unbounded set takes an explicit limit. **There is no `SELECT *` without a `LIMIT` in this codebase** — lint-enforced where possible, reviewed where not.
- The application role has `INSERT`/`SELECT` only on `audit_log`.

**Contract tests:** checksum mismatch aborts · a migration runs exactly once · pool exhaustion surfaces as `unavailable`, never as a hang.

---

## `geo` — retired

**Removed by S-01 (ADR-026, 2026-09-25).** No country is collected at signup, so the application reads no `CF-IPCountry` header and has no geo module. A scan asserts that nothing reads the header. The only location data the campaign holds is a provisional winner's country of residence, collected at award time by the giveaway module (E7-06). No postal address is collected.

---

## `turnstile`

**Responsibility:** server-side verification of Cloudflare Turnstile tokens. The only consumer of the Turnstile secret.

**Interface:** `verify(token, ip): Promise<'verified' | 'rejected' | 'unavailable'>` — the swap seam a future CAPTCHA drops into (ADR-006, `docs/architecture/modules.md`). `ip` is optional and forwarded to the provider as `remoteip` only when given; the signup route omits it so the raw client address stays inside the truncate-then-hash rate-limit path (standing rule 9).

**Rules**
- **Verified server-side on every write route, before any other work.**
- **Fail closed on a hard failure** — an invalid or replayed token is a `rejected` verdict, and the caller rejects the request. Only a failure the provider attributes to the token itself rejects; a missing/invalid-secret or internal-error verdict is not the visitor's fault and falls through to `unavailable`.
- **On a provider timeout, return `unavailable`** — a network error, a timeout, a non-2xx response, or a malformed body. The caller then **falls through to strict rate limiting and flags the row** (`challenge_timeout`), rather than either rejecting real people or opening the door. The distinction between "invalid" and "unreachable" is the whole design.
- Tokens are single-use; a replay (`timeout-or-duplicate`) is rejected.
- **The secret is read here and nowhere a route can see it**, and it appears in no log line and no response.

**Contract tests:** invalid token rejected · replayed token rejected · provider timeout accepts-and-flags under strict limits · the secret appears in no log line · no client-reachable file references the secret.

---

## `ratelimit`

**Responsibility:** per-IP-prefix and per-identity windows on every write route.

**Rules**
- Keyed on the **hashed IP prefix** and on the normalised email — never on a raw address.
- **A limit hit returns `rate_limited` with an honest wait time.** Never a silent no-op that looks like success.
- Bucket cleanup is daily and batch-capped.
- Limits are configuration. The signup and resend-verification routes carry the tightest.

**Contract tests:** window boundaries under an injected clock · resend-verification is limited per address *and* per prefix · cleanup honours its limit.

---

## `content`

**Responsibility:** load and validate the Markdown collections that hold trust and legal prose (ADR-017).

**Rules**
- **Frontmatter is schema-validated, and a validation failure fails the build.** A trust page that 404s in production is worse than a slow build.
- **Prose lives here, never inline in `.astro` markup** — a scan enforces it, because this is what makes the launch port a copy operation.
- Interface strings are **not** content; they live in `src/copy/`.
- Each content file declares the storefront route it ports to, and that mapping is the port checklist.

**Contract tests:** invalid frontmatter fails the build · a prose block in an `.astro` file fails the scan · every content file declares a port target.
