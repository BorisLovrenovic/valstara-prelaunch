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

A path under `/api/` that matches no route gets the branded HTML 404 page, and an exception a route does not handle gets the branded HTML 500 page, served byte for byte from the prerendered file (E11.5-10). Neither carries the envelope, nor anything from the request or the failure.

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
Body: `email`, `turnstile_token`, optional `marketing_opt_in`, and optional `referral_capture` (the signed ref and UTM envelope). The landing hero also sends `referral_code` and `referral_prefill` while `referral.enabled` is on. Their precedence and validation follow ADR-008 and D-062.

**No country, region or other location is accepted** (ADR-026). A request that still carries `country` or `region` is handled exactly like one that does not, and neither value is stored. `marketing_opt_in` is the separate, optional, unticked marketing checkbox (ADR-027); its checked value is the version of the wording shown. The route accepts the current version and retained rendered versions from the copy layer, so a form left open across a wording deployment still submits. Ticked, it records a *pending* opt-in and the submitted version, replacing an earlier pending version on a repeat ticked submission. Verification copies the stored version into consent and clears both pending fields. Whether it is ticked never changes the response, the waitlist place or the giveaway.

Order of operations, and it is load-bearing: verify Turnstile → rate-limit → validate → **normalise the email** → blocklist and MX → upsert the subscriber and record a pending marketing opt-in if ticked → attribute the referral edge → run fraud signals (flag only) → queue the verification mail → respond. Giveaway entry happens at verification (E7-01, E7-03), not here.

Returns `{ status: "pending", message }`. An unknown or inactive typed override returns a neutral note in `message` and leaves a new signup unattributed. Given the same submitted referral inputs, the status code, response keys and values are identical whether the normalised address is unknown, pending or already verified. **Never returns a position, a count, a rank or an address-membership signal** — a public response cannot disclose another person's status.

Idempotent on `email_normalised`: a repeat signup for a `pending` row re-sends the verification mail subject to its own rate limit; a repeat for a `verified` row sends no second verification mail. Both return the same accepted response as an unknown address. Any status-link affordance is sent only to the submitted address, never returned by this route or rendered on its response page.

The signup prefix limit is five attempts per 15-minute window (two when Turnstile is unavailable). A 429 includes `Retry-After` in whole seconds until that prefix's window resets and copy rounded up to whole minutes. This is the honest wait time exercised in E11-01's hostile-prefix load run.

### `GET /verify?token=…` *(page route)*
Non-mutating: renders a confirmation form carrying the bearer token. Mail scanners and prefetchers can GET repeatedly without consuming it.

### `POST /verify` *(page route)*
Body: `token`. Token-authenticated and therefore exempt from Turnstile-first. Consumes the token and, in one transaction, sets `verified`, turns a pending marketing opt-in into consent (audited), confirms referral edges, settles cheap rewards, holds high-value rewards and assigns access windows, then renders the success page. **A replayed token renders the same success page**. Invalid and expired tokens render identical generic failure copy and the same request-new-link control.

### `POST /api/resend-verification`
Body: `email`, `turnstile_token`. Turnstile is verified first. Rate-limited hard: **one attempt per normalised address and five per hashed IP prefix in 15 minutes** (two per prefix when Turnstile is unavailable). **Always returns the same `200` response whether or not the address exists, is pending, or is already verified** — an enumeration oracle on a waitlist is a real leak. After rate limiting, the resend decision has a fixed **500 ms response deadline**: a response is held until that deadline, and work still unsettled then finishes without changing the identical accepted response. A pending address receives a fresh token and queued verification mail; a verified address receives neither.

### `POST /api/survey`
Body: the signed `status` token, question-set `version`, and the two answers. Either answer may be omitted to record a first-class skip. The bearer token is consumed before rate limiting or survey work; invalid and expired tokens return the same `token_invalid` response. Validated against the named versioned question set. Idempotent per subscriber — a resubmission replaces, and the replacement is audited. Limited to 10 attempts per subscriber and 20 per hashed IP prefix in 15 minutes. With `survey.enabled` off it returns an honest `unavailable` response and writes no survey answer.

### `GET /api/leaderboard`
Uses `Cache-Control: private, no-store` so erasure-pending handles are not retained by browser or intermediary caches. Returns the **anonymised top-10** snapshot: a deterministic SHA-256-derived display handle, confirmed referral count, rank, and the snapshot's `as_of` timestamp. **No email, country, referral code or subscriber ID.** Flagged and disqualified subscribers are excluded. Returns `503` with honest copy when `leaderboard.public` is off.

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

