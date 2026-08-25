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
