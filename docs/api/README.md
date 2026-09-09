# API Surface

Status: authoritative. All routes are Astro API routes in `src/pages/api/`, same origin as the site — **no CORS, no separate service** (ADR-005). Changing a route's contract updates this file in the same ticket.

**This document describes the finished routes**, as they stand once every epic has run — not as they stand after any one ticket. A route is built by the ticket that creates it and completed by the tickets that own its later steps; a step missing because its ticket has not run yet is **correct, not a violation**.

Two rules make that safe, and they are what a reviewer checks:

1. **Whatever a ticket does implement, it implements in the documented order.** A step may be absent; it may not be out of sequence. On a route that carries a challenge, Turnstile is first from the first line of code, because a route that does work before its challenge cannot be reordered later without re-auditing everything built on it.
2. **A ticket that creates a route names the subset it implements**, in its plan entry. A subset that is not written down is scope drift, not a subset.

## Rules that bind every route

1. **Validate, call one server module, shape the response.** No SQL, no business branching, no email dispatch in a route.
2. **Every *public, unauthenticated* write route verifies Turnstile server-side first**, then rate-limits, then does work — these are the routes a stranger can call with no prior proof: `/api/signup`, `/api/resend-verification`, `/api/amoe`. **A write authenticated by a single-use signed token is guarded by consuming that token first, in place of Turnstile** — the token is a stronger authenticator than a challenge, so `/api/survey`, `/api/unsubscribe` and `/api/dsr/*` carry no `turnstile_token`. Rate-limiting still applies to both kinds.
3. **Every response uses the error envelope below**, with a code from the closed set. **No vendor error body is ever forwarded.**
4. **No response contains another person's data.** The leaderboard is anonymised; `/me` returns only the bearer's own row.
5. **Every write route is idempotent or explicitly documented as not.** A double-submitted form must never produce two subscribers, two edges or two emails.
6. Responses set `Cache-Control: no-store` unless the route is explicitly cacheable (only `/api/leaderboard` is).

## Error envelope

```json
{ "error": { "code": "rate_limited", "message": "Too many attempts — try again in a few minutes." } }
```

`message` is customer-facing copy from the copy layer, in brand voice. Diagnostics go to the log with a `request_id`, never to the response.

### Closed code set

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_input` | 400 | Failed schema validation |
| `invalid_email` | 400 | Not a deliverable address shape, or no MX |
| `blocked_domain` | 400 | Disposable-domain blocklist |
| `challenge_failed` | 400 | Turnstile token missing, invalid or replayed |
| `already_verified` | 200 | Not an error path — returned as success. Listed so nobody invents a 4xx for it |
| `token_invalid` | 400 | Signature, purpose or subject mismatch |
| `token_expired` | 410 | Consumable, but past its expiry |
| `not_eligible` | 200 | Giveaway entry declined by jurisdiction. **The signup still succeeded** |
| `rate_limited` | 429 | Per-IP-prefix or per-identity window exceeded |
| `suppressed` | 200 | Address is unsubscribed or bounced; no send occurs |
| `unavailable` | 503 | A dependency the route cannot proceed without |
| `internal` | 500 | Everything else. Never carries detail |

**An unmapped error fails a test.** Adding a code means adding it here in the same change.

---

## Public routes

### `POST /api/signup`
Body: `email`, `country`, `region?`, `ref` (the **signed** hidden field), `turnstile_token`, `utm?`.

`country` is the **confirmed** value the person selects — prefilled from `CF-IPCountry` as a suggestion, always overridable, and detection never decides it (ADR-018, `docs/modules/platform.md#geo`). `region` is collected — and **required** — only when `country` is `CA`, because Quebec changes giveaway eligibility; a Canadian signup with no region is rejected `invalid_input`. It is ignored for every other country.

Order of operations, and it is load-bearing: verify Turnstile → rate-limit → validate → **normalise the email** → blocklist and MX → upsert the subscriber → attribute the referral edge → run fraud signals (flag only) → decide giveaway eligibility and stamp the rules version → queue the verification mail → respond.

