# Operational Runbook

Status: authoritative. Organised **by symptom**, because that is how a problem arrives. Every P1 row in `docs/architecture/fallbacks.md` has an entry here.

---

## Unsubscribe failed to apply

A P1 `operator_task` alert with task `unsubscribe_apply_failed` means the unsubscribe transaction rolled back. Check database health first. When healthy, use the alert's `unsubscribe_token_id`, or `token_sha256` if the ID is null:

```sh
npm run email:apply-unsubscribe -- --token-id <unsubscribe_token_id> --actor <name>
npm run email:apply-unsubscribe -- --token-sha256 <token_sha256> --actor <name>
```

For `requested_action: leave_waitlist`, add `--action leave_waitlist` to the chosen command. For `message_unsubscribe`, omit that flag; the bound email send resolves whether the action withdraws marketing consent or suppresses all mail. `applied` means the preference or suppression, an explicit leave status change, and the audit event committed; `already` means a later retry applied the request and no further write occurred. Resolve this without undue delay. The alert contains a hash that identifies the token for later lookup, never the plaintext token or address.

## Resend webhook recovery

Every week, inspect the Resend dashboard's failed webhook deliveries for `https://valstara.com/api/webhooks/resend`. Replay any failed bounce, complaint or delivery event and confirm its `email_send` state and suppression outcome. An `email_webhook_ingest_failed` P1 means an authenticated event could not be stored; check database health and replay the failed delivery promptly. An `email_webhook_auth_failed` P2 means repeated signature failures; check the configured endpoint and signing-secret rotation. An `email_webhook_gap` P2 lists only `email_send` IDs and counts: find those sends in Resend, inspect their event timeline, and replay any missing event. A delivered message can receive a later complaint, so the absence of a gap is not proof that all complaint events arrived. Never copy an address, token, signature or provider payload into an alert or log.


## "Signups have stopped converting"

**The most important entry in this file, because it is the failure that hides.**

**Detect:** the hourly verification-rate check alerts against a rolling baseline. By default it compares the current 24-hour cohort with the preceding seven days once the cohort has 50 signups; a 50% relative-rate drop is P1. Do not wait to notice it on a dashboard.

**Notification path:** the maintenance process posts an authenticated JSON
notification to `P1_ALERT_WEBHOOK_URL`, which must terminate in the operator's
paging service. Production rejects a non-HTTPS or missing destination. A failed
delivery fails the maintenance job and restarts the process; it never falls back
to a log-only success. Drill this path against the configured receiver before
campaign open and confirm receipt outside the application.

**Diagnose, in this order:**
1. `GET /api/admin/health` — is the verification rate down, or is the *signup* rate down? A drop in signups is a marketing problem; a drop in the *ratio* is this one.
2. Check `email_send` for `queued` rows piling up — a stuck dispatcher.
3. Check `state = 'bounced'` and `complained` rates on `send.valstara.com`.
4. Run a seed test into Gmail, Outlook, GMX and Web.de. **Where does it land?**
5. Check Resend's status and the daily quota.

**Resolve:** a stuck queue drains once the dispatcher is restarted; the sends are idempotent, so nothing double-sends. **A deliverability problem is a business emergency** — pause broadcast sends immediately (`email.broadcast` off), verify SPF/DKIM/DMARC on the sending domain, and do not send anything else from that domain until the seed test lands in the inbox.

### Weekly seed placement alert

The maintenance process creates one seed record per UTC week and provider in
`email_seed_test`. It sends from `hello@send.valstara.com` once per provider
using `seed:<Monday UTC date>:<provider>` as the provider idempotency key, then
checks the configured spam and inbox IMAP folders hourly. The result is
`pending`, `inbox`, `spam` or `missing`. `missing` means no match after two hours;
polling continues, so a delayed inbox arrival updates the record. The table
contains a random message marker and placement timestamps, never mailbox
credentials or addresses. E10-05 displays `seedTestHealth()`. No credentials
or live send are used until E12-07.

