# API Surface

Status: authoritative. All routes are Astro API routes in `src/pages/api/`, same origin as the site — **no CORS, no separate service** (ADR-005). Changing a route's contract updates this file in the same ticket.

**This document describes the finished routes**, as they stand once every epic has run — not as they stand after any one ticket. A route is built by the ticket that creates it and completed by the tickets that own its later steps; a step missing because its ticket has not run yet is **correct, not a violation**.

Two rules make that safe, and they are what a reviewer checks:

1. **Whatever a ticket does implement, it implements in the documented order.** A step may be absent; it may not be out of sequence. On a route that carries a challenge, Turnstile is first from the first line of code, because a route that does work before its challenge cannot be reordered later without re-auditing everything built on it.
2. **A ticket that creates a route names the subset it implements**, in its plan entry. A subset that is not written down is scope drift, not a subset.

## Rules that bind every route

1. **Validate, call one server module, shape the response.** No SQL, no business branching, no email dispatch in a route.
2. **Every *public, unauthenticated* write route verifies Turnstile server-side first**, then rate-limits, then does work — these are the routes a stranger can call with no prior proof: `/api/signup`, `/api/resend-verification`, the `/me` recovery POST, `/api/me/marketing`, `/api/me/leave` and the E7-06 winner-details form. The two `/api/me/*` actions and the winner-details form carry a reusable status token as well, so Turnstile still applies. **A write authenticated by a single-use signed token is guarded by consuming that token first, in place of Turnstile** — the token is a stronger authenticator than a challenge, so `/api/survey`, `/api/unsubscribe` and `/api/dsr/*` carry no `turnstile_token`. Rate-limiting still applies to both kinds.
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
| `token_invalid` | 400 | Signature, purpose or subject mismatch |
| `token_expired` | 410 | Consumable, but past its expiry |
| `rate_limited` | 429 | Per-IP-prefix or per-identity window exceeded |
| `suppressed` | 200 | Address is unsubscribed or bounced; no send occurs |
| `unavailable` | 503 | A dependency the route cannot proceed without |
| `internal` | 500 | Everything else. Never carries detail |
| `unauthorized` | 401 | An admin credential or TOTP is missing or invalid. The response never distinguishes which factor failed |

**An unmapped error fails a test.** Adding a code means adding it here in the same change.

---

## Public routes

### `POST /api/signup`
Body: `email`, `ref` (the **signed** hidden field), `turnstile_token`, `utm?`, `marketing_opt_in?`.

**No country, region or other location is accepted** (ADR-026). A request that still carries `country` or `region` is handled exactly like one that does not, and neither value is stored. `marketing_opt_in` is the separate, optional, unticked marketing checkbox (ADR-027); its checked value is the version of the wording shown. The route accepts the current version and retained rendered versions from the copy layer, so a form left open across a wording deployment still submits. Ticked, it records a *pending* opt-in and the submitted version, replacing an earlier pending version on a repeat ticked submission. Verification copies the stored version into consent and clears both pending fields. Whether it is ticked never changes the response, the waitlist place or the giveaway.

Order of operations, and it is load-bearing: verify Turnstile → rate-limit → validate → **normalise the email** → blocklist and MX → upsert the subscriber and record a pending marketing opt-in if ticked → attribute the referral edge → run fraud signals (flag only) → queue the verification mail → respond. Giveaway entry happens at verification (E7-01, E7-03), not here.

Returns `{ status: "pending" }`. The status code, response keys and values are identical whether the normalised address is unknown, pending or already verified. **Never returns a position, a count, a rank or an address-membership signal** — a public response cannot disclose another person's status.

Idempotent on `email_normalised`: a repeat signup for a `pending` row re-sends the verification mail subject to its own rate limit; a repeat for a `verified` row sends no second verification mail. Both return the same accepted response as an unknown address. Any status-link affordance is sent only to the submitted address, never returned by this route or rendered on its response page.

### `GET /verify?token=…` *(page route)*
Non-mutating: renders a confirmation form carrying the bearer token. Mail scanners and prefetchers can GET repeatedly without consuming it.

