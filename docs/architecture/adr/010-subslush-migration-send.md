# ADR-010: The SubSlush migration send goes from `subslush.com`

- Status: Superseded by ADR-028 (2026-09-27)
- Date: 2026-08-25
- Deciders: founder

## Context
Roughly 100 existing SubSlush customers need to be told about the rebrand and invited onto the Valstara waitlist. It is one send, to the most valuable addresses in the campaign, and it cannot be repeated.

## Decision
**Send it from `subslush.com`, not from `valstara.com`.** That domain has history with these exact recipients. **A rebrand email from an unrecognised domain is indistinguishable from phishing** — the one failure mode a trust-positioned brand cannot afford.

Supporting decisions, all of which are part of this one:

- **Warm `send.valstara.com` in parallel on verification traffic** — low volume, high engagement, near-zero complaints. The best warming traffic available.
- **SPF and DKIM per subdomain; DMARC `p=none` → `quarantine`** as confidence builds.
- **Stage by recency in batches, watching rates between them.** Batch one performing badly means batch two does not send.
- **Validate the ~100 addresses first** — about $1.
- **Ask them to opt in rather than assuming it** (`docs/legal/compliance.md`).

## Alternatives rejected
- **From `valstara.com`** — an unrecognised domain announcing a rebrand, to people who have never received mail from it, is the exact shape of a phishing attempt.
- **From both** — doubles the surface for confusion and halves the recognition that makes it work.
- **Sending it all at once** — throws away the ability to stop after batch one, which is the only real control on an unrepeatable send.

## Consequences
`subslush.com` must have its own authentication records configured and verified. The send's `From` domain is a **constant with a test on it** (`docs/modules/email.md`), because getting it wrong once is unrecoverable.
