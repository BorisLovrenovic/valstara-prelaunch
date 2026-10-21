# Feature: Double opt-in

## Summary
A signup is not a subscriber until the address is confirmed. Nothing is counted, ranked, rewarded or broadcast to before that. **This is the boundary the entire campaign's honesty and deliverability rest on**, which is why it has no flag (ADR-011).

## Feature flag
None. It cannot be switched off.

## User flows
1. **Queue** — the verification mail is queued on the same request that creates the subscriber, idempotent on `verify:{subscriber_id}:{token_id}`.
2. **Token** — single use, **hashed at rest**; the plaintext exists only in the emailed URL. Default expiry 7 days.
3. **Confirm** — `GET /verify?token=…` renders an inert confirmation page; scanners and prefetchers cannot mutate state. Its token-authenticated `POST /verify` consumes the token, sets `verified`, confirms referral edges, settles cheap rewards, holds high-value rewards and assigns access windows in one transaction.
4. **Success page** — the referral link, the two survey questions, and the signed status link. This is the highest-attention moment in the funnel and is treated as such.
5. **Welcome mail** — referral link and status link, so the page is not the only place they exist.

## Edge cases and error states
Token replayed → **renders the same success page.** An already-verified person clicking twice is not a failure. Token expired or tampered → identical generic failure copy and the same request-new-link control through the enumeration-safe, rate-limited resend route; never a stack trace or another subscriber's data. Resend requested for an unknown address → **the same response as for a known one**; an enumeration oracle on a waitlist list is a real leak. Never verified → reminders at +1h, +24h and +72h, then the row **expires** at the configured horizon and is excluded from every count and export. Resend outage → the row is already committed; the send retries with backoff and the response says so honestly rather than claiming the mail has arrived.

## Acceptance criteria
- [ ] **No unverified row is counted, ranked, rewarded, exported or broadcast to** — asserted by a query-level test over every consuming surface
- [ ] The token plaintext is **never persisted** — only its SHA-256
- [ ] A **replayed token returns success**, not an error
- [ ] Exactly **one** verification email per token, enforced by the `business_key` unique constraint
- [ ] The reminder ladder fires at the documented offsets and **stops on verification** — asserted with an injected clock
- [ ] Unverified rows expire at the horizon and disappear from every count
- [ ] Resend-verification returns an **identical response for known and unknown addresses**
- [ ] **Verification rate is monitored hourly against a rolling baseline, and a collapse alerts P1**

## Telemetry
Verification rate by cohort and source, time-to-verify distribution, reminder attribution, expiry count, resend requests, per-mailbox-provider verification rate from the weekly seed tests.

## E11.5-07 verification page
The inert GET presents one confirmation card. Token-authenticated POST still
commits verification once, and a replay renders the same success state. The
success page shows the assigned access wave, the shared referral status and
configured tier ladder when referrals are enabled, the v2 survey when enabled,
and the bearer status link. Invalid and
expired tokens retain one generic message and the Turnstile-protected
request-new-link form. The page remains private and no-store.