### `POST /verify` *(page route)*
Body: `token`. Token-authenticated and therefore exempt from Turnstile-first. Consumes the token and, in one transaction, sets `verified`, turns a pending marketing opt-in into consent (audited), confirms referral edges, settles cheap rewards, holds high-value rewards and assigns access windows, then renders the success page. **A replayed token renders the same success page**. Invalid and expired tokens render identical generic failure copy and the same request-new-link control.

### `POST /api/resend-verification`
Body: `email`, `turnstile_token`. Turnstile is verified first. Rate-limited hard: **one attempt per normalised address and five per hashed IP prefix in 15 minutes** (two per prefix when Turnstile is unavailable). **Always returns the same `200` response whether or not the address exists, is pending, or is already verified** — an enumeration oracle on a waitlist is a real leak. After rate limiting, the resend decision has a fixed **500 ms response deadline**: a response is held until that deadline, and work still unsettled then finishes without changing the identical accepted response. A pending address receives a fresh token and queued verification mail; a verified address receives neither.

### `POST /api/survey`
Body: the signed `status` token, question-set `version`, and the two answers. Either answer may be omitted to record a first-class skip. The bearer token is consumed before rate limiting or survey work; invalid and expired tokens return the same `token_invalid` response. Validated against the named versioned question set. Idempotent per subscriber — a resubmission replaces, and the replacement is audited. Limited to 10 attempts per subscriber and 20 per hashed IP prefix in 15 minutes. With `survey.enabled` off it returns an honest `unavailable` response and writes no survey answer.

### `GET /api/leaderboard`
The only cacheable route. Returns the **anonymised top-10** snapshot: a deterministic SHA-256-derived display handle, confirmed referral count, rank, and the snapshot's `as_of` timestamp. **No email, country, referral code or subscriber ID.** Flagged and disqualified subscribers are excluded. Returns `503` with honest copy when `leaderboard.public` is off.

### `GET /me?t=…` and `POST /me?t=…` *(page route)*
`GET` authenticates the signed, expiring status link. No password, no session.
It renders the bearer's own status: verified state, confirmed referrals, own
rank, tier, wave, giveaway entries and the current marketing preference. After an explicit leave, the same link shows a simple confirmation without the dashboard. **A tampered or expired token renders
the identical re-request page, never someone else's data.** `POST` is that
page's one-click recovery action and carries `turnstile_token`. Turnstile is
verified first, before flag, rate-limit, token or email work. Provider timeout
uses the strict IP-prefix limit and flags a recognised subscriber for review.
A recognised expired `status` token queues a `status_link` email request for
its bound subscriber, rate-limited per subscriber and truncated, hashed IP
prefix. Unknown, tampered and cross-purpose tokens queue nothing and receive
the same acknowledgement.

### `POST /api/me/marketing`
Body: `t` (the signed status token), `marketing` (`on` · `off`), `turnstile_token`. Turnstile is verified first. The route is limited per truncated, hashed IP prefix and per authenticated subscriber, with a stricter prefix limit on provider timeout. A tampered or expired token gets the identical accepted response, and nothing changes. With `member.dashboard` off, the route reports `unavailable` and writes nothing. `on` records the current copy-layer wording version with source `member_status`; `off` withdraws it. Each change is audited in the same transaction, and **neither touches waitlist status, referral edges, wave or giveaway entries** (ADR-027). Built by S-01.

### `POST /api/me/leave`
Body: `t` (the reusable signed status token), `turnstile_token`. Turnstile is verified before flag, rate-limit, token or suppression work. The route uses the `member.dashboard` flag and the same IP-prefix and subscriber limits as `/api/me/marketing`, including the stricter prefix limit and a review flag for a recognised subscriber when Turnstile is unavailable. An invalid status token receives the same accepted response and changes nothing. A valid request calls the shared unsubscribe service with `leave_waitlist`; suppression, the verified subscriber's transition to `unsubscribed`, and its audit event commit together. A failed transaction returns `unavailable` (503), leaves the action retryable, and sends a P1 operator task containing the token SHA-256 and request action.

*There is no separate alternative-method-of-entry route.* The ordinary verified signup is the free entry route (ADR-026, E7-04).

### `GET /giveaway/award?award=…&t=…` and `POST /giveaway/award?award=…&t=…` *(page route)*