`email_seed_placement_failed` is P1 for spam or missing; a mailbox, OAuth,
rotation-hook, database or sender error is reported as P1 `seed_test` maintenance
failure. Check the affected provider's seed mailbox and the Resend sending
domain's SPF, DKIM and DMARC. If spam or missing is real, turn
`email.broadcast` off and investigate delivery before sending more non-essential
mail. The Outlook refresh-token rotation hook must durably update the
production secret manager; if it fails, restore that hook or re-authorize the
account, then let the next hourly cycle retry. Do not enter seed credentials in
the repository or a local environment.

When `email.broadcast` is on, `email_broadcast_seed_test` also sends one Brevo
probe per mailbox and UTC week. It inspects the raw message for a genuine
plain-text MIME part, an injected tracking image and rewritten links.
`broadcast_seed_content_failed` and `broadcast_seed_test` maintenance failure
are P1. Turn `email.broadcast` off, confirm open and click tracking are disabled
in both provider accounts, inspect the affected mailbox and sending domain,
then allow the next hourly check to record a clean delivery. The first live
Brevo seed is E12-07's; local tests use injected messages.

`brevo_contact_sync_failed` is P2. Check Brevo availability and list
configuration, then leave the job to resume its bounded batches. PostgreSQL
consent and suppression stay authoritative; dispatch rechecks both even if
list removal is delayed. The alert contains no address.

---

## "Referral attribution dropped"

An hourly `referral_attribution_collapsed` P1 means the share of new signups
with a referral edge fell by at least the configured relative threshold from
the preceding seven-day baseline. The default needs 50 signups in the last
24 hours and a nonzero baseline before evaluating. Compare the aggregate
shares in `/api/admin/health`, then check that `referral.enabled` is on and
that a landing `?ref=` request produces a signed form field and an edge after
signup. When the flag is off, attribution health is `disabled` and no collapse
alert is sent. The alert carries shares only, never subscriber IDs or codes.

---

## "The leaderboard looks wrong"

**Diagnose:** compare `confirmed_referrals` against a live count from `referral_edge` for the top rows. Check the snapshot's `as_of` age. Check whether flagged accounts are appearing.

