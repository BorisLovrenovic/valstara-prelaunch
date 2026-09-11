# ADR-008: Server-side referral attribution via a signed field, never a cookie

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Referral attribution conventionally uses a cookie: read `?ref=`, store it, read it back at signup. That is a device write, which brings ePrivacy Article 5(3) into scope, which brings a banner, which costs the conversion the referral mechanic exists to produce.

## Decision
**Capture `?ref=` and accepted UTM parameters server-side on the rendering request** and return them as a **signed, expiring hidden field** in the signup form. The envelope carries `{ ref, utm, iat, exp }`, uses HMAC-SHA256 with the server-only `REFERRAL_SIGNING_SECRET`, expires after 24 hours, and is verified with a constant-time comparison on submit.

There is no cookie, no `localStorage`, and **no client-side attribution path anywhere in the codebase.**

## Alternatives rejected
- **A first-party cookie** — brings Article 5(3) into scope and is arguably not "strictly necessary".
- **`localStorage`** — the same analysis, plus it fails when storage is blocked.
- **A URL parameter carried through to submit unsigned** — trivially forgeable, and a forgeable referral in a prize campaign is not a small problem.

## Consequences
**More reliable than a cookie, not less**: it survives blocked storage, cleared cookies, and privacy browsers, and it cannot be forged client-side. It does not survive a visitor who lands with `?ref=`, leaves, and returns days later through a bare URL — an accepted loss, and smaller than the cookie-blocked population it replaces.

`verifyRef()` **returns `null` rather than throwing**: a bad or expired ref must never cost a signup.

UTM capture accepts only `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` and `utm_term`; values are trimmed, control-character-free, capped at 128 characters, and capped at 512 serialized bytes. Unknown, empty and oversized values are dropped. Verified values are stored as `subscriber.utm` keys `source`, `medium`, `campaign`, `content`, `term`; they are analytics-only and never gate attribution or rewards.
