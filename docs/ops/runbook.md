# Operational Runbook

Status: authoritative. Organised **by symptom**, because that is how a problem arrives. Every P1 row in `docs/architecture/fallbacks.md` has an entry here.

---

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

The rate-limit bucket purge uses the same P1 webhook but a seven-day retention
period. Confirm both the subscriber prefix hashes (90 days) and rate-limit
buckets (seven days) independently.

---

## "We need to stop everything"

In order: `signup.enabled` off → the form shows an honest paused message. `giveaway.open` off → no further accrual. `email.broadcast` off → no further sends. **None of these needs a deploy**, and each takes effect within the flag TTL. The site keeps serving its trust and legal pages, which is the state you want to be in while deciding what happened.

---

## Restore from backup

Follow the pgBackRest procedure. **Restore into a scratch container first and verify against known rows** — never restore over a live database as the first move. The restore timing is the RTO; record it.