**Resolve:** run the counter repair job — it is idempotent and reports its corrections. **A non-zero correction is a bug to investigate, not a fix to celebrate.** If the board is being gamed and the answer is not immediate, **flip `leaderboard.public` off** ([command](#setting-a-campaign-flag)); the section disappears within the flag TTL with no deploy, and the weekly email's top-10 block becomes the surface.

---

## "Someone reports they never got their email"

Check `email_send` by `subscriber_id`: `queued` means the dispatcher; `sent` with no `delivered` means the provider or the recipient's server; `bounced` means the address; `suppressed` means they unsubscribed previously and **the correct answer is that we will not email them**.

Never resend by hand around the suppression check.

---

## "A signup is being flagged as fraudulent and it is a real person"

Open the flag in the review queue, read the evidence, and **dismiss it**. That is the workflow working — velocity flags on shared networks are expected. Dismissal is audited.

If a genuine person was disqualified, reversing it is also an audited action, and **the reversal restores the edges the disqualification rejected.**

---

## Voiding a single referral

When one referral is not genuine (a duplicate person, a test signup, a
household gaming the board) but the referrer is not being disqualified, void
that one referral from your own machine with the founder command line. It
calls the admin API; it never touches the database directly.

```sh
npm run admin -- referrals void <referred-subscriber-id> --reason "Same person as an earlier signup"
npm run admin -- referrals unvoid <referred-subscriber-id> --reason "Re-checked: two different people"
```

The subscriber id is the **referred** person's, because each person has at
most one referral. The command asks for the authenticator code every time, and
for the secret key unless `ADMIN_CREDENTIAL` is set in your shell; it writes
nothing to disk. The reason is required, one line of at most 200 characters,
and must not contain an email or IP address: it is kept on the edge and in the
append-only audit log.

A void takes the referral out of the referrer's confirmed count, `/me`, rank,
the next leaderboard snapshot, the handoff export and giveaway entitlement,
and is audited as `referral.voided` with before and after values. Before the
draw snapshot is committed it also voids that referral's giveaway entry, and
an un-void restores it. After commitment the draw is never touched. A referral
cannot be changed while its referrer is disqualified, being erased or erased:
reverse the disqualification first. A void also recomputes the referrer's
coupon ladder and wave 1 (E11.7-03): a coupon drops a step or to `void`, and
the referrer leaves wave 1 below 3 confirmed referrals unless their
verification order put them there. An un-void restores both, and the audit
record carries the referrer's coupons and wave before and after.

---

## Reviewing partners (E11.7-06)

Partner applications are reviewed, contracted and managed from your own machine
with the same founder command line. Every command calls the admin API, asks
for the authenticator code, and is audited with the actor and the before and
after values. Reads are audited too, with no personal data.

```sh
npm run admin -- partners list --stale                 # waiting more than 14 days
npm run admin -- partners list --status applied --since 2026-11-01
npm run admin -- partners show <partner-id>            # counts, flagged referrals, last activity
npm run admin -- partners approve <partner-id> [--code MAYA]
npm run admin -- partners reject <partner-id> [--template]
npm run admin -- partners contract-sent <partner-id>
npm run admin -- partners contract-signed <partner-id> --date 2026-11-22 --version v1 [--reference "<signfree reference>"]
npm run admin -- partners pause|reactivate|terminate <partner-id>
npm run admin -- partners set-type <partner-id> student_ambassador --university "<name>"
npm run admin -- partners note <partner-id> --text "<notes>"
npm run --silent admin -- partners export > partners.csv
npm run admin -- partners announce --id 2026-12-01-programme-news --dry-run
npm run admin -- partners announce --id 2026-12-01-programme-news
```

- **Approve** re-runs the code rules on the requested code, or on `--code`.
  A code taken, blocked or malformed since the application changes nothing and
  prints up to three available alternatives; approve again with `--code`. The
  code is registered inactive and goes live only at activation (E11.7-07).
  Approval queues the "approved" email.
- **Reject** sends the polite "rejected" email only with `--template`. It also
  closes an approved or contract-sent partner whose contract never went ahead.
  The registered code stays taken and inactive, and the person may apply again.
- **Contract-signed** records the signing date (not in the future, not before
  the contract went out), the version and an optional signfree reference, and
  makes the partner `active`. While `partners.enabled` is off, signing and
  reactivation still record their audited status changes. The maintenance
  worker resumes deferred activation effects in batches of up to 100
  after reopening. Pause and termination take the code out of use at once.
- **Only the documented transitions exist**, and the database refuses every
  other one: nothing leaves `rejected` or `terminated`. A paused partner can be
  terminated directly.
- **Notes** replace the single notes field (1–2,000 characters, no email or IP
  address). They are personal data: erasure and the purge clear them, and the
  audit records only their length and SHA-256.
- **`partners list --stale`** is the waiting-state check (standing rule 14):
  review it weekly. Nothing changes automatically.
- **The export** is for founder review only. It excludes suppressed addresses,
  pending and completed erasures, and purged records. Use `--silent` so npm's
  banner stays out of the CSV. Retire the Brevo dashboard upload, including
  any previously saved CSV. D-056 defers the dedicated partner sync.
  [Text-only spreadsheet import procedure](../features/admin.md#edge-cases-and-error-states)

### The partner digest (E11.7-13)

- **Before turning `partners.digest` on**, write the period's note in
  `src/content/partner-digest-note.json` (`{ "note": "…" }`) and deploy it
  through an ordinary pull request. The file ships with no note text, and an
  empty note skips the period.
- **The cadence** is `PARTNER_DIGEST_CADENCE` (`monthly` or `weekly`) and the
  send time `PARTNER_DIGEST_SEND_UTC` (`HH:MM`, UTC), passed to the app and
  maintenance services, which both validate them at boot. Changing either is a
  configuration change and a restart; any other value stops either service at
  boot. The new schedule applies from its next window.
- **A `partner_digest_period_skipped` P2** names the period and the reason:
  `missed_window` (the worker did not queue within the 24 hours after the send
  time) or `note_missing` (the note was empty when the run would start). The
  period is not sent late. Check the maintenance heartbeat for a missed window,
  or add the note before the next period.

### Partner announcements (E11.7-16)

- **Write the announcement** as a new file in
  `src/content/partner-announcements/`, `YYYY-MM-DD-<slug>.md`, with one
  `subject:` frontmatter line and plain prose (at most 300 words, at most
  three links written as site paths such as `/partners`). The build fails on a
  file that breaks a rule and names the rule. Merge and deploy it through an
  ordinary pull request. **A published file never changes:** CI refuses an
  edit or deletion, so a correction is a new announcement.
- **Never use an announcement for a contractual notice**, such as a change to
  a partner's terms. Those go through the contract route.
- **Send it** once `partners.announcements` is on (with `partners.enabled`
  and `email.broadcast`): run the dry run first, which prints how many
  partners it would reach and queues nothing, then the run. Both are audited
  as `partner.announcement_run`. A run reaches only partners who chose
  optional partner programme emails.
- **If the run reports partners remaining**, or stopped with an error, run the
  same command again: it queues only the partners still due, so nobody gets it
  twice. A refusal names its cause: an unknown id, a broken file, or the flags
  that are off.

### The founder note in the weekly update (E11.8-03)

- **Write the note** as `src/content/weekly-notes/YYYY-Www.md`, named for the
  ISO-8601 week of the Tuesday send it belongs to (for example `2026-W50.md`
  for the update sent on Tuesday 8 December 2026). Plain prose only: at most
  120 words and at most one link, written as a site path such as
  `/trust-ledger`. No image, HTML, merge field or greeting by name: every
  member receives the same words. The build fails on a file that breaks a rule
  and names the rule. Merge and **deploy it before the send time** through an
  ordinary pull request. A note for any other week is never used, so a late
  note waits for its own week or is renamed.
- **Turn `email.weekly_note` on** once (with `email.broadcast`). A run started
  while it is off carries no note, even if it is switched on later that week.
- **Do not edit a note during its send window** (from the send time until 24
  hours after). A run uses only the note it recorded when it started; if a
  deploy changes or removes that note mid-run, the rest of the run goes out
  without it and a `weekly_note_left_out` P3 log line names the week and the
  reason (`changed`, `missing` or `invalid`). Nothing is re-sent. Correct the
  note for next week instead.

---

## Publishing a Trust Ledger entry (E11.8-01)

Once a month, about 1–2 hours of the founder's time
(`docs/features/trust-ledger.md#the-monthly-entry`):

```sh
npm run trust-ledger -- draft --month 2026-12
```

- **Draft** in the month after the one reported, against the production admin
  API. The command asks for the authenticator code, reads the month's waitlist
  counts (audited as `trust_ledger.waitlist_counted`) and writes
  `src/content/trust-ledger/YYYY-MM.json` with every other section empty. It
  refuses a month that already has an entry, and never overwrites one.
- **Complete** every other section in the file, check the figures, and run
  `npm run build` (or `npx tsx scripts/ci/trust-ledger-check.ts`), which names
  any section still empty or inconsistent. Merge and deploy through an
  ordinary pull request. **A published entry never changes:** CI refuses an
  edit or deletion, so a mistake is corrected, dated, in the next entry.
- **A changed definition** in `src/content/trust-ledger-how-we-count.md` ships
  only with the new entry, whose `howWeCountChanges` section says what changed
  and why.
- **A serious wrong figure in a published entry:** set `trust_ledger.page` off
  ([Setting a campaign flag](#setting-a-campaign-flag)). The page answers 404
  within five seconds. The links on `/guarantee`, `/partners` and the footer
  stay until a deploy, leading to the 404; ship the correcting entry, then set
  the flag back on.

---

## Reading signups per platform (E11.8-02)

```sh
npm run report:sources -- --from 2026-12-01 --to 2026-12-31
npm run --silent report:sources -- --from 2026-12-01 --to 2026-12-31 --csv > sources.csv
```

- The command asks for the authenticator code and prints, for the signups
  created in those UTC days, signups, verified signups, confirmed referrals and
  first survey completions per source, medium and campaign
  (`docs/features/analytics.md#the-per-platform-signup-report-e118-02`). Each
  run is audited as `report.sources_counted`.
- **A platform shows as `other`:** its `utm_source` is not on
  `config/utm-convention.json`. Add it there (lower case) through an ordinary
  pull request; the stored values are re-read on the next run, so past signups
  move to the new row. A campaign shows as `other` when it is not lower-case
  letters, digits and hyphens: fix the link, not the report.
- **"That range holds more rows than one report prints":** choose a shorter
  range (at most 2,000 rows).
- UTM values are kept 12 months, so the report covers only signups whose
  values are still held.

---

## "The site is up but signups fail"

Almost always PostgreSQL. Check the health endpoint, the container, and memory headroom. **An OOM kill that recurs is a capacity signal, not a restart loop to tolerate** — the box runs with hard limits and no swap deliberately, so contention fails loudly.

Static pages continue serving from Cloudflare throughout, which means **the trust and legal pages stay readable during a database outage.** That is the intended behaviour, not a coincidence.

---

## "A deploy failed"

If it aborted at the health gate, the previous version is still serving and nothing is required. If it aborted on a **migration checksum mismatch**, a migration file was edited after it ran — restore the file to its applied content and treat the change as a new migration.

The PostgreSQL Compose health check probes the TCP listener on `127.0.0.1`, matching the connection type used by the migrator and app. A healthy database therefore means the final server accepts their connections, not just the temporary local socket used during first-time initialization.

**Rollback:** redeploy the previous release identifier. One command. Confirm the release identity **through the proxy**, not from the deploy script's own claim.

The five-minute objective is measured in E12-03; until that has run there is no measured RTO, so treat a rollback as taking as long as it takes and watch it.

---

## "The daily digest did not arrive"

**Alerting cannot alert about itself.** A missing digest is the documented signal that the alerting path is broken — check it before assuming a quiet day.

---

## "The IP retention purge failed"

**This is a compliance alert, not a hygiene one.** Run it manually, confirm the oldest remaining hash is inside 90 days, and record the gap. If the gap exceeded the retention period, it is recordable.

`GET /api/admin/health` shows the persisted last outcome, last success and
rows purged for the IP-prefix, rate-limit, verification/status-token and
leaderboard-snapshot purge jobs. A missing success or one older than 48 hours
is marked `stale`. This status comes from `purge_job_run`; it does not count
overdue rows. A record-write failure does not stop the purge, so investigate
the existing failure alert and the underlying tables when a status is stale.

The rate-limit bucket purge uses the same P1 webhook but a seven-day retention
period. Confirm both the subscriber prefix hashes (90 days) and rate-limit
buckets (seven days) independently.

---

## "The maintenance worker is stale"

A P1 `maintenance_heartbeat_stale` alert carries only `loop_key` and
`age_seconds`. It means the maintenance worker has not completed a pass of
that loop for over twice its interval: two minutes for `email_dispatch`, two
hours for `scheduler_cycle`. While the worker is down, verification mail,
reminders, snapshots, purges and erasures wait, and **both silent-failure
guards stop**. The app's watchdog sends one alert per episode; a second will
not come while it lasts.

1. Check the container: `docker compose -f infra/compose/docker-compose.production.yml ps maintenance`. An `unhealthy` status means its heartbeat file is over two minutes old. Compose does not restart an unhealthy container, so this alert is the signal to act.
2. Read its recent log for a sanitized error code: `docker compose -f infra/compose/docker-compose.production.yml logs --tail 100 maintenance`.
3. Restart it: `docker compose -f infra/compose/docker-compose.production.yml restart maintenance`.
4. Confirm recovery in `GET /api/admin/health`: `maintenanceHeartbeat` shows both loops with `stale: false` once each has beaten again. The scheduler cycle beats at the end of its first cycle after the restart. If the database itself is down, the worker cannot beat; follow "The site is up but signups fail".

Every job reads durable rows, so the work catches up when the worker runs
again: late, never lost.

---

## "We need to stop everything"

In order: `signup.enabled` off → the form shows an honest paused message. `giveaway.open` off → no further accrual. `email.broadcast` off → no further sends. **None of these needs a deploy**, and each takes effect within the flag TTL. The site keeps serving its trust and legal pages, which is the state you want to be in while deciding what happened.

Each lever is one command (see [Setting a campaign flag](#setting-a-campaign-flag)).

---

## Setting a campaign flag

Every incident lever above is a campaign flag, set with the audited flag CLI.
It runs inside the production image, in a one-off container that reuses the
maintenance service's database credentials and configuration, so no port is
opened and no extra credential is issued. Run from the production checkout on
the host, with the same environment the stack was started with:

```sh
docker compose -f infra/compose/docker-compose.production.yml run --rm --no-deps \
  maintenance node ./src/server/flags/cli.ts set leaderboard.public off --actor <operator>
docker compose -f infra/compose/docker-compose.production.yml run --rm --no-deps \
  maintenance node ./src/server/flags/cli.ts list
```

`set <key> on|off --actor <operator>` refuses an unregistered key or a missing
actor, and changes nothing. Every change goes through `FlagService.set()`,
which writes the override and a `flag.changed` audit record with the named
actor and the flag key as its subject in one transaction. The app and the
maintenance worker see the change within the five-second flag cache TTL; no
deploy and no restart is needed. Turning `giveaway.open` on still refuses, and
audits the refusal, while either email provider is on its free tier (E8-09).
There is no admin HTTP route for flags.

---

## Restore from backup

Follow the pgBackRest procedure. **Restore into a scratch container first and verify against known rows** — never restore over a live database as the first move. The restore timing is the RTO; record it.

**Erasure restore gate (founder-authorised 2026-10-02, E9-05).** A restored database must not serve traffic until the E9-05 erasure re-apply command has processed every ID from the **newest available erasure ledger**, not merely the ledger inside the restored backup. Keep the application and outbound workers isolated during recovery. Obtain the newest ledger, run the current forward migrations on the isolated restored database, re-apply the ledger, verify success and record the result before enabling traffic. If the newest ledger is unavailable or re-application fails, do not enable traffic. Re-application is idempotent and must be safe to repeat against a database where an erased subject still exists. The ledger contains only opaque subscriber IDs and erasure timestamps. E12-04 owns the scheduled off-host copy to R2.

Run with the restored application-role database selected by `DATABASE_URL`; the recovery command needs no provider or alert credentials:

```sh
npx tsx scripts/reapply-erasures.ts --ledger-file /secure/newest-erasure-ledger.jsonl --actor <operator>
```

The input is newline-delimited JSON, each line containing only `subscriber_id` (UUID) and `erased_at` (timestamp). The command imports and re-applies those IDs, then re-applies every ID already in the destination ledger, in bounded batches. An invalid file or failed transaction exits nonzero. Re-running is safe; this command makes no provider call. Use the newest available ledger even if it is newer than the backup. The off-host copy is E12-04's deliverable.

Existing pgBackRest backups are not edited for individual erasures. They remain encrypted and beyond use, never read for ordinary processing, until normal expiry (weekly full backups, `retention-full=2`), disclosed as up to 30 days. A recovery restore does not authorise returning erased data to service.


## Erasure requires operator completion

The final founder decision of 2026-10-02 replaces the earlier P2 fallback. Signed confirmation stops processing immediately but retains the subscriber's original address until Brevo confirms contact deletion. `dsr_erasure` contains only the opaque ID and retry timestamps/counts. Maintenance retries DELETE by `ext_id` for seven days with backoff capped at one hour; 404 is success. `dsr_erasure_operator_task` is P1 and contains only the opaque subscriber ID. Find that pending subscriber through the authenticated operator database connection, delete the contact in the Brevo dashboard, then attest that deletion by running:

```sh
npx tsx scripts/complete-erasure.ts --subscriber-id <uuid> --actor <operator>
```

The command requires a pending request and audits the actor. It atomically erases personal fields, deletes suppression, appends the erasure ledger and records fulfilment. Partner erasure also preserves each eligible friend's earned welcome discount and wave-1 place in the same transaction that clears the referral endpoints. The friend's own erasure removes that record. It is safe to repeat after success. Never place the email address in a command argument, log, alert or task. Do not widen the Resend key or call a Resend deletion API.

`dsr_deadline_operator_task` re-alerts P1 from day 28, daily until resolved. **The hard deadline is 30 days from confirmation:** act before it; an alert is not a deadline extension. A restart resumes unfinished requests from the original pending row. If the provider DELETE succeeded but local fulfilment failed, a repeated DELETE returning 404 permits completion. A fulfilment audit failure rolls back local erasure, so never mark an external task resolved until the command or worker succeeds.
