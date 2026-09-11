# Coding Standards

Status: authoritative. Enforced by tooling wherever possible; the rest is binding via `AGENTS.md`.

## Language and types
TypeScript strict throughout. **No `any`** — `unknown` plus narrowing. ESM. Dates are RFC 3339 UTC; a visitor's timezone is presentation only. **Every environment variable is validated at boot in `src/server/config.ts`, and a missing or malformed one fails fast** — a campaign site that starts without its Turnstile secret and silently accepts every bot is the failure this prevents.

## Astro patterns
- **Static by default.** A page is server-rendered only when it needs per-request data, and it carries an island only when a person has to interact. **Three islands exist and a fourth requires an ADR** (ADR-001).
- **An API route validates, calls one server module, and shapes the response.** No SQL, no branching campaign logic, no email dispatch in a route.
- **Only `server/db` issues SQL.**
- **Vendor SDKs only inside their provider module** — lint-enforced, never disabled.
- Islands hydrate with the narrowest directive that works: `client:idle` over `client:load`, `client:visible` for the leaderboard. The signup form still renders without JavaScript and explains that JavaScript is required for Turnstile; submission cannot succeed without a challenge token.

## Data and queries
Money does not appear here. Counts are integers and are **derived from their source table**, never incremented in two places. **Every query that can return an unbounded set takes an explicit limit** — the box has hard memory limits and no swap. Migrations are forward-only checked-in SQL, additive first, never edited after they have run anywhere.

## Errors
Typed error classes mapping to the **closed code set** in `docs/api/README.md#closed-code-set`. Never throw strings. **Never forward a vendor error body.** Customer-facing messages come from the copy layer, in brand voice.

## Naming and structure
Files kebab-case; types PascalCase. Layout per `docs/architecture/modules.md#repository-layout`. One exported concept per file for server modules.

## Logging
Structured JSON to stdout with a `request_id`. **Redact tokens, secrets, signatures, full IP addresses and email addresses.** Logs are for debugging; **the audit log is the record.**

## Privacy as a coding standard
This is unusual to put in a standards file, and it belongs here because it is a code property rather than a policy:

- **No code sets a non-essential cookie or writes a browser-storage value used to identify a visitor.** The theme preference is the single permitted storage write.
- **No third-party script is added to any page** except the flagged Trustpilot widget and Cloudflare Turnstile on protected signup/verification-recovery forms (ADR-006).
- **No analytics event carries personal data.**
- **No fingerprinting API is called** — canvas, font enumeration, WebGL, timing entropy. CI-scanned.

Break one of these and the site needs a consent banner, which costs conversion directly and corrupts the measurement (ADR-007). The cost of the mistake is much larger than the line of code that causes it.

## Copy duty
All customer-visible strings live in the copy layer, never inline. Trust and legal prose lives in `src/content/` as Markdown. Brand voice is binding, not stylistic, and the never-use vocabulary is **scanned in CI**.

## Git
Full policy: `docs/engineering/git-workflow.md`. In short: **`main` is the only long-lived branch.** Ticket branches `feat/<ticket-id>-slug` from `main`. Conventional Commits **including the ticket id**. **One ticket, one PR**, squash-merged. **Merged is not deployed.**

## Documentation duty
**Behaviour, contract or decision changes update the matching `docs/**` file and ADR in the same PR.** New environment variables are documented in `infra/ENV.md`. **Doc drift is a review blocker** — it is what keeps this doc set trustworthy enough for agents to build from.
