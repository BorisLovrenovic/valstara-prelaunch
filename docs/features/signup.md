# Feature: Signup

## Summary
One form, one required field. The visitor gives an email address, confirms a country, and passes an invisible challenge. Everything else the campaign knows about them arrives later, from verification and the survey. **The form is one of only three interactive islands on the site** (ADR-001).

## Feature flag
`signup.enabled` — default on. Off renders an honest paused message in place of the form, never a form that fails on submit.

## User flows
1. **Land** — from social, search, or a referral link carrying `?ref=CODE`. The referral code is read **server-side during the rendering request** and returned as a signed, expiring hidden field (ADR-008).
2. **Country** — a dropdown, pre-filled from `CF-IPCountry`, **always overridable**. The confirmed value drives giveaway eligibility, the VAT story and the access wave; detection never decides it silently.
3. **Region** — asked only where it changes eligibility. Currently Canada only, for Quebec.
4. **Submit** — Turnstile runs invisibly; the token is verified **server-side**.
5. **Response** — "any next step will arrive by email". The same accepted response covers a new, pending or verified address. **No position, no count, no rank and no membership signal.**

## Edge cases and error states
Address already `pending` → the verification mail re-sends, subject to its own rate limit, and the response is identical. Address already `verified` → the same accepted response and no second verification mail. The page never offers a status link based on that result; when the status-link email exists, that affordance is delivered only to the submitted address, so membership is disclosed only to the address owner. Disposable domain → rejected with plain copy naming the reason. No MX record → rejected; **an MX lookup timeout accepts and flags instead**, because a slow resolver must never cost a real signup. Turnstile fails → retry prompt. Turnstile provider times out → strict rate limiting and a review flag rather than an open door. Signed ref invalid or expired → **the signup proceeds without attribution**; the visitor did nothing wrong. Rate limit hit → an honest wait time, never a silent no-op that looks like success. JavaScript disabled → the form posts and works; the island only adds inline validation.

## Acceptance criteria
- [ ] Signup completes with **email and country only**
- [ ] Turnstile is verified **server-side** before any other work — asserted by test
- [ ] The email is **normalised before the uniqueness check**, and both the raw and normalised forms are stored
- [ ] `?ref=` is read on the server and returned signed; **no cookie and no client-side storage is involved** — asserted by test
- [ ] The country field is pre-filled and **still submits a different value when the visitor changes it**
- [ ] A double submission produces **one** subscriber, **one** referral edge and **one** verification email
- [ ] Unknown, pending and verified addresses receive the **identical accepted response**; membership is never disclosed by the page
- [ ] The response body contains **no position, count or rank**
- [ ] The form works with JavaScript disabled
- [ ] Every error path renders copy from the copy layer, in brand voice

## Telemetry
Form view, submit attempt, submit success by source and country, rejection reason mix, Turnstile failure rate, ref-carrying share of signups.
