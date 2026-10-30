# Feature: Signup

## Summary
One form, one required field. The visitor gives an email address, may tick a separate marketing opt-in, and passes an invisible challenge. **No country or location is asked** (ADR-026). Everything else the campaign knows about them arrives later, from verification and the survey. **The form is one of only three interactive islands on the site** (ADR-001).

## Feature flag
`signup.enabled` — default on. Off renders an honest paused message in place of the form, never a form that fails on submit.

## User flows
1. **Land** — from social, search, or a referral link carrying `?ref=CODE`. The referral code is read **server-side during the rendering request** and returned as a signed, expiring hidden field (ADR-008).
2. **Marketing opt-in** — an optional, **unticked** checkbox with versioned wording, separate from the submit action. Retained rendered wording versions remain accepted when a form is left open across a deployment; the submitted version is recorded. It becomes consent only when the address is verified, and leaving it unticked changes nothing about the waitlist or the giveaway (ADR-027).
3. **Age** — the statement "Open to people aged 18 and over." sits next to the submit button. Age is confirmed with provisional giveaway winners at award time, never collected here.
4. **Submit** — Turnstile runs invisibly; the token is verified **server-side**.
5. **Response** — "any next step will arrive by email". The same accepted response covers a new, pending or verified address. **No position, no count, no rank and no membership signal.**

E11.5-06 presents that identical accepted response as a client-side check-your-inbox panel. It echoes only the address the visitor typed, conditionally describes the verification email, and offers a different-address control. After 60 seconds it offers resend through the existing `/api/resend-verification` route with a fresh Turnstile token. The route's acknowledgement is identical for unknown, pending and verified addresses. E11.5-11g styles every form state from the wireframes (`docs/brand/page-design.md`): field errors under the field, form-level messages as a focused notice above the label, a spinner in the disabled button while the security check or the request is in flight, the success and paused panels, and the neutral notice when JavaScript is disabled. The flow and its copy are unchanged.

At small widths (below 48rem), the same island has a server-hidden bottom signup bar that slides in once the hero form leaves view. It hides while the hero form or the footer is visible. The bar mirrors its email value with the hero input; only the hero input is named `email`, and the bar submits the existing form, including the untouched signed referral field and the optional hero marketing checkbox. A successful bar submission collapses to a closable one-row confirmation (`role="status"`), which follows the same hero and footer rules until it is closed. If the bar closes or hides with focus inside it, focus moves to the hero confirmation without scrolling. The bar has no separate challenge widget, form, script, storage or marketing checkbox. While it is visible, the page reserves its measured height as bottom padding and sets the scroll padding to that height plus 16px, so a focused element lands at least 16px clear of it. Its bottom padding respects `env(safe-area-inset-bottom)`. Without JavaScript or with `signup.enabled` off, it remains absent. The bar's layout is in `docs/brand/page-design.md` (E11.5-11h).

## Edge cases and error states
Address already `pending` → the verification mail re-sends, subject to its own rate limit, and the response is identical. Address already `verified` → the same accepted response and no second verification mail. The page never offers a status link based on that result; membership is disclosed only to the address owner. Turnstile fails or expires → an honest retry prompt and no request is sent without a valid token. Turnstile provider times out → strict rate limiting and a review flag rather than an open door. Rate limit hit → an honest wait time, never a silent no-op that looks like success. JavaScript disabled → the page and form render with an explicit enable-JavaScript notice; a native submission is rejected because Turnstile has no no-JS token path. Blocklist/MX decisions belong to E5, referral attribution to E4, fraud decisions to E5, and giveaway entry to E7.

## Acceptance criteria
- [ ] Signup completes with **email only** — no country, region or other location field exists (ADR-026)
- [ ] Turnstile is verified **server-side** before any other work — asserted by test
- [ ] The email is **normalised before the uniqueness check**, and both the raw and normalised forms are stored
- [ ] `?ref=` is read on the server and returned signed; **no cookie and no client-side storage is involved** — asserted by test
- [ ] The marketing opt-in renders **unticked**, and a ticked or unticked submission gets the identical response and the identical waitlist and giveaway treatment (ADR-027)
- [ ] The 18+ statement renders next to the submit button, from the copy layer
- [ ] A double submission produces **one** subscriber, **one** referral edge and **one** verification email
- [ ] Unknown, pending and verified addresses receive the **identical accepted response**; membership is never disclosed by the page
- [ ] The response body contains **no position, count or rank**
- [ ] With JavaScript disabled the form renders an enable-JavaScript notice and its missing/empty Turnstile token is rejected by the real route
- [ ] Every error path renders copy from the copy layer, in brand voice

## Telemetry
Form view, submit attempt, submit success by source, marketing opt-in rate, rejection reason mix, Turnstile failure rate, ref-carrying share of signups.
