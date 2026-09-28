# Feature: Admin

## Summary
The minimum an operator needs: the fraud review queue, campaign flags, the CSV export, the draw, and a health view. **Cut-list item 2 replaces the UI with SQL plus an export script** — so the routes are built thin and the value is in the data, not the interface.

## Feature flag
None. Admin routes are internal and are protected by authentication, not by a flag.

## Authentication boundary
E5-03a provides one stateless boundary for every `/api/admin/*` route: a
server-held operator bearer credential plus a six-digit TOTP in
`X-Valstara-TOTP`. Both are required on every request. There is one operator,
no user system, no permission matrix, no password and no session. Successful
authentication adds the fixed `admin.operator` actor to request locals; action
routes use that actor in their append-only audit record.

Every admin route is declared in the central registry in the same change that
adds its route file. A generated test reconciles the registry with the route
tree and sends both unauthenticated and authenticated requests through the
middleware. The initial protected probe is a test fixture, not a shipped route.
Authentication failures are generic, `no-store`, and never echo a credential,
TOTP, token, raw IP address or configuration detail.

## User flows
1. **Health** — verification rate against baseline, leaderboard snapshot age, email queue depth, domain authentication status (E8-02), seed-test results (E8-04), quota consumption and projection (E8-09), purge-job status, and open flag count. E8-02, E8-04 and E8-09 export their results; E10-05 owns this view and tests that every named metric is present (founder-authorised 2026-09-28). **The one screen that answers "is the campaign silently broken".**
2. **Fraud queue** — open flags with their evidence; dismiss or uphold.
3. **Flags** — read and set campaign flags. This is the incident lever.
4. **Export** — the CSV, streamed and batch-capped, with the row count audited.
5. **Draw** — execute, verify reproduction, review the top 20, record winners.

## Edge cases and error states
Export requested during a spike → **streamed and batch-capped**; it must not hold the result set in memory on a box with hard limits and no swap. Flag set while a snapshot is mid-refresh → the next snapshot honours it; the flag is checked at read time as well as at build time. Draw executed twice → **the second execution is refused**; a draw is a one-time event with a recorded seed. Admin credential compromised → MFA is mandatory, every admin action is audited, and the audit log is append-only by database permission.

## Acceptance criteria
- [ ] Admin routes require authentication **with MFA active** — verified, not assumed
- [ ] The route registry exactly covers the admin route tree; every registered route is exercised through the authentication middleware
- [ ] **Every admin action is audited** with actor, subject and detail
- [ ] The export is streamed and batch-capped — asserted with a large seeded dataset
- [ ] The export set is exactly *verified, unsuppressed, not disqualified* — asserted by test against `docs/data/model.md`
- [ ] Setting a flag takes effect **without a deploy**, within the documented cache window
- [ ] A second draw execution is refused
- [ ] **No admin response contains a raw IP address or a token**

## Telemetry
Admin action counts by type, time from flag raised to reviewed, export frequency and row counts.