Returns `{ status: "pending" }`. **Never returns a position, a count or a rank** — that is the position-inflation pattern the brand forbids (ADR-024), and a pending row has no honest position anyway.

Idempotent on `email_normalised`: a repeat signup for a `pending` row re-sends the verification mail subject to its own rate limit and returns the same shape. A repeat for a `verified` row returns `already_verified`.

### `GET /verify?token=…` *(page route)*
Consumes the token, sets `verified`, confirms referral edges, settles cheap rewards, assigns the access window, and renders the success page carrying the two survey questions and the referral link. **A replayed token renders the same success page** — never an error.

### `POST /api/resend-verification`
Body: `email`, `turnstile_token`. Turnstile is verified first. Rate-limited hard: **one attempt per normalised address and five per hashed IP prefix in 15 minutes** (two per prefix when Turnstile is unavailable). **Always returns the same `200` response whether or not the address exists, is pending, or is already verified** — an enumeration oracle on a waitlist is a real leak. After rate limiting, the resend decision has a fixed **500 ms response deadline**: a response is held until that deadline, and work still unsettled then finishes without changing the identical accepted response. A pending address receives a fresh token and queued verification mail; a verified address receives neither.

### `POST /api/survey`
Body: signed token or an in-page verification continuation, plus `answers`. Validated against the versioned question set. Idempotent per subscriber — a resubmission replaces, and the replacement is audited.

### `GET /api/leaderboard`
The only cacheable route. Returns the **anonymised** snapshot: display handle or masked identifier, confirmed referral count, rank, and the snapshot's `as_of` timestamp. **No email, no country, no referral code.** Flagged and disqualified subscribers are excluded. Returns `503` with honest copy when `leaderboard.public` is off.

### `GET /me?t=…` *(page route)*
Signed, expiring status link. No password, no session. Renders the bearer's own status: verified state, confirmed referrals, tier, wave, giveaway entries and eligibility. **A tampered or expired token renders a re-request page, never someone else's data.**

### `POST /api/amoe`
The alternative method of entry required in several jurisdictions. Same eligibility rules, no referral requirement, rate-limited, and recorded with its `rules_version`.

### `GET /unsubscribe?t=…` and `POST /api/unsubscribe`
One-click from the mail (RFC 8058 `List-Unsubscribe-Post`) and a confirmable page. Writes suppression. **Suppression is re-checked at dispatch**, so a send already queued still stops.

### `POST /api/dsr/export` and `POST /api/dsr/delete`
Data-subject access and erasure. Both require a signed link sent to the address, both are audited, and deletion **anonymises rather than drops** rows whose absence would corrupt referral edges — the edge survives with its subject nulled, so counts stay defensible and no personal data remains. `docs/legal/compliance.md` carries the reasoning.

---

## Admin routes

All under `/api/admin/*`, all behind admin authentication, all audited, all batch-capped.

| Route | Purpose |
|---|---|
| `GET /api/admin/export.csv` | The list export. Streamed, batch-capped, audited with row count |
| `GET /api/admin/flags` · `POST /api/admin/flags` | Read and set campaign flags |
| `GET /api/admin/fraud` · `POST /api/admin/fraud/:id` | Review queue; dismiss or uphold. Upholding disqualifies and is audited |
| `POST /api/admin/draw` | Execute the draw. Records seed and snapshot hash; refuses to publish until it reproduces |
| `GET /api/admin/health` | Verification rate, snapshot age, queue depth, quota projections |

**Admin authentication is a single shared operator credential with MFA, not a user system.** There is one operator. A permission matrix is deliberately not built.

---

## What is not built

No public API · no webhook *out* to third parties · no GraphQL · no versioned `/v1` prefix — this surface has exactly one consumer and a known end date, and versioning it would be ceremony.

Inbound provider webhooks (Resend and Brevo bounce/complaint events) are the exception and live at `/api/webhooks/{provider}`: **signature verified before parsing**, idempotent on the provider event id, and never trusted for anything but suppression state.
