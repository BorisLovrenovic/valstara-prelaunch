# Module Boundaries and Repository Layout

Status: authoritative. One detail file per module lives in `docs/modules/`. **Changing a module boundary is an ADR-level event** — update the module doc, its consumers and the relevant ADR in the same ticket.

This is an Astro application, not a framework-heavy service, so the boundary model is deliberately small: **pages and islands render, API routes validate, server modules decide, one data layer talks to PostgreSQL.** The rules below are the ones that actually protect this campaign.

---

## Rules

Enforced in CI where possible; binding via `AGENTS.md` where not.

1. **An API route validates input, calls one server module, and shapes the response.** No SQL, no branching business rules, no email dispatch in a route. A route containing campaign logic is a review blocker.

2. **Only `server/db` issues SQL.** Server modules call the data layer; they never open their own connections or embed queries. This is what makes batch caps and retention sweeps auditable in one place.

3. **A server module never imports another module's internals** — only its exported interface. Cross-module orchestration happens in the calling route or in a job, never by reaching inside.

4. **Vendor SDKs live only inside their provider module.** Resend appears only in `server/email/providers/resend.ts`, Brevo only in `server/email/providers/brevo.ts`. **No other file imports an email vendor SDK.** Lint-enforced; never disabled. → ADR-009

5. **No component contains a literal colour, font, radius, spacing or duration value.** Every one references a token from `src/styles/tokens.css`. That file has no framework coupling and transfers to the storefront verbatim. → ADR-015

6. **No customer-visible string is inline.** All copy lives in the copy layer (`src/content/` for prose, `src/copy/` for interface strings), scanned in CI against the never-use list. → `docs/brand/copy-rules.md`

7. **Three islands, and no more.** `SignupForm`, `ThemeToggle`, `Leaderboard`. Everything else ships zero client JavaScript. A fourth island requires an ADR. → ADR-001

8. **No client code sets a cookie, writes to `localStorage`/`sessionStorage` for identification, or loads a third-party script.** The theme toggle's preference is the single permitted storage write and is functional, not identifying — documented in the cookie/storage inventory. → ADR-007, ADR-008

9. **Every write route verifies Turnstile server-side before doing anything else**, and is rate-limited per IP prefix and per normalised email. → ADR-006

10. **The audit log is append-only, enforced by database permissions.** No application path issues `UPDATE` or `DELETE` against it.

11. **Migrations are forward-only, checked-in SQL files with a recorded ledger.** Never edited after they have run anywhere. Additive first, so a rollback to the previous image still runs.

---

## Repository layout

**This is the target-state layout — the tree as it stands after all 88 tickets, not after any one of them.** A directory is created by the first ticket that needs it; a file arrives with the ticket that owns it. **No ticket is required to create a path it does not own**, and a path missing because its ticket has not run yet is correct, not a defect. Judge conformance by what a ticket added, never by what the finished tree contains.

```
valstara-prelaunch/
  AGENTS.md                        binding rules for coding agents
  README.md
  docs/                            this doc set
  src/
    pages/
      index.astro                  the landing page
      legit.astro  guarantee.astro  about.astro
      terms.astro  privacy.astro
      waitlist.astro  leaderboard.astro  me.astro
      verify.astro                 consumes a verification token
      unsubscribe.astro
      giveaway/rules/[jurisdiction].astro
      api/
        signup.ts  resend-verification.ts  survey.ts
        leaderboard.ts  amoe.ts  unsubscribe.ts
        dsr/export.ts  dsr/delete.ts
        admin/*.ts
    islands/
      SignupForm.*  ThemeToggle.*  Leaderboard.*
    components/                    zero-JS Astro components
    layouts/
    server/
      db/                          the ONLY place SQL lives; migrations + ledger
      subscriber/  verification/  referral/  fraud/  giveaway/
      email/                       service + providers/{resend,brevo}
      flags/  audit/  analytics/  geo/  turnstile/  ratelimit/  content/
      config.ts                    validated env; fails fast at boot
    copy/                          interface strings
    content/                       trust + legal prose as Markdown (ADR-017)
    styles/
      tokens.css                   ★ the portable token file — no framework coupling
  infra/
    compose/                       docker-compose, local + production, hard memory limits
    deploy/                        deploy.sh, rollback.sh, migration audit
    ENV.md                         every variable, its purpose, and which resources are live
  scripts/
    export-handoff.ts              the launch-day export (E11-06)
    import-rehearsal.ts            idempotent import against a scratch database
  .github/workflows/
```

**CI routing:** `src/**`, `infra/**`, `scripts/**` → full pipeline · `docs/**` → nothing builds.

---

## Module map

### Domain modules — own data

