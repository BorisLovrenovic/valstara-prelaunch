# Feature: Admin

## Summary
The minimum an operator needs: the fraud review queue, campaign flags, the CSV export, the draw, and a health view. **Cut-list item 2 replaces the UI with SQL plus an export script** — so the routes are built thin and the value is in the data, not the interface.

## Feature flag
None. Admin routes are internal and are protected by authentication, not by a flag.

## User flows
1. **Health** — verification rate against baseline, leaderboard snapshot age, email queue depth, quota projections. **The one screen that answers "is the campaign silently broken".**
2. **Fraud queue** — open flags with their evidence; dismiss or uphold.
3. **Flags** — read and set campaign flags. This is the incident lever.
4. **Export** — the CSV, streamed and batch-capped, with the row count audited.
5. **Draw** — execute, verify reproduction, review the top 20, record winners.

## Edge cases and error states
Export requested during a spike → **streamed and batch-capped**; it must not hold the result set in memory on a box with hard limits and no swap. Flag set while a snapshot is mid-refresh → the next snapshot honours it; the flag is checked at read time as well as at build time. Draw executed twice → **the second execution is refused**; a draw is a one-time event with a recorded seed. Admin credential compromised → MFA is mandatory, every admin action is audited, and the audit log is append-only by database permission.

## Acceptance criteria
- [ ] Admin routes require authentication **with MFA active** — verified, not assumed
- [ ] **Every admin action is audited** with actor, subject and detail
- [ ] The export is streamed and batch-capped — asserted with a large seeded dataset
- [ ] The export set is exactly *verified, unsuppressed, not disqualified* — asserted by test against `docs/data/model.md`
- [ ] Setting a flag takes effect **without a deploy**, within the documented cache window
- [ ] A second draw execution is refused
- [ ] **No admin response contains a raw IP address or a token**

## Telemetry
Admin action counts by type, time from flag raised to reviewed, export frequency and row counts.
