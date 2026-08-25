# Feature: Email

## Summary
Six transactional templates through **Resend on `send.valstara.com`**, broadcasts through **Brevo on `mail.valstara.com`**, and the SubSlush migration announcement through Brevo **from `subslush.com`**. The split is failure isolation, not deliverability theory: a spam complaint on the marketing list must never stop new signups from being able to verify (ADR-009, ADR-010).

## Feature flag
`email.broadcast` — **default off** until domain authentication is verified end to end. **Transactional mail has no flag** — verification cannot be switched off.

## The six transactional templates
1. **Verification** — the only mail an unverified row may receive, besides its reminders
2. **Verification reminder** — the ladder at +1h, +24h, +72h
3. **Welcome** — referral link, status link, trust-page link
4. **Milestone reached** — tier confirmation, and **plainly states which reward is settled and which is held**
5. **Status link** — re-issued on request
6. **Giveaway entry receipt** — entries, jurisdiction, and a link to the rules that govern them

Broadcasts (Brevo) are composed from a shared layout: the **weekly update** (including the top-10 block that is the leaderboard's fallback surface), the **launch announcement**, and the one-off **SubSlush migration send**.

## The migration send
**From `subslush.com`, not `valstara.com`.** That domain has history with those exact recipients; a rebrand email from an unrecognised domain is indistinguishable from phishing. `send.valstara.com` warms in parallel on verification traffic — low volume, high engagement, near-zero complaints. SPF and DKIM per subdomain; DMARC `p=none` → `quarantine`. **Staged by recency in batches, watching rates between them.** The ~100 addresses are validated first.

## Edge cases and error states
Provider down → the row is committed; the send queues and retries with backoff. Free-tier cliff → **pre-empted, not handled**: Resend free is 100/day, Brevo free is 300/day, and both are upgraded **before the giveaway opens**. A daily projection against the cap alerts a week ahead. Bounce webhook missed → hourly reconciliation; a suppressed address could receive one more send, which is documented and accepted. Suppression written after queueing → **the dispatch path re-checks suppression**, so the send still stops. Batch one of the migration send performs badly → **stop; do not send batch two.** Rendering broken in one client → caught by the pre-send render pass, not by recipients.

## Acceptance criteria
- [ ] **One email per business key**, enforced by a unique constraint — a retry never double-sends
- [ ] **Suppression is checked at dispatch, not only at queue time** — asserted by test
- [ ] Every mail carries a working one-click unsubscribe (RFC 8058) and a plain-text alternative
- [ ] Transactional and broadcast use **different domains and different providers** — asserted by config test
- [ ] **The migration send's `From` domain is `subslush.com`** — asserted, because getting this wrong once is unrecoverable
- [ ] SPF, DKIM and DMARC verified per sending domain before the flag can be turned on
- [ ] Every template renders correctly in Gmail, Outlook, Apple Mail, GMX and Web.de — evidenced
- [ ] Weekly seed tests run into those providers and their results are recorded
- [ ] **Quota projection alerts at a week's headroom**, per provider
- [ ] A send failure **never rolls back or blocks the subscriber write** — asserted by test

## Telemetry
Delivery, open, click, bounce and complaint rates per template and per domain; verification rate per mailbox provider; migration send performance per batch; quota consumption against projection.
