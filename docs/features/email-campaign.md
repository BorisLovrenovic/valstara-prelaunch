# Feature: Email

## Summary
Seven transactional templates through **Resend on `send.valstara.com`**, and broadcasts through **Brevo on `mail.valstara.com`**. The split is failure isolation, not deliverability theory: a spam complaint on the marketing list must never stop new signups from being able to verify (ADR-009).

## Feature flag
`email.broadcast` — **default off** until domain authentication is verified end to end. **Transactional mail has no flag** — verification cannot be switched off.

## The seven transactional templates
1. **Verification** — the only mail an unverified row may receive, besides its reminders
2. **Verification reminder** — the ladder at +1h, +24h, +72h
3. **Welcome** — referral link, status link, trust-page link
4. **Milestone reached** — tier confirmation, and **plainly states which reward is settled and which is held**. Since E11.7-03 none is queued; one already queued renders the member's current coupon ladder, early access and the coupons' held condition (E11.7-04). The welcome mail carries the same ladder section
5. **Status link** — re-issued on request
6. **Giveaway entry receipt** — entries, and a link to the immutable global rules version that governs them
7. **Provisional winner notification** — status link, Section 9 response deadline and the governing rules-version link; E7-06 queues the record, E8-01 dispatches it and E8-03 renders it with a plain-text alternative from the copy layer

E8-03 supplies and registers all seven renderers. E8-03a queues welcome on first verification, milestone reached on each newly awarded tier, and one entry receipt per subscriber per rules revision on its first entry under that revision. Receipt queueing follows `giveaway.open`; welcome and milestone are transactional and have no flag. All three queue from the triggering transaction, with isolated queue failure so the event still commits. Later entries under the same revision appear on `/me` without a second receipt.

**The shared layout (E11.5-11).** Every transactional template, the two data-rights mails and the weekly update render through one 600px table layout: the text wordmark, the message's paragraphs and facts, one coral button for its main action, the other links as text (each a 44px tap target, E11.5-12), and a footer with the legal line, `support@valstara.com` and the unsubscribe link. Each template has a hidden inbox preheader from the copy layer. It is light by default, with a `prefers-color-scheme: dark` block where the client supports one. Colours and fonts are read from `tokens.css` at render time and inlined, so the HTML contains no `var(`, and the token file is still the single source. There are no images, remote resources, tracking pixels or rewritten links. The plain-text part carries the same paragraphs, facts, links and footer. `docs/brand/page-design.md#the-email-layout-e115-11` has the engineering detail.

