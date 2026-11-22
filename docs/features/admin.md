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
1. **Health** — verification rate against baseline, aggregate referral-attribution share against baseline, leaderboard snapshot age, email queue depth, domain authentication status (E8-02), seed-test results (E8-04), quota consumption and projection (E8-09), purge-job status, and open flag count. E8-02, E8-04 and E8-09 export their results; E10-05 owns this view and tests that every named metric is present (founder-authorised 2026-09-28). The attribution result is `disabled` with no evaluation or alert while `referral.enabled` is off (founder-authorised 2026-10-06). **The one screen that answers "is the campaign silently broken".**

   Purge status comes from `purge_job_run` (founder-authorised 2026-10-06), not an overdue-row count. It shows each existing purge job's last success, last outcome and rows purged; a job with no success or a success older than twice its schedule is `stale`. The five current jobs run daily, so the threshold is 48 hours; E11.7-05 added `partner_application_purge`. Run-record failures never stop the purge or change its existing failure alert.

   The maintenance heartbeat comes from `maintenance_heartbeat` (QA gate 7, G7-1-I2; founder decision 2026-11-13). It shows each worker loop's last beat, its age in seconds and its stale state: the scheduler cycle is stale after two hours without a beat and the email dispatch pass after two minutes, and a loop that has never beaten shows as stale. The app's watchdog raises one deduplicated P1 per stale episode; the view itself sends nothing.
2. **Fraud queue** — open flags with their evidence; dismiss or uphold.
3. **Flags** — read and set campaign flags. This is the incident lever.
4. **Export** — the CSV, streamed and batch-capped, with the row count audited.
5. **Draw** — execute, verify reproduction, review the top 20, record winners.
6. **Referral voids** (E11.7-02) — void or un-void one referral, with a reason. `POST /api/admin/referrals/void` and `POST /api/admin/referrals/unvoid` take `{ "subscriber_id": "<referred subscriber>", "reason": "<one line>" }`. The referral is identified by its referred person, because each person has at most one. A voided referral is kept with its reason, actor and time and counts nowhere: not in the referrer's confirmed count (counter repair included), `/me`, rank, the leaderboard snapshot, the handoff export's confirmed pairs or giveaway entitlement. Before the draw snapshot is committed, the void also voids that referral's giveaway entry and an un-void restores it; after commitment, the draw is never touched and still reproduces. An un-void restores every count exactly. Each is audited as `referral.voided` or `referral.unvoided` with the authenticated actor, the reason and the before and after values of the edge, the referrer's confirmed count and the entry. A void is refused for a rejected edge or an already voided one, an un-void for an edge that is not voided, and both while the referrer is disqualified, being erased or erased, so the disqualification decision stays exactly reversible. The reason is one line of 1–200 characters and is refused if it holds an email or IP address, so the edge and the audit log always agree.
7. **Partners** (E11.7-06; founder decisions D-052) — review applications, track the contract signed outside this system, and manage the partnership. All under `/api/admin/partners`, each audited with the authenticated actor:
   - `GET /api/admin/partners?status=&type=&since=&stale=true&after=` lists confirmed applications, at most 100 a page in `applied_at` order, continued with `after`. `since` (`YYYY-MM-DD`) filters on `applied_at`; `stale` keeps partners more than 14 days (`partnerStaleAfterMs`) in `applied`, `approved` or `contract_sent`. An unconfirmed application is never listed. Audited as `partner.listed` with the filters and the row count only.
   - `GET /api/admin/partners/:id` shows one partner: the application, the registered code, the contract record, the notes, the referral counts (confirmed, pending, voided and flagged, never counting a voided one as confirmed or pending), up to 50 flagged referrals by referred subscriber id (those whose referred member has an open fraud flag) and the last activity, the latest signup or confirmation among the partner's referrals. Audited as `partner.viewed` with the partner's id only.
   - `POST …/:id/approve` (`{ "code"? }`) re-runs the E11.7-01 code rules on `code` or the requested code. A refused code changes nothing and answers with the reason and up to three alternatives. An accepted code is registered in `referral_code`, inactive until activation (E11.7-07), and the partner moves `applied` → `approved`; the "approved" email is queued.
   - `POST …/:id/reject` (`{ "template"? true }`) moves `applied`, `approved` or `contract_sent` → `rejected`. The one "rejected" email is queued only with `template`; the audit records `template_requested` and `rejection_mail_queued`. A code registered at approval stays registered, inactive and never reissued.
   - `POST …/:id/contract-sent` (`approved` → `contract_sent`, records `contract_sent_at`) and `POST …/:id/contract-signed` (`{ "date", "version", "reference"? }`, `contract_sent` → `active`). The date is a calendar date, not in the future and not before the UTC day the contract went out; the version is a label of 1–50 letters, digits, dots, dashes or underscores; the reference is one line of 1–200 characters with no email or IP address.
   - `POST …/:id/pause` (`active` → `paused`), `…/terminate` (`active` or `paused` → `terminated`) and `…/reactivate` (`paused` → `active`).
   - `POST …/:id/type` (`{ "type", "university"? }`): `student_ambassador` requires a university of 1–200 characters; other types take none and leave the stored fields as they are.
   - `POST …/:id/note` (`{ "text" }`) replaces the one notes field, 1–2,000 characters, refused if it holds an email or IP address.
   - `GET /api/admin/partners/export.csv` streams the review-only CSV (below).
   - `POST /api/admin/partners/sync-brevo` runs one bounded pass of the automatic Brevo partner sync. The response and the `partner.brevo_synced` audit contain the outcome and counts only. The off flag returns a disabled result with zero counts. A missing configuration or a failed pass returns `503 unavailable` and raises the contact-sync P2 alert.

   Every transition writes its own audit action (`partner.approved`, `partner.rejected`, `partner.contract_sent`, `partner.contract_signed`, `partner.paused`, `partner.terminated`, `partner.reactivated`), and `type` and `note` write `partner.type_changed` and `partner.note_replaced`. Each records the before and after status, status time, type, code and contract record. The free-text personal fields (the university, the contract reference and the notes) are recorded only as their length and SHA-256, never as text, because the audit log is append-only and erasure cannot remove it. A command on an unknown, unconfirmed or purged partner, or from a status it does not apply to, is refused with `400 invalid_input` and changes nothing. **The database refuses every transition outside the eleven documented ones** (`docs/features/partner-programme.md#partner-lifecycle`), so a command could not move a partner elsewhere even if this check were wrong.

