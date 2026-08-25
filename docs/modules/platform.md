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

## `geo`

**Responsibility:** turn the Cloudflare `CF-IPCountry` header into a **suggestion**.

**Rules**
- The interface is `suggestCountry(headers): string | null`. **There is no method on this module that can decide eligibility** — the shape of the interface is the guardrail.
- A missing or `XX` header returns `null`, and the selector renders unfilled rather than guessing.
- **Never let detection silently decide the country.** The confirmed value is what drives eligibility, the VAT story and the access wave.

**Contract tests:** missing header returns `null` · `XX` returns `null` · no consumer reads the header directly.

---

## `turnstile`

**Responsibility:** server-side verification of Cloudflare Turnstile tokens. The only consumer of the Turnstile secret.

**Rules**
- **Verified server-side on every write route, before any other work.**
- **Fail closed on a hard failure** — an invalid token is a rejection.
- **On a provider timeout, fall through to strict rate limiting and flag the row**, rather than either rejecting real people or opening the door. The distinction between "invalid" and "unreachable" is the whole design.
- Tokens are single-use; a replay is rejected.

**Contract tests:** invalid token rejected · replayed token rejected · provider timeout accepts-and-flags under strict limits · the secret appears in no log line.

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
