# ADR-006: Cloudflare Turnstile for bot defence

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
A public write endpoint on the root domain of a brand about to launch, with a prize behind it. Bot signups corrupt every metric, burn email quota and make the handoff worthless.

## Decision
**Cloudflare Turnstile**, verified **server-side first on every public, unauthenticated write route**. A write authenticated by a single-use signed token consumes that token first, in place of Turnstile. Rate limiting applies to both kinds. This matches `docs/api/README.md` rule 2 (founder-authorised amendment 2026-09-28). `/api/unsubscribe` carries no `turnstile_token`; RFC 8058 one-click POSTs work without JavaScript. Turnstile is free, unmetered and already in the zone. The Article 5(3) no-banner basis is the rendered probe's confirmation that the widget performs no device storage/access. The site runs no device-fingerprinting API; Cloudflare still processes IP, TLS and user-agent signals server-side as a security processor.

Astro's built-in origin check rejects form POSTs without an `Origin` header before a route runs. RFC 8058 mail clients need that headerless POST, so E6-06 moves the equivalent check into application middleware for every other write route and exempts only `/api/unsubscribe`. The signed, single-use token authenticates that endpoint; an integration test covers the exception and the retained cross-origin rejection elsewhere.

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

**The client widget and the no-third-party-request property (Option A, founder-authorised 2026-09-08).** Turnstile is verified server-side, but its widget must also mount client-side, which loads `challenges.cloudflare.com/turnstile/v0/api.js` — an off-origin request from a rendered page. This is the second sanctioned rendered-page request after the flagged Trustpilot widget. Its precise Article 5(3) basis and Cloudflare's separate server-side processor activity are recorded in `docs/legal/compliance.md#cloudflare-turnstile-processor-disclosure`. It is allowlisted in the third-party-request CI gate (`scripts/ci/privacy-allowlist.json`) only for forms that submit to Turnstile-protected signup/resend routes and — unlike Trustpilot — carries **no flag**, because bot defence on public write routes is always on. The external API loader is present in rendered markup; the signup island defers only the invisible widget's `turnstile.render()` call until first interaction. The initial page has no widget frame or widget-driven layout shift, but it is not network-inert. The public site key is `TURNSTILE_SITE_KEY` (a temporary placeholder until the founder provisions the real key; E12-05 swaps it in with the production secret).

**E9-05 application:** `/dsr` loads the existing Turnstile script only for the unauthenticated email-request form. Its emailed-link confirmation has no third-party script: purpose-bound single-use token consumption authenticates the POST in place of Turnstile. Both paths are rate-limited by hashed IP prefix; no address enters the request limiter. GET never consumes.
