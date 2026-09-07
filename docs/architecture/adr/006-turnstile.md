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

The provider-timeout "accept, strict-limit and flag" path records the flag as a `fraud_flag` of kind `challenge_timeout` (E3-03, founder-authorised 2026-09-07, migration `0005`). It is the one flag kind raised outside the fraud module; the fraud review queue treats it like any other.

**The client widget and the no-third-party-request property (Option A, founder-authorised 2026-09-08).** Turnstile is verified server-side, but its widget must also mount client-side, which loads `challenges.cloudflare.com/turnstile/v0/api.js` — an off-origin request from a rendered page. This is the second sanctioned rendered-page request after the flagged Trustpilot widget: the challenge is consent-free (no cookie, no fingerprinting, ADR-007) and Cloudflare already fronts the whole zone as the site's processor, so it is outside ePrivacy exactly as the cookieless analytics are (`docs/legal/compliance.md#3`). It is allowlisted in the third-party-request CI gate (`scripts/ci/privacy-allowlist.json`) for the signup form island only, and — unlike Trustpilot — carries **no flag**, because bot defence on the one public write route is always on. E3-05 mounts it invisibly (interaction-only, lazily on first interaction so the initial page stays inert); the public site key is `TURNSTILE_SITE_KEY` (a temporary placeholder until the founder provisions the real key; E12-05 swaps it in with the production secret).