### `GET /partners/apply` and `POST /partners/apply` *(page route)*
Built by E11.7-05, behind `partners.enabled`. There is no `/api/` route: the page handles its own POST, as `/dsr` does, and renders every outcome on its task card. **The application** (no `token` field): Turnstile first, then the flag, then five submissions per hashed IP prefix in 15 minutes (two when Turnstile could not be confirmed, which also flags the subscriber `challenge_timeout`). Then the fields and the E11.7-01 code rules: a refused field or code answers `400` with the form re-rendered from what was typed, each field's reason, and up to three available codes, with no JavaScript. Then normalisation and signup's domain screen (`invalid_email` and `blocked_domain` refuse the email field). A new, a pending and a verified address, a member who already has a confirmed application, any other subscriber status, and a repeat inside the one-link-per-address window all receive the same `200` "check your email" answer at the shared 500 ms minimum; only a pending or verified member with no confirmed application gets a row and a confirmation link. **The confirmation** (`token` field): the single-use `partner_application` token is consumed first, in place of Turnstile; every attempt then spends five-per-15-minutes of its hashed IP prefix; a limited or paused attempt rolls the consume back. An unknown, expired, wrong-purpose or no-longer-confirmable link answers `400` with one message. `GET ?token=` renders an inert confirmation form and never consumes. `GET ?email=` (E11.7-12, the auto-invite's link) fills in the email field of an empty application form with that value, only when it is a well-formed address of at most 254 characters; anything else leaves the field empty. It fills no other field, stores nothing and authenticates nothing. Flag off: `200` with the paused message, and nothing is accepted or consumed. Responses are `private, no-store` with `Referrer-Policy: no-referrer`, and set no cookie.

### `GET /partners/dashboard?t=` and `POST /partners/dashboard` *(page route)*

GET authenticates only the current, signed, unexpired 30-day link of an active or paused partner. Invalid, cancelled, expired and terminated links all render the same recovery action. The page is `private, no-store`, `noindex`, and `no-referrer`, with no cookie. POST takes a fresh `settings_token`, `display_name` and three optional checkboxes (`confirm_leaderboard_name=yes` for names saved under earlier wording, `show_on_leaderboard=yes`, `nonessential_email_enabled=yes`). The signed token is bound to the disclosure version and the name settings shown on the form. A form issued under earlier wording or whose name settings differ from the current ones returns the existing expired-form response. The leaderboard is rendered through this authenticated GET. It consumes the purpose-bound token before rate limiting the attempt (five per hashed IP prefix in 15 minutes), and commits the settings and consumption together. Successful settings redirect with 303; an invalid action token returns 400, a limited attempt 429 and a paused or unavailable dashboard 503. D-064 retains the 403 origin check with a fallback exclusive to this POST for a valid Host, the literal `Origin: null` and `Sec-Fetch-Site: same-origin`.

`GET /partners/apply?operation=dashboard-recovery` renders the replacement request. POST on the same URL takes `email_address` and `turnstile_token`, without a dashboard bearer. Turnstile server verification precedes the flag, then five attempts per hashed IP prefix (two in the strict fallback) and one per normalised address in 15 minutes. For eligible and ineligible addresses the same conditional 200 applies after the same 500 ms minimum. A recognised active or paused partnership can get a replacement. The address bucket uses a keyed digest. The view's `strict-origin` policy supports native submissions under the usual origin guard without sending a URL path or query.

`GET /r/{CODE}` is the partner short link (E11.7-07). It returns an empty, `no-store` 302 to `/?ref={CODE}` for an eligible live partner code or to `/` otherwise. Signup rechecks the code through the existing signed-referral path.

### `POST /api/dsr/export` and `POST /api/dsr/delete`
Built by E9-05. Without `token`, both accept `email` and `turnstile_token`: verify Turnstile first, then limit to five requests per hashed IP prefix in 15 minutes; no address is copied into rate-limit storage. Unknown and known addresses receive the same acknowledgement at the 500 ms deadline; a request-storage failure raises a sanitized P1. A known address receives a purpose-bound, single-use link valid for 24 hours. `/dsr` GET renders an inert confirmation form; it never consumes the link. Since E11.5-11t the `/dsr` page also accepts these POSTs itself, at `/dsr?operation=export|delete` (founder decision 2026-11-12): it runs the same `createDsrService` logic and renders the outcome on the task card with the same status, or returns the same NDJSON attachment for a confirmed export. These two routes and their responses are unchanged.

With `token`, consume the matching purpose first, then limit confirmations per subscriber and hashed IP prefix to five in 15 minutes. Replays acknowledge without repeating fulfilment. Export streams subject-scoped NDJSON in 100-row pages with other people's identities redacted; request and fulfilment are audited. Erasure atomically audits the request and marks `erasure_pending`, stopping processing immediately. The maintenance job waits for Brevo DELETE success/404 before local erasure, suppression deletion, append-only ledger and fulfilment audit commit together. Referral edges survive with the subject endpoint nulled. No personal data remains outside the documented six-year award-record retention. Both routes are uncached and remain available independently of campaign flags. `docs/legal/compliance.md` and `docs/features/legal-and-dsr.md` carry the retention and recovery contract.

---

## Admin routes

All under `/api/admin/*`, all behind the fail-closed E5-03a authentication
middleware, all audited, all batch-capped. Every route file is declared in the
central admin-route registry; the generated registry test fails if a route is
added without registration and exercises each registration through the
middleware.

| Route | Purpose |
|---|---|
| `GET /api/admin/export.csv` | The list export. A `text/csv` attachment with the exact handoff fields in `docs/data/model.md`, streamed in 500-row pages from one repeatable-read snapshot. An `export.run` audit with actor and snapshot row count is committed before bytes are returned. `Cache-Control: no-store` |
| `GET /api/admin/fraud?limit=…` · `POST /api/admin/fraud/:id` | Priority-ordered review queue (hard maximum 50); POST body is `{ "outcome": "dismissed" | "upheld" }`. Both outcomes use the authenticated actor and are audited. Upholding disqualifies once E5-05 adds that downstream transition |
| `POST /api/admin/draw` | Authenticated, audited draw commitment. Reconciles eligible entries, checks the top-20 review and listed bundle contents, closes entry inserts, and commits the non-voided snapshot hash and future drand round. Returns `202` with `{ draw: { id, state: "pending", target_round, target_round_at } }`. The maintenance worker verifies two relays, selects winners and ordered reserves, and publishes only after offline reproduction. A second active draw is refused. |
| `POST /api/admin/referrals/void` · `POST /api/admin/referrals/unvoid` | Void or un-void one referral (E11.7-02). Body `{ "subscriber_id": "<referred subscriber UUID>", "reason": "<one line, 1–200 characters, no email or IP address>" }`, no other field. Returns `200` with `{ referral: { edge_id, referred_id, referrer_id, state, voided, voided_at, void_reason, voided_by }, referrer: { confirmed_referrals }, giveaway_entry }`, where `giveaway_entry` is `voided`, `restored`, `unchanged`, `none` or `draw_committed`. A malformed body, a refused reason, an unknown referral, a void of a rejected or voided edge, an un-void of an edge that is not voided, and either while the referrer is disqualified or erased all return `400 invalid_input` with a message from the copy layer. Audited as `referral.voided` / `referral.unvoided` with before and after values; `no-store` |
| `GET /api/admin/partners?status=&type=&since=&stale=true&after=` | List confirmed partner applications (E11.7-06), at most 100 a page in `applied_at` order, continued with `after` (the `next_after` of the previous page). Each parameter at most once; any other parameter is `400 invalid_input`. Returns `{ partners: [{ id, status, partner_type, full_name, email, code, requested_code, applied_at, status_changed_at, stale }], next_after }`. Audited as `partner.listed` with the filters and the row count; `no-store` |
| `GET /api/admin/partners/:id` | One partner (E11.7-06): `{ partner: { … application fields, code, code_active, contract record, notes, stale }, referrals: { confirmed, pending, voided, flagged, last_activity_at }, flagged_referrals: [{ referred_id, state, voided, flag_kinds }] }`, with at most 50 flagged referrals named by subscriber id only. Audited as `partner.viewed` with the id only; `no-store` |
| `POST /api/admin/partners/:id/approve` · `/reject` · `/contract-sent` · `/contract-signed` · `/pause` · `/terminate` · `/reactivate` · `/type` · `/note` | The founder's review and lifecycle commands (E11.7-06; `docs/features/admin.md#user-flows`). Bodies: approve `{ "code"? }`; reject `{ "template"? true }`; contract-signed `{ "date": "YYYY-MM-DD", "version", "reference"? }`; type `{ "type", "university"? }`; note `{ "text" }`; the others `{}`. Any other key is refused. Returns `200` with `{ partner: { id, before, after }, mail_queued }`, where `before` and `after` hold the status, status time, type, code and contract record, and `mail_queued` is `true` or `false` for approve and reject and `null` otherwise. A malformed body, an unknown, unconfirmed or purged partner, a command from a status it does not apply to, and a refused code all return `400 invalid_input` with a message from the copy layer; a refused code's message carries the reason and up to three alternatives. Each is audited with the actor. The note audit detail contains only the before and after note digests (length and SHA-256); the other commands record the before and after values. `no-store` |
| `GET /api/admin/partners/export.csv` | The review-only CSV of contracted partners (E11.7-06), excluding pending and completed erasures: the twelve columns in `docs/features/admin.md#edge-cases-and-error-states`, streamed in 500-row pages from one repeatable-read snapshot. A `partner.exported` audit with actor and row count is committed before bytes are returned. `text/csv` attachment, `Cache-Control: no-store` |
| `POST /api/admin/partners/announce` | Queue one partner announcement (E11.7-16; `docs/features/partner-programme.md#partner-announcements`). Body `{ "id": "<announcement id>", "dry_run"?: true }`, no other key. A dry run returns `200` with `{ announcement: { id, dry_run: true }, partners_due }` and queues nothing; a run returns `200` with `{ announcement: { id, dry_run: false }, queued, already_queued, remaining }`, where `remaining` partners are still due after the run's batch cap and a repeat call continues. A malformed body, an unknown id, a file that breaks the announcement rules (the message lists them) and any of `partners.enabled`, `partners.announcements` or `email.broadcast` off (the message names them) return `400 invalid_input` with a message from the copy layer, and nothing is queued. Every run is audited as `partner.announcement_run` with the actor, the id and the counts. Counts only; no partner is named. `no-store` |
| `GET /api/admin/trust-ledger/waitlist?month=YYYY-MM` | The Trust Ledger's waitlist figures for one calendar month in UTC (E11.8-01; `docs/features/trust-ledger.md#the-waitlist-figures`), read by `npm run trust-ledger -- draft`. The query is `month`, once, and nothing else. Returns `200` with `{ month, counted_at, verified_total, verified_in_month, verified_in_month_through_referral }`: verified subscribers when the request runs, those verified during the month, and those of them whose referral edge is confirmed and not voided (a member's or a partner's link or code). A malformed query or a month that has not begun returns `400 invalid_input` with a message from the copy layer. Every read is audited as `trust_ledger.waitlist_counted` with the actor, the month and the three counts, in the transaction that reads them. Counts only; no person is named. `no-store` |
| `GET /api/admin/reports/sources?from=YYYY-MM-DD&to=YYYY-MM-DD` | The per-platform signup report (E11.8-02; `docs/features/analytics.md#the-per-platform-signup-report-e118-02`), read by `npm run report:sources`. The query is `from` and `to`, each once, and nothing else: whole UTC days, both included, `to` on or after `from`. Returns `200` with `{ from, to, counted_at, rows: [{ source, medium, campaign, signups, verified_signups, confirmed_referrals, first_survey_completions }], without_utm: [{ bucket, … the four counts }], totals: { … the four counts }, row_count, retention }` for the signups created in the range. `source` and `medium` are a value on `config/utm-convention.json`, `other` or `(not set)`; `campaign` matches `^[a-z0-9-]{1,64}$` or is `other` or `(not set)`; `bucket` is `referral link or code` or `none`. No stored UTM text, email address, code or identifier is in the response. A malformed query or range, or a range holding more than 2,000 rows, returns `400 invalid_input` with a message from the copy layer, and is not audited. Every report is audited as `report.sources_counted` with the actor, the range and the row count, in the transaction that reads it. `no-store` |
| `GET /api/admin/health` | Verification and referral-attribution health, snapshot age, queue depth, domain authentication, seed tests, quota consumption and projection, persisted purge-job status, maintenance-worker heartbeat per loop, open flag count; `no-store` |

**Admin authentication is a single shared bearer credential plus TOTP, not a
user system.** Clients send `Authorization: Bearer <credential>` and the current
six-digit code in `X-Valstara-TOTP`. Both values are server-held secrets and are
never logged, audited or returned. There is one operator, exposed to routes as
the `admin.operator` audit actor. There is no password, session or permission
matrix. A missing or invalid factor returns the same `401 unauthorized`
envelope with `Cache-Control: no-store`.

**The founder command line** (`npm run admin -- <command>`, E11.7-02) is the
founder's client for these routes. It sends the bearer credential and a freshly
typed TOTP, never connects to the database and writes nothing to disk; the
partners export streams to standard output for the founder to redirect
(`docs/features/admin.md#the-founder-command-line`).

**Campaign flags have no HTTP route.** They are read and set with the audited
operator CLI, `node ./src/server/flags/cli.ts list` and
`node ./src/server/flags/cli.ts set <key> on|off --actor <operator>`, run inside
the production image as `docs/ops/runbook.md#setting-a-campaign-flag`
describes. Each change is audited with the named actor.

---

## What is not built

No public API · no webhook *out* to third parties · no GraphQL · no versioned `/v1` prefix — this surface has exactly one consumer and a known end date, and versioning it would be ceremony.

Inbound provider webhooks (Resend and Brevo bounce/complaint events) are the exception and live at `/api/webhooks/{provider}`: **provider authentication before parsing** (Resend raw-body Svix signature; Brevo bearer token before body read), idempotent on the Resend Svix event ID or Brevo SHA-256 of provider, message ID and event, and never trusted for anything but delivery and suppression state. No Brevo-managed unsubscribe event is accepted (founder-authorised 2026-09-30).