## The founder command line
`npm run admin -- <command>` (`src/server/admin/cli.ts`, E11.7-02) is the founder's client for the admin API. It sends the request over HTTPS to `ADMIN_API_ORIGIN` (default `https://valstara.com`; plain HTTP only to this machine), with the secret key as the bearer credential and the authenticator code in `X-Valstara-TOTP`, so it passes the same E5-03a boundary and the route writes the audit record. **It never connects to the database** and imports nothing but Node built-ins. **It holds no credential on disk:** the key comes from `ADMIN_CREDENTIAL` in the shell or a prompt without echo, and the authenticator code is asked for on every run and never read from an argument or the environment. Without a six-digit code it refuses and sends nothing. Commands:

- `referrals void <subscriber-id> --reason "<why>"`
- `referrals unvoid <subscriber-id> --reason "<why>"`
- `partners list [--status <status>] [--type <type>] [--since YYYY-MM-DD] [--stale] [--after <partner-id>]`
- `partners show <partner-id>`
- `partners approve <partner-id> [--code <CODE>]`
- `partners reject <partner-id> [--template]`
- `partners contract-sent <partner-id>`
- `partners contract-signed <partner-id> --date YYYY-MM-DD --version <version> [--reference "<signfree reference>"]`
- `partners pause <partner-id>`, `partners terminate <partner-id>`, `partners reactivate <partner-id>`
- `partners set-type <partner-id> <standard|student_ambassador|creator> [--university "<name>"]`
- `partners note <partner-id> --text "<notes>"`
- `partners export`, which streams the CSV to standard output as it arrives; redirect it (`npm run --silent admin -- partners export > partners.csv`). The command itself writes nothing to disk. Keep the file for review only.
- `partners sync-brevo` runs the server-side sync on demand, checking at most 500 candidates and completing any in-flight contact before returning. The maintenance worker continues with changes left for the next pass.

An unknown, repeated or valueless option is refused before anything is asked or sent (E11.7-06).

Later tickets add their commands to the same table in `cli.ts`. The campaign-flag CLI (`src/server/flags/cli.ts`) is separate: it runs inside the production image against the database, because flags have no HTTP route.

## Edge cases and error states
Export requested during a spike → **streamed and batch-capped**; it must not hold the result set in memory on a box with hard limits and no swap. Flag set while a snapshot is mid-refresh → the next snapshot honours it; the flag is checked at read time as well as at build time. Draw executed twice → **the second execution is refused**; a draw is a one-time event with a recorded seed. Admin credential compromised → MFA is mandatory, every admin action is audited, and the audit log is append-only by database permission.

`GET /api/admin/export.csv` reads one repeatable-read snapshot in pages of at most 500 rows, ordered by subscriber ID. It opens only after bearer and TOTP authentication. Before returning the first CSV byte, it records `export.run` with the authenticated actor and the snapshot's row count. If the audit write fails, the export fails closed. The response is `text/csv`, an attachment, and `no-store`; stream cancellation releases the database snapshot. The row set and CSV columns follow the launch-day handoff contract in `docs/data/model.md`.

`GET /api/admin/partners/export.csv` (E11.7-06, D-052 Q3) is the review-only CSV of contracted partners. Rows are partners in `active`, `paused` or `terminated` linked to a previously verified subscriber, with unpurged personal data and an unsuppressed address. Pending and completed erasures are excluded. Columns, in order: `EMAIL`, `EXT_ID` (the linked member's `email_normalised`, the external ID the Brevo contact sync and erasure already use), `PARTNER_ID`, `FULL_NAME`, `STATUS`, `PARTNER_TYPE`, `CODE`, `CONTRACT_SIGNED_AT` (`YYYY-MM-DD`), `CONTRACT_VERSION`, `CONFIRMED_REFERRALS` and `PENDING_REFERRALS` (confirmed and attributed referrals, never a voided one), and `MARKETING_CONSENT` (`true` or `false`). No country, application answers, notes or referred person's email or other data. It reads one repeatable-read snapshot in pages of at most 500 rows ordered by partner id, records `partner.exported` with the snapshot's row count before the first byte, fails closed if that audit cannot be written, and is `text/csv`, an attachment and `no-store`. Retire all manual Brevo uploads, including files generated before the change. The automatic partner sync uses the same fields and eligibility. E11.7-09 later applies the partner's email preference.

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
