# ADR-009: Split email providers — Resend transactional, Brevo broadcast

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
The campaign sends two very different kinds of mail: verification, which must arrive or the funnel dies, and campaign mail, which will attract spam complaints because all campaign mail does.

## Decision
**Two providers on two subdomains.** Resend on `send.valstara.com` for transactional; Brevo on `mail.valstara.com` for broadcast.

**The rationale is failure isolation, not deliverability theory.** Spam complaints happen on the marketing list. If verification mail shares that reputation, new signups stop verifying, and **the funnel dies silently at the exact step being measured.**

**Brevo prices by emails sent, not contacts stored** — the right model for a list that balloons to 20k+ names receiving roughly six emails each. About $29/month at 20k emails with effectively unlimited contacts, against roughly $150/month on MailerLite for the same list. Add $9/month to remove the "Sent by Brevo" footer.

## Alternatives rejected
- **One provider for both** — the whole point is that they must not share a reputation.
- **Listmonk + SES** — saves roughly $90 across the campaign in exchange for SES production-access risk, self-built bounce and complaint handling, suppression-list legal exposure, and a **cold sending path on the single most valuable send of the campaign.**
- **MailerLite** — prices by contacts stored, which is the wrong shape for this list.

## Consequences
Two vendor integrations behind one interface (`docs/modules/email.md`), and a config test asserting the two never converge on one domain or provider.

**Free-tier cliffs must be pre-empted**: Resend free is 100/day, Brevo free is 300/day. **Upgrade before the giveaway opens, not when the limits hit** — a daily projection alerts at a week's headroom.

**E8-09 rule (founder-authorised 2026-09-30):** The projection takes seven complete UTC days per provider, filling absent days with zero, and calculates `highest daily total + 7 × max(0, least-squares daily slope)`. Brevo's forecast cannot be lower than the current verified, unsuppressed, marketing-consented audience. Count accepted outbox sends by acceptance time and both providers' seed sends by `sent_at`; do not count failures or contact sync. Forecast at or above the configured cap raises P2 once per provider per UTC day; an observed day at the cap raises P1. The health result exports tier, cap, daily consumption, forecast and alert state. `RESEND_TIER` and `BREVO_TIER` default to free and can be marked paid only after the founder verifies P5; a paid tier with a cap no higher than its free cap fails boot. `giveaway.open` enablement refuses and audits the actor while either tier is free, but disabling remains available. The clock is injected.

**E11-08 paid-cap decision (founder-authorised 2026-10-18):** Resend transactional Pro has 50,000 sends/month with no provider daily limit. Its internal `RESEND_DAILY_CAP=1600` is the 50,000 ÷ 30 steady-daily pace, rounded down. Brevo Starter at 5,000 sends/month has no provider daily limit; its internal `BREVO_DAILY_CAP=1000` is 5,000 ÷ 5 because the broadcast is one full-list send per week with at most five send days in a month. Brevo's earlier ÷ 30 instruction is superseded. Both caps are alert thresholds, not provider daily limits; the E8-09 paid-tier guard and free defaults remain unchanged. The E11-08 checklist records whether the account and audience evidence is sufficient to mark P5 complete.

**E8-01 dispatch sequencing (founder-authorised 2026-09-27):** The email service takes injected provider and renderer registries. Missing registrations leave queued rows untouched and visible in a health count. E8-02 registers Resend and removes the legacy direct test sender; E8-03 registers the real renderers. Retry content is reconstructed from reference-only payloads and HMAC-derived token IDs under `EMAIL_TOKEN_SECRET`; only token hashes are stored. Secret rotation invalidates outstanding links.

**Domain-authentication signal (founder-authorised 2026-09-28):** E8-02 checks SPF, DKIM and DMARC at maintenance startup and exports a per-domain health result with sanitized reason codes and an injected-clock check time. A failed check raises P1 without blocking boot. E10-05 owns presenting that result alongside the later seed-test and quota results.

**Brevo wire behaviour (founder-authorised 2026-09-29):** A real Brevo SMTP API send preserved the application's bound RFC 8058 headers under `mail.valstara.com` DKIM, so Brevo uses the same one-click endpoint as Resend. The provider supplies both HTML and plain-text bodies because a text-only Brevo request delivered HTML-only. Open and click tracking stay disabled in both provider accounts; the delivered broadcast seed checks for pixel injection and link rewriting.

**Bounce/complaint boundary (founder-authorised 2026-09-30):** Resend inbound events use raw-body Svix verification and its sending-only key is never expanded to read access. Missing terminal events create a bounded, sanitized P2 dashboard-replay task after the configured gap window; an authenticated webhook failure raises P1, and weekly dashboard review covers complaints after delivery. Brevo uses a configured bearer token checked before body read, and its existing key reads transactional events and blocked contacts for hourly reconciliation. The two providers share only the application's global suppression table, checked again at dispatch.

**E9-05 erasure (founder-authorised 2026-10-02):** Processing stops when the signed request commits. The original subscriber row supplies Brevo's `ext_id`; DELETE success or 404 permits atomic local erasure. Retry metadata contains only the opaque subscriber ID. Retry for up to seven days, then raise P1 for manual dashboard deletion and audited CLI completion; re-alert before the 30-day deadline. Resend has no deletion call and its sending-only key is unchanged. Both processors retain delivery logs for their limited processor retention periods. Delayed provider events cannot recreate suppression for an absent or erasure-pending subject.
