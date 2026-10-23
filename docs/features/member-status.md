# Feature: Member status

## Summary
A signed, expiring link that shows a subscriber their own status — verified state, confirmed referrals, own rank, tier, access wave, giveaway entries and the current marketing preference. **No password, no session, no account** (ADR-011). This is cut-list item 3: if the schedule bites, the link is replaced by the same information in email.

## Feature flag
`member.dashboard` — default on. Off falls back to the status summary in the welcome and weekly emails.

## Shared referral status
`ReferralService.status(subscriberId)` is the sole computation for referral status. It returns the code-derived referral link, the exact stored confirmed count, the tier derived only from settled milestone awards, and each active reward's `settled` or `held` state. E4-08 owns the existing computation only; it creates no customer-facing surface. **Founder-authorised 2026-09-21:** E6-05 adds the authenticated subscriber's own rank to this shared result, computed server-side against the referral ordering. The rank is personal `/me` content gated by `member.dashboard`, not part of the anonymised public snapshot and not gated by `leaderboard.public`.

The `/me` referral section is rendered by E6-05. The welcome and milestone email referral sections are rendered by E8-03, which also owns the final parity assertion proving that the email and page mappings consume the same status result. This ownership split is founder-authorised on 2026-09-14.

## User flows
E11.5-07 renders the verification success page's access wave from the same
ReferralService.status result, independent of the milestone ladder. With
referrals enabled, it also renders the referral link, progress toward the
next enabled tier, and that tier's held or settled reward states. Reward
states of other tiers are not shown there; `/me` shows them. The
progress target and discount percentage come from the enabled milestone
ladder; with no enabled tier, no referral card renders. The existing signed
status link remains a secondary action.

E11.5-08 lays `/me` out as cards, in this order: status (verified state, the
access-wave badge and own rank); the referral card (link, copy, a native share
button only where `navigator.share` exists, confirmed referrals, tier and
progress to the next enabled tier from the ladder); rewards, where settled and
held each carry an icon, a text label and their own explanation, so neither
relies on colour; giveaway entries, only when the count is above zero;
preferences (the marketing control, styled as a switch but still the
Turnstile-protected form posting `POST /api/me/marketing`, and the survey
re-answer in a closed disclosure); data rights (the `/dsr` links); and leaving
the waitlist, set apart below the cards as one plain action with no
confirmation step. Every figure still comes from the one
`presentReferralStatus` result; the field keys only decide which card shows a
field. The recovery, left and disabled states are single cards.

1. **Receive** — every transactional email carries the signed status link.
2. **View** — `/me?t=…` renders the bearer's own row, own rank and referral link, with a copy control.
3. **Act** — re-answer the survey, switch marketing email on or off (ADR-027; switching off never affects the waitlist place or giveaway entries), or unsubscribe.
4. **Refresh** — an expired link offers a Turnstile-protected, one-click re-send to the address it was issued for. E6-04 verifies the challenge server-side before recovery work and queues the `status_link` send request; E8-01/E8-03 own provider dispatch and the status-link template.

## Edge cases and error states
Token expired → a re-request page, never an error page. Token tampered → **the same re-request page**; the failure must not distinguish a forged token from an expired one. The recovery submission also returns the same acknowledgement whether the expired token was recognised or not. Link forwarded to someone else → they see the original subscriber's status. **This is an accepted risk, stated plainly**: possession of the bearer link is the authentication boundary; the alternative is a password on a waitlist, which costs more conversion than the exposure is worth, and the page carries nothing more sensitive than the subscriber's waitlist status. Marketing switched off → broadcasts stop at the next dispatch; the waitlist place, referrals, wave and entries are untouched.

## Acceptance criteria
- [ ] The link is signed and expiring; **a tampered token and an expired token produce the identical response**
- [ ] The page renders **only the bearer's own data** — asserted by test
- [ ] The page sets **no cookie and no session**
- [ ] Every transactional email carries a working status link
- [ ] Expired links can be re-requested in one click, rate-limited
- [ ] The flag-off path leaves the equivalent information in email — tested
- [ ] The `/me`, welcome-email and milestone-email referral sections render from `ReferralService.status`; E8-03 asserts cross-surface parity
- [ ] The marketing on/off control is Turnstile-protected, audited, and **changes nothing but marketing consent** (S-01, ADR-027)
- [ ] No country or eligibility field is shown — the giveaway has no location-based eligibility (ADR-026)
- [ ] Own rank is computed server-side for the authenticated bearer through `ReferralService.status` and remains available independently of `leaderboard.public`

## Telemetry
Status-link click rate by email, repeat visits, referral-link copies from the page, unsubscribes originating here.