Broadcasts (Brevo) are composed from a shared layout: the **weekly update** (including the top-10 block that is the leaderboard's fallback surface), and the **launch announcement**.

**E8-07 schedule (founder-authorised 2026-09-30):** The weekly update is scheduled for Tuesday 09:00 UTC through the validated `WEEKLY_SEND_UTC` configuration. The hourly maintenance run starts queueing at that time, in batches of at most 100, with business key `weekly:{ISO-8601 UTC week}:{subscriber_id}`. It resumes partial runs idempotently. Each queued payload contains only the persisted `snapshot_id` and a status-token ID; its send expires 24 hours after the scheduled time. A missed window, including an unrecorded previous week after restart, is durably marked skipped and raises P2, with no late send. Queueing requires `email.broadcast` and current verified, unsuppressed, marketing-consented status. Dispatch re-checks consent and suppression. The weekly HTML and plain text come from the shared email layout and show exact counts from the site's published snapshot ID; the site holds the recorded ID during the send window, including while `leaderboard.public` is off.

**Who receives what (ADR-027).** The weekly update and any other marketing go **only to verified, unsuppressed subscribers with current marketing consent**, re-checked at dispatch. The single launch-access notification that joining the waitlist promises goes to every verified, unsuppressed subscriber as a message they requested (the privacy audit, E11-05, confirms this classification). Unsubscribing from a marketing message withdraws marketing consent only; the person keeps their waitlist place and giveaway entries.

## The partner programme's milestone emails (E11.7-12)

- **The auto-invite** goes once to a member who reaches 10 confirmed, non-voided referrals, **only with current marketing consent** (ADR-027). It is a marketing message, so it is sent as a Brevo broadcast from `mail.valstara.com`, only while `email.broadcast` and `partners.enabled` are on. Dispatch re-checks verification, consent and suppression, and its unsubscribe withdraws marketing consent only. Its link opens `/partners/apply` with the member's email filled in. A member who already applied is not invited, and a void that drops a member below 10 neither re-sends nor retracts it.
- **The first-signup email** goes once to a partner when their first confirmed partner signup arrives, after their welcome. It is transactional (Resend), names no one, and stops at dispatch if the address is suppressed.

Both are queued by the maintenance worker in batches of at most 100 and are one email per business key (`docs/modules/email.md#partner-programme-contact-workflow`).

## The partner digest (E11.7-13)

The partner digest is **optional programme mail**, not marketing (D-071): a Brevo broadcast from `mail.valstara.com`, sent only to partners who chose optional partner programme emails in their dashboard, while `partners.enabled`, `partners.digest` and `email.broadcast` are on. Marketing consent is neither required nor checked; dispatch re-checks the partner's choice, their active status, verification and suppression instead. It reports the period that has just ended, monthly on the 1st by default or weekly on Monday by configuration, and carries counts only, the partner's rank and one founder note from a content file. Its unsubscribe turns off only the partner's optional-email choice. The full rules are in `docs/features/partner-programme.md#the-partner-digest` and `docs/modules/email.md#partner-programme-contact-workflow`.

## Partner announcements (E11.7-16)

The founder writes to every partner at once through a committed content file in `src/content/partner-announcements/` and the command `partners announce --id <id> [--dry-run]`, behind `partners.announcements`. An announcement is **optional programme mail like the digest**, not marketing: a Brevo broadcast from `mail.valstara.com` to exactly the digest's audience, with the same dispatch re-checks and the same unsubscribe, which turns off only the partner's optional-email choice. One email per partner per announcement, and every run is audited. A file is validated at build (a subject of at most 80 characters, at most 300 words, at most three links to the site's own pages, no image, HTML or merge field, the copy rules) and never changes once published. Contractual notices go through the contract route instead. The full rules are in `docs/features/partner-programme.md#partner-announcements` and `docs/modules/email.md#partner-programme-contact-workflow`.

## The founder note (E11.8-03)

**Founder decision, 2026-11-24.** The founder's own words reach members only as a short note in the weekly update, written in a content file and shipped by deploy. No Brevo-editor campaign is sent to members.

- **Feature flag:** `email.weekly_note`, **default off**. Off, no weekly run records a note and the weekly update is exactly what it was before E11.8-03. Dispatch reads it for every message: while it is off, messages carry no note, and switched back on within the same run, later messages carry the run's recorded note again.
- **The file.** One file per ISO-8601 week, `src/content/weekly-notes/YYYY-Www.md`, named for the week of its send. Plain prose of at most 120 words, in paragraphs, with at most one link, written as a site path (`[the Trust Ledger](/trust-ledger)`) so it is always on the site's own origin. No image, no HTML, no merge field and no personalisation of any kind, and no written web or email address, which mail clients would turn into a link. The copy rules and the forbidden-copy list apply. A file that breaks a rule fails the build (`scripts/ci/weekly-notes-check.ts`, before every build), and every read re-validates it.
- **The send.** When the flag is on and a note exists for the run's ISO week, every message of that run carries it in both the HTML and the plain-text part, through the shared layout, after the top-10 block and before the status link, headed "A note from the founder:". Its link is a text link. A week without a note sends the unchanged update, and a note for any other week is never used. The subject and preheader do not change.
- **One note per run.** When a run's queueing starts, it records the note's SHA-256 (`weekly_campaign_run.note_hash`, which the application cannot change). Dispatch renders only a deployed note with that hash. A note changed, removed or found invalid by a deploy during the send window is left out of the rest of that run, recorded once on the run, with a P3; restoring it does not bring it back. One run never mixes two notes.
- **Who receives it is unchanged.** Queueing and dispatch keep the E8-07 checks: `email.broadcast`, verified, unsuppressed and marketing-consented, re-checked at dispatch. A member who unsubscribes or is suppressed after queueing gets nothing, note or not.

## The referral reminder (E11.8-04)

**Founder decision, 2026-11-24.** A member who joined through another member's link or code is reminded in the welcome email that they can do the same. The storefront repeats the reminder in a day-7 email after launch, outside this repository.

- **Feature flag:** `email.referred_welcome_line`, **default off**. Off, the welcome email is exactly what it was before E11.8-04. Rendering reads it for every welcome email, so switching it takes effect without a deploy, including for welcome emails already queued.
- **Who gets the line.** A member whose referral edge is confirmed, not voided and points to another member, not a partner (no partner on the edge). It reads "You joined because a friend invited you. If you'd like to do the same, here's your own link.", from the copy layer, as its own paragraph in both the HTML and the plain-text part, placed directly before the member's own referral link.
- **Who does not.** A partner-referred member keeps the existing "You joined through {CODE}" line (E11.7-08) and never also gets this one. A member who joined directly gets neither. A member whose referral is voided, or still unconfirmed, gets no line.
- **It names no one.** The rendering reads only whether such an edge exists; no name, address, code or other detail of the referrer reaches the email (hard rule 11).
- **Nothing else changes.** The welcome email keeps its business key, its reference-only payload, its subject, preheader and links, and the dispatch re-checks.

## The SubSlush announcement
**Not part of this system (ADR-028).** The founder sends the one announcement to existing SubSlush customers manually. `subslush.com` is not authenticated in Resend or Brevo, no Valstara system sends from it, and the SubSlush list is not loaded into either provider. Recipients who want to join sign up through the normal double opt-in.

`send.valstara.com` warms on verification traffic — low volume, high engagement, near-zero complaints. SPF and DKIM per subdomain; DMARC `p=none` → `quarantine` as confidence builds.

## Edge cases and error states
Provider down → the row is committed; the send queues and retries with backoff. Free-tier cliff → **pre-empted, not handled**: Resend free is 100/day, Brevo free is 300/day, and both are upgraded **before the giveaway opens**. A daily projection against the cap alerts a week ahead. Bounce webhook missed → hourly reconciliation; a suppressed address could receive one more send, which is documented and accepted. Suppression written after queueing → **the dispatch path re-checks suppression**, so the send still stops. Rendering broken in one client → caught by the pre-send render pass, not by recipients.

The E8-09 projection uses the last seven complete UTC days, with zeroes for days without sends: busiest day plus seven times the positive least-squares daily slope. Brevo's forecast is at least its next eligible weekly audience. Accepted sends and seed probes count on their UTC acceptance day. A forecast at the configured cap raises a daily-deduplicated P2; an observed day at the cap raises P1. Both tiers default to free in server configuration, and `giveaway.open` cannot be enabled until the founder confirms both upgrades and configures paid tiers with caps above the free limits.

## Acceptance criteria
- [ ] **One email per business key**, enforced by a unique constraint — a retry never double-sends
- [ ] **Suppression is checked at dispatch, not only at queue time** — asserted by test
- [ ] Every mail to a verified subscriber carries the status link; every mail carries a working one-click unsubscribe (RFC 8058) and a plain-text alternative. Verification and verification-reminder mail have only the verify-link call to action and no status link (founder-authorised 2026-09-28)
- [ ] Transactional and broadcast use **different domains and different providers** — asserted by config test
- [ ] SPF, DKIM and DMARC verified per sending domain before the flag can be turned on
- [ ] Every template renders correctly in Gmail, Outlook, Apple Mail, GMX and Web.de — checked manually at E12-07 on messages delivered to the seed mailboxes (moved from E8-04, founder-authorised 2026-09-29)
- [ ] Weekly seed tests run into the four mailbox providers — Gmail, Outlook, GMX and Web.de — and their results are recorded. Apple Mail is a client, not a provider. The first live seed run is at E12-07, because live sending keys stay off local machines until then (founder-authorised 2026-09-29)
- [ ] **Quota projection alerts at a week's headroom**, per provider
- [ ] A send failure **never rolls back or blocks the subscriber write** — asserted by test

## Telemetry
Delivery, bounce and complaint rates per template and per domain; verification rate per mailbox provider; quota consumption against projection. Open and click tracking stay disabled in both provider accounts; the Brevo broadcast seed checks delivered mail for a tracking pixel or rewritten link (founder-authorised 2026-09-29).
