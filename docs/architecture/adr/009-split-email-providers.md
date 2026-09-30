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

**E8-01 dispatch sequencing (founder-authorised 2026-09-27):** The email service takes injected provider and renderer registries. Missing registrations leave queued rows untouched and visible in a health count. E8-02 registers Resend and removes the legacy direct test sender; E8-03 registers the real renderers. Retry content is reconstructed from reference-only payloads and HMAC-derived token IDs under `EMAIL_TOKEN_SECRET`; only token hashes are stored. Secret rotation invalidates outstanding links.

**Domain-authentication signal (founder-authorised 2026-09-28):** E8-02 checks SPF, DKIM and DMARC at maintenance startup and exports a per-domain health result with sanitized reason codes and an injected-clock check time. A failed check raises P1 without blocking boot. E10-05 owns presenting that result alongside the later seed-test and quota results.

**Brevo wire behaviour (founder-authorised 2026-09-29):** A real Brevo SMTP API send preserved the application's bound RFC 8058 headers under `mail.valstara.com` DKIM, so Brevo uses the same one-click endpoint as Resend. The provider supplies both HTML and plain-text bodies because a text-only Brevo request delivered HTML-only. Open and click tracking stay disabled in both provider accounts; the delivered broadcast seed checks for pixel injection and link rewriting.

**Bounce/complaint boundary (founder-authorised 2026-09-30):** Resend inbound events use raw-body Svix verification and its sending-only key is never expanded to read access. Missing terminal events create a bounded, sanitized P2 dashboard-replay task after the configured gap window; an authenticated webhook failure raises P1, and weekly dashboard review covers complaints after delivery. Brevo uses a configured bearer token checked before body read, and its existing key reads transactional events and blocked contacts for hourly reconciliation. The two providers share only the application's global suppression table, checked again at dispatch.
