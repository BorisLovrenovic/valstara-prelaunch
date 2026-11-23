# ADR-008: Server-side referral attribution via a signed field, never a cookie

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Referral attribution conventionally uses a cookie: read `?ref=`, store it, read it back at signup. That is a device write, which brings ePrivacy Article 5(3) into scope, which brings a banner, which costs the conversion the referral mechanic exists to produce.

## Decision
**Capture `?ref=` and accepted UTM parameters server-side on the rendering request** and return them as a **signed, expiring hidden field** in the signup form. The envelope carries `{ ref, utm, iat, exp }`, uses HMAC-SHA256 with the server-only `REFERRAL_SIGNING_SECRET`, expires after 24 hours, and is verified with a constant-time comparison on submit.

There is no cookie, no `localStorage`, and **no client-side attribution path anywhere in the codebase.**

The service × market price pages (E11.6-10, founder decision D1 of 2026-11-17) are server-rendered on request for exactly this reason: each signs the same field from its own `?ref=` and UTM parameters, through the landing's own function, and a signup from one is attributed exactly as from `/`.

E11.7-07 adds the permanent server-side partner short link. A live, eligible code answers `302` to `/?ref={CODE}` with the registered uppercase code. Unavailable codes and the off flag answer `302` to `/`; redirects are never cached and add no browser script or storage write. Signup resolves the signed code again against current eligibility. A partner's member code continues to attribute as an ordinary member code while partner attribution is unavailable.

**E11.7-08 amendment (D-062).** The landing hero exposes a native, optional referral field under `referral.enabled`. The server prefills a registry-shaped code from the same request it signs and renders the original value beside it as hidden input. An untouched prefill requires a valid, unexpired signed capture for link attribution. The original-value field by itself grants no attribution. A replacement is first-party form input, resolved against the registry on the server after the existing challenge and rate limit. The replacement takes precedence even when unavailable, in which case signup succeeds with a neutral note and no edge. Clearing the prefill removes the referral. Signed UTM remains independent of code selection. The origin render cache substitutes the current request's signed field and both prefill values. Browser code submits the form as a whole. The existing write-once edge records `link` or `code`.

## Alternatives rejected
- **A first-party cookie** — brings Article 5(3) into scope and is arguably not "strictly necessary".
- **`localStorage`** — the same analysis, plus it fails when storage is blocked.
- **A URL parameter carried through to submit unsigned** — trivially forgeable, and a forgeable referral in a prize campaign is not a small problem.

## Consequences
**More reliable than a cookie, not less**: it survives blocked storage, cleared cookies, and privacy browsers, and it cannot be forged client-side. It does not survive a visitor who lands with `?ref=`, leaves, and returns days later through a bare URL — an accepted loss, and smaller than the cookie-blocked population it replaces.

`verifyRef()` **returns `null` rather than throwing**: a bad or expired ref must never cost a signup.

UTM capture accepts only `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` and `utm_term`; values are trimmed, control-character-free, capped at 128 characters, and capped at 512 serialized bytes. Unknown, empty and oversized values are dropped. Verified values are stored as `subscriber.utm` keys `source`, `medium`, `campaign`, `content`, `term`; they are analytics-only and never gate attribution or rewards.
