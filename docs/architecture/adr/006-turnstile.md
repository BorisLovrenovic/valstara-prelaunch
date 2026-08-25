# ADR-006: Cloudflare Turnstile for bot defence

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
A public write endpoint on the root domain of a brand about to launch, with a prize behind it. Bot signups corrupt every metric, burn email quota and make the handoff worthless.

## Decision
**Cloudflare Turnstile**, verified **server-side on every write route, before any other work.** Free, unmetered, already in the zone, and **consent-free** — which matters, because a challenge that fingerprints would cost the no-banner property (ADR-007).

Behaviour on failure is specified, because the two failure modes are different:

- **Invalid or replayed token → reject.** Fail closed.
- **Provider unreachable or timing out → accept, apply strict rate limits, and flag the row.** Rejecting real people because Cloudflare is slow is worse than admitting a few extra rows into a queue that double opt-in will filter anyway.

## Alternatives rejected
- **reCAPTCHA** — sets cookies and sends data to Google. Costs the banner-free property outright.
- **hCaptcha** — workable, but a second vendor and a second consent analysis for a capability already in the zone.
- **A honeypot field alone** — stops naive scripts and nothing else.
- **Nothing** — the prize makes this endpoint worth attacking.

## Consequences
Bot defence at no cost and no consent exposure. **Double opt-in remains the real filter** — a bot row that never verifies is never counted, never exported, and expires (ADR-011). Turnstile reduces the noise reaching that filter; it is not the filter.
