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

**Resolve:** run the counter repair job — it is idempotent and reports its corrections. **A non-zero correction is a bug to investigate, not a fix to celebrate.** If the board is being gamed and the answer is not immediate, **flip `leaderboard.public` off**; the section disappears within the flag TTL with no deploy, and the weekly email's top-10 block becomes the surface.

---

## "Someone reports they never got their email"

Check `email_send` by `subscriber_id`: `queued` means the dispatcher; `sent` with no `delivered` means the provider or the recipient's server; `bounced` means the address; `suppressed` means they unsubscribed previously and **the correct answer is that we will not email them**.

Never resend by hand around the suppression check.

---

## "A signup is being flagged as fraudulent and it is a real person"

Open the flag in the review queue, read the evidence, and **dismiss it**. That is the workflow working — velocity flags on shared networks are expected. Dismissal is audited.

If a genuine person was disqualified, reversing it is also an audited action, and **the reversal restores the edges the disqualification rejected.**

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

## "We need to stop everything"

In order: `signup.enabled` off → the form shows an honest paused message. `giveaway.open` off → no further accrual. `email.broadcast` off → no further sends. **None of these needs a deploy**, and each takes effect within the flag TTL. The site keeps serving its trust and legal pages, which is the state you want to be in while deciding what happened.

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

The command requires a pending request and audits the actor. It atomically erases personal fields, deletes suppression, appends the erasure ledger and records fulfilment. It is safe to repeat after success. Never place the email address in a command argument, log, alert or task. Do not widen the Resend key or call a Resend deletion API.

`dsr_deadline_operator_task` re-alerts P1 from day 28, daily until resolved. **The hard deadline is 30 days from confirmation:** act before it; an alert is not a deadline extension. A restart resumes unfinished requests from the original pending row. If the provider DELETE succeeded but local fulfilment failed, a repeated DELETE returning 404 permits completion. A fulfilment audit failure rolls back local erasure, so never mark an external task resolved until the command or worker succeeds.