`GET` authenticates the reusable signed status token and displays only the current provisional winner's award. `POST` reads `turnstile_token` and verifies it server-side before award work, then rate-limits by truncated, hashed IP prefix and authenticated subscriber. The `checks` form accepts only country of residence, age confirmation, optional Canadian mathematical answer and separate optional publicity permission. A failed Section 9 check or response deadline advances the prize to the next reserve. A passing response confirms the award against its committed snapshot. If a catalog product is unavailable, the confirmed winner's `substitution` form offers validated replacement product IDs or an explicit cash decline. The substitution deadline is separate; silence settles cash for unavailable products only and never changes the winner. Both forms return no other person's data and use `Cache-Control: private, no-store` with `Referrer-Policy: no-referrer`. With `giveaway.open` off, no award write occurs.

### `GET /unsubscribe?t=…` and `POST /api/unsubscribe`
One-click from the mail (RFC 8058 `List-Unsubscribe-Post`) and a confirmable page. The `unsubscribe` token resolves its originating template server-side from its bound `email_send` row; a request-supplied template is rejected. **From a marketing message it withdraws marketing consent only** — the waitlist place and giveaway entries stay (ADR-027). From a transactional message, or through "leave the waitlist" on the page, it writes one global suppression. An explicit leave also sets `status = unsubscribed` and stamps `unsubscribed_at` so draw eligibility ends. **Suppression and marketing consent are both re-checked at dispatch**, so a send already queued still stops.

The one-click POST takes `token` in the URL and `List-Unsubscribe=One-Click` as form data, with no Turnstile, JavaScript or browser `Origin` header. The single-use token authenticates this route; middleware keeps the normal origin check on other writes. The confirmation page uses a form POST carrying the same signed token and the explicit `message` or `leave_waitlist` intent. A failed transaction returns the standard `unavailable` (503) envelope on the API, or an honest retry form on the page; token consumption rolls back with the preference write and audit event.

### `POST /api/dsr/export` and `POST /api/dsr/delete`
Data-subject access and erasure. Both require a signed link sent to the address, both are audited, and deletion **anonymises rather than drops** rows whose absence would corrupt referral edges — the edge survives with its subject nulled, so counts stay defensible and no personal data remains. `docs/legal/compliance.md` carries the reasoning.

---

## Admin routes

All under `/api/admin/*`, all behind the fail-closed E5-03a authentication
middleware, all audited, all batch-capped. Every route file is declared in the
central admin-route registry; the generated registry test fails if a route is
added without registration and exercises each registration through the
middleware.

| Route | Purpose |
|---|---|
| `GET /api/admin/export.csv` | The list export. Streamed, batch-capped, audited with row count |
| `GET /api/admin/flags` · `POST /api/admin/flags` | Read and set campaign flags |
| `GET /api/admin/fraud?limit=…` · `POST /api/admin/fraud/:id` | Priority-ordered review queue (hard maximum 50); POST body is `{ "outcome": "dismissed" | "upheld" }`. Both outcomes use the authenticated actor and are audited. Upholding disqualifies once E5-05 adds that downstream transition |
| `POST /api/admin/draw` | Authenticated, audited draw commitment. Reconciles eligible entries, checks the top-20 review and listed bundle contents, closes entry inserts, and commits the non-voided snapshot hash and future drand round. Returns `202` with `{ draw: { id, state: "pending", target_round, target_round_at } }`. The maintenance worker verifies two relays, selects winners and ordered reserves, and publishes only after offline reproduction. A second active draw is refused. |
| `GET /api/admin/health` | Verification rate, snapshot age, queue depth, quota projections |

**Admin authentication is a single shared bearer credential plus TOTP, not a
user system.** Clients send `Authorization: Bearer <credential>` and the current
six-digit code in `X-Valstara-TOTP`. Both values are server-held secrets and are
never logged, audited or returned. There is one operator, exposed to routes as
the `admin.operator` audit actor. There is no password, session or permission
matrix. A missing or invalid factor returns the same `401 unauthorized`
envelope with `Cache-Control: no-store`.

---

## What is not built

No public API · no webhook *out* to third parties · no GraphQL · no versioned `/v1` prefix — this surface has exactly one consumer and a known end date, and versioning it would be ceremony.

Inbound provider webhooks (Resend and Brevo bounce/complaint events) are the exception and live at `/api/webhooks/{provider}`: **signature verified before parsing**, idempotent on the provider event id, and never trusted for anything but suppression state.
