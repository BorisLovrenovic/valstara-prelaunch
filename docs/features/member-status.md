# Feature: Member status

## Summary
A signed, expiring link that shows a subscriber their own status — verified state, confirmed referrals, tier, access wave, giveaway entries and eligibility. **No password, no session, no account** (ADR-011). This is cut-list item 3: if the schedule bites, the link is replaced by the same information in email.

## Feature flag
`member.dashboard` — default on. Off falls back to the status summary in the welcome and weekly emails.

## Shared referral status
`ReferralService.status(subscriberId)` is the sole computation for referral status. It returns the code-derived referral link, the exact stored confirmed count, the tier derived only from settled milestone awards, and each active reward's `settled` or `held` state. E4-08 owns the existing computation only; it creates no customer-facing surface. **Founder-authorised 2026-09-21:** E6-05 adds the authenticated subscriber's own rank to this shared result, computed server-side against the referral ordering. The rank is personal `/me` content gated by `member.dashboard`, not part of the anonymised public snapshot and not gated by `leaderboard.public`.

The `/me` referral section is rendered by E6-05. The welcome and milestone email referral sections are rendered by E8-03, which also owns the final parity assertion proving that the email and page mappings consume the same status result. This ownership split is founder-authorised on 2026-09-14.

## User flows
1. **Receive** — every transactional email carries the signed status link.
2. **View** — `/me?t=…` renders the bearer's own row, own rank and referral link, with a copy control.
3. **Act** — re-answer the survey, change country *(before eligibility is stamped)*, or unsubscribe.
4. **Refresh** — an expired link offers a Turnstile-protected, one-click re-send to the address it was issued for. E6-04 verifies the challenge server-side before recovery work and queues the `status_link` send request; E8-01/E8-03 own provider dispatch and the status-link template.

## Edge cases and error states
Token expired → a re-request page, never an error page. Token tampered → **the same re-request page**; the failure must not distinguish a forged token from an expired one. The recovery submission also returns the same acknowledgement whether the expired token was recognised or not. Link forwarded to someone else → they see the original subscriber's status. **This is an accepted risk, stated plainly**: possession of the bearer link is the authentication boundary; the alternative is a password on a waitlist, which costs more conversion than the exposure is worth, and the page carries nothing more sensitive than the subscriber's waitlist status. Country change after eligibility is stamped → **allowed for the record, but the giveaway eligibility already accrued does not change**, and the page says so.

## Acceptance criteria
- [ ] The link is signed and expiring; **a tampered token and an expired token produce the identical response**
- [ ] The page renders **only the bearer's own data** — asserted by test
- [ ] The page sets **no cookie and no session**
- [ ] Every transactional email carries a working status link
- [ ] Expired links can be re-requested in one click, rate-limited
- [ ] The flag-off path leaves the equivalent information in email — tested
- [ ] The `/me`, welcome-email and milestone-email referral sections render from `ReferralService.status`; E8-03 asserts cross-surface parity
- [ ] Own rank is computed server-side for the authenticated bearer through `ReferralService.status` and remains available independently of `leaderboard.public`

## Telemetry
Status-link click rate by email, repeat visits, referral-link copies from the page, unsubscribes originating here.