| Module | Owns | Key rule | Detail |
|---|---|---|---|
| **subscriber** | The waitlist row: raw and normalised email, status, country, source, UTM, wave, provenance | **Normalisation happens before any uniqueness check.** The normalised address is the unique key; the raw address is what gets displayed and mailed | `docs/modules/subscriber.md` |
| **verification** | Single-use verification tokens, hashed at rest, with an expiry and a consumption record | A token is consumed exactly once; a replay is a no-op, never an error the visitor sees | `docs/modules/verification.md` |
| **referral** | Referral codes, the referral **edge** table, tier and milestone state, reward state | `confirmed_referrals` is **derived from edges and recomputable**, never blindly incremented | `docs/modules/referral.md` |
| **giveaway** | Eligibility by jurisdiction, the entry ledger, AMOE entries, the draw record | Eligibility is decided **at point of entry** and recorded with the rules version in force | `docs/modules/giveaway.md` |
| **fraud** | Blocklist, MX results, velocity and self-referral signals, flags and their review state | Signals **flag, never auto-ban.** Every disqualification is a human decision and is audited | `docs/modules/fraud.md` |

### Cross-cutting services — no domain data of their own

| Module | Responsibility | Note |
|---|---|---|
| **email** | Send with idempotency on a business key, suppression, retry with backoff, bounce/complaint ingestion | Fire-and-forget from the caller's perspective; **a send failure never rolls back a signup** |
| **flags** | Campaign flags with code-registered fail-safe defaults | A lookup failure returns the code default — fail-safe, never fail-open |
| **audit** | Append-only event log | Append-only by database permission, not convention |
| **analytics** | Server-side funnel events to Umami; the event schema | **Never carries an email address, a referral code or an IP** |
| **geo** | `CF-IPCountry` → a prefill suggestion | Returns a *suggestion*. It has no method that can decide eligibility |
| **turnstile** | Server-side token verification | The only consumer of the Turnstile secret |
| **ratelimit** | Per-IP-prefix and per-identity windows | Backed by the database; batch-capped cleanup |
| **content** | Loads Markdown collections, validates frontmatter | Trust and legal prose only. No interface strings |

### Provider modules — the vendor SDK boundary

| Module | Wraps | Declares |
|---|---|---|
| **email/providers/resend** | Resend | Transactional · `send.valstara.com` · per-message idempotency |
| **email/providers/brevo** | Brevo | Broadcast · `mail.valstara.com` and `subslush.com` · list sync · priced per send |

Both implement the same interface and **declare their capabilities** rather than having them assumed: `supports_broadcast`, `supports_contact_sync`, `sending_domain`, `daily_free_cap`, `webhook_events`. The acceptance test for the abstraction is the same one the storefront uses: **swapping a provider touches its own module and a config entry, and nothing else.**

---

## Dependency direction

```
pages / islands → API routes → server modules → server/db → PostgreSQL
                                     ↓
                          email providers → vendor SDKs
```

**Routes depend on modules; modules never depend on routes.** Provider modules are reached only through the email service. Cross-cutting services are called by routes and jobs, never imported into a domain module's internals — with one exception, stated so it is not a surprise: **every domain module may call `audit`**, because an unauditable state change is worse than a coupling.

---

## Scheduled work

Jobs only ever **materialise, remind, expire and repair.** Nothing a customer is owed depends on a job having run.

| Job | Cadence | Batch cap | Fallback if it stops |
|---|---|---|---|
| Verification reminder ladder | hourly, in the maintenance process | yes | Reminders are late; the row still verifies from the original mail |
| Unverified expiry sweep | daily, in the maintenance process | yes | Rows linger; no counter is affected, since nothing counts unverified rows |
| Leaderboard snapshot refresh | 5 min | n/a | The last good snapshot keeps serving, with its timestamp shown |
| Referral counter repair | daily | yes | Counters drift from edges; the edges remain correct and authoritative |
| IP-prefix retention purge | daily | yes | **Retention breach — this is a compliance alert, not a hygiene one** |
| Bounce/complaint reconciliation | hourly | yes | Suppression lags; a suppressed address could receive one more send |
| Verification-rate check | hourly | n/a | **The funnel can fail silently — this job is the guard against that** |

---

## Replaceability

| Vendor | Swap path | Recorded in |
|---|---|---|
| Resend | New provider module + config. Nothing else changes | ADR-009 |
| Brevo | Same, plus a list re-sync | ADR-009 |
| Cloudflare Turnstile | New module behind the same `verify(token, ip)` interface | ADR-006 |
| Umami | Analytics module is the seam; events are schema-defined, not vendor-shaped | ADR-007 |
| Hosting (VPS → Cloudflare Pages) | **Astro adapter swap.** The API routes and data layer are the constraint — Pages means moving PostgreSQL access to a Worker-compatible driver, which is a real cost and is why the VPS is the default | ADR-003 |
