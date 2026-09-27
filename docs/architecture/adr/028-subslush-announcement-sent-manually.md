# ADR-028: The SubSlush announcement is sent manually, outside the Valstara email system

- Status: Accepted
- Date: 2026-09-27
- Deciders: founder
- Supersedes: ADR-010

## Context
ADR-010 had the pre-launch system send the one-off rebrand announcement to the ~100 existing SubSlush customers through Brevo, from `subslush.com`, as a staged, code-enforced send (ticket E8-08). That required authenticating `subslush.com` in a Valstara email provider and building a batch-gated send for a single email.

## Decision
**`subslush.com` is kept fully separate from Valstara.** Its domain, DNS records and email setup are not mixed with `valstara.com`, its DNS, or either Valstara email provider (Resend, Brevo). Neither provider authenticates `subslush.com`, and no Valstara system sends from it.

**The one announcement to existing SubSlush customers is sent manually by the founder**, outside the pre-launch system. The system builds nothing for it: no send path, no `From`-domain constant, no batch gate, and no import of the SubSlush address list into Resend or Brevo.

**What still holds:** the announcement invites recipients to join the Valstara waitlist rather than assuming their consent (`docs/legal/compliance.md#5-marketing-consent-and-the-subslush-list`). A recipient who wants in signs up through the normal double opt-in like anyone else.

## Alternatives rejected
- **ADR-010 as written** — builds and tests a staged send for one email, and ties `subslush.com` into Valstara's provider accounts.
- **A manual send through a Valstara provider** — rejected by the founder: `subslush.com` is not mixed with Valstara's providers.

## Consequences
- Ticket **E8-08 is removed** from the plan. E8 has nine tickets.
- **P1 covers two sending domains**, `send.valstara.com` (Resend) and `mail.valstara.com` (Brevo). Every "all sending domains" check (the campaign-open sequencing gate, E11-08, E12-07) means those two.
- The email module has **no migration `From`-domain constant or test**, and Brevo serves `mail.valstara.com` only.
- The announcement's deliverability and timing are the founder's responsibility and are not evidenced by any build gate.
