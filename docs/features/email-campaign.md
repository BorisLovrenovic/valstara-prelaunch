# Feature: Email

## Summary
Seven transactional templates through **Resend on `send.valstara.com`**, and broadcasts through **Brevo on `mail.valstara.com`**. The split is failure isolation, not deliverability theory: a spam complaint on the marketing list must never stop new signups from being able to verify (ADR-009).

## Feature flag
`email.broadcast` — **default off** until domain authentication is verified end to end. **Transactional mail has no flag** — verification cannot be switched off.

## The seven transactional templates
1. **Verification** — the only mail an unverified row may receive, besides its reminders
2. **Verification reminder** — the ladder at +1h, +24h, +72h
3. **Welcome** — referral link, status link, trust-page link
4. **Milestone reached** — tier confirmation, and **plainly states which reward is settled and which is held**
5. **Status link** — re-issued on request
6. **Giveaway entry receipt** — entries, and a link to the immutable global rules version that governs them
7. **Provisional winner notification** — status link, Section 9 response deadline and the governing rules-version link; E7-06 queues the record, E8-01 dispatches it and E8-03 renders it with a plain-text alternative from the copy layer

Broadcasts (Brevo) are composed from a shared layout: the **weekly update** (including the top-10 block that is the leaderboard's fallback surface), and the **launch announcement**.

**Who receives what (ADR-027).** The weekly update and any other marketing go **only to verified, unsuppressed subscribers with current marketing consent**, re-checked at dispatch. The single launch-access notification that joining the waitlist promises goes to every verified, unsuppressed subscriber as a message they requested (the privacy audit, E11-05, confirms this classification). Unsubscribing from a marketing message withdraws marketing consent only; the person keeps their waitlist place and giveaway entries.

## The SubSlush announcement
**Not part of this system (ADR-028).** The founder sends the one announcement to existing SubSlush customers manually. `subslush.com` is not authenticated in Resend or Brevo, no Valstara system sends from it, and the SubSlush list is not loaded into either provider. Recipients who want to join sign up through the normal double opt-in.

`send.valstara.com` warms on verification traffic — low volume, high engagement, near-zero complaints. SPF and DKIM per subdomain; DMARC `p=none` → `quarantine` as confidence builds.

## Edge cases and error states
Provider down → the row is committed; the send queues and retries with backoff. Free-tier cliff → **pre-empted, not handled**: Resend free is 100/day, Brevo free is 300/day, and both are upgraded **before the giveaway opens**. A daily projection against the cap alerts a week ahead. Bounce webhook missed → hourly reconciliation; a suppressed address could receive one more send, which is documented and accepted. Suppression written after queueing → **the dispatch path re-checks suppression**, so the send still stops. Rendering broken in one client → caught by the pre-send render pass, not by recipients.

## Acceptance criteria
- [ ] **One email per business key**, enforced by a unique constraint — a retry never double-sends
- [ ] **Suppression is checked at dispatch, not only at queue time** — asserted by test
- [ ] Every mail carries a working one-click unsubscribe (RFC 8058) and a plain-text alternative
- [ ] Transactional and broadcast use **different domains and different providers** — asserted by config test
- [ ] SPF, DKIM and DMARC verified per sending domain before the flag can be turned on
- [ ] Every template renders correctly in Gmail, Outlook, Apple Mail, GMX and Web.de — evidenced
- [ ] Weekly seed tests run into those providers and their results are recorded
- [ ] **Quota projection alerts at a week's headroom**, per provider
- [ ] A send failure **never rolls back or blocks the subscriber write** — asserted by test

## Telemetry
Delivery, open, click, bounce and complaint rates per template and per domain; verification rate per mailbox provider; quota consumption against projection.
