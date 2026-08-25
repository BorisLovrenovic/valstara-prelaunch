# ADR-008: Server-side referral attribution via a signed field, never a cookie

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Referral attribution conventionally uses a cookie: read `?ref=`, store it, read it back at signup. That is a device write, which brings ePrivacy Article 5(3) into scope, which brings a banner, which costs the conversion the referral mechanic exists to produce.

## Decision
**Capture `?ref=` server-side on the rendering request** and return it as a **signed, expiring hidden field** in the signup form. Verified server-side on submit.

There is no cookie, no `localStorage`, and **no client-side attribution path anywhere in the codebase.**

## Alternatives rejected
- **A first-party cookie** — brings Article 5(3) into scope and is arguably not "strictly necessary".
- **`localStorage`** — the same analysis, plus it fails when storage is blocked.
- **A URL parameter carried through to submit unsigned** — trivially forgeable, and a forgeable referral in a prize campaign is not a small problem.

## Consequences
**More reliable than a cookie, not less**: it survives blocked storage, cleared cookies, and privacy browsers, and it cannot be forged client-side. It does not survive a visitor who lands with `?ref=`, leaves, and returns days later through a bare URL — an accepted loss, and smaller than the cookie-blocked population it replaces.

`verifyRef()` **returns `null` rather than throwing**: a bad or expired ref must never cost a signup.
