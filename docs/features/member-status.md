# Feature: Member status

## Summary
A signed, expiring link that shows a subscriber their own status — verified state, confirmed referrals, own rank, early access, access wave, referral coupons, giveaway entries and the current marketing preference. **No password, no session, no account** (ADR-011). This is cut-list item 3: if the schedule bites, the link is replaced by the same information in email.

## Feature flag
`member.dashboard` — default on. Off falls back to the status summary in the welcome and weekly emails.

## Shared referral status
`ReferralService.status(subscriberId)` is the sole computation for referral status. It returns the code-derived referral link, the exact stored confirmed count, the stored access window and the write-once verification-order window (E11.7-04; until then it also returned the retired tier and its milestone awards' states). E4-08 owns the existing computation only; it creates no customer-facing surface. **Founder-authorised 2026-09-21:** E6-05 adds the authenticated subscriber's own rank to this shared result, computed server-side against the referral ordering. The rank is personal `/me` content gated by `member.dashboard`, not part of the anonymised public snapshot and not gated by `leaderboard.public`.

The `/me` referral section is rendered by E6-05. The welcome and milestone email referral sections are rendered by E8-03, which also owns the final parity assertion proving that the email and page mappings consume the same status result. This ownership split is founder-authorised on 2026-09-14.

## User flows
**The coupon ladder (E11.7-04).** Every surface shows the ladder and wave 1
from the member's own confirmed count and the configuration, through one
presentation (`src/server/referral/ladder-presentation.ts`, copy in
`src/copy/referral-ladder.ts`):

- **The progress line**, in the founder's form: "Coupon 1: 30% · Coupon 2:
  10% · 2 more confirmed referrals to 15%." A member with no coupon sees "3
  more confirmed referrals to Coupon 1 at 5%."; a complete ladder ends "The
  ladder is complete."
- **The held condition** wherever a coupon is mentioned (ADR-012): "Coupons
  become usable once one of your referred friends places their first order,
  and last 5 years after launch." Each coupon row on `/me` also carries
  "Usable once one of your referred friends places their first order."
- **Early access** (founder, 2026-11-17; month amended 2026-11-22): in wave 1, "You're in wave 1, with
  early access from September 2027," and why — "as one of the first 1,000
  verified members" or "for reaching 3 confirmed referrals" (partner reasons
  arrive with E11.7-07); otherwise "You don't have early access yet. 2 more
  confirmed referrals and you get early access in September 2027." It applies the
  recompute's own rule to the member's state.
- The figures are the configuration's: `couponLadder`,
  `waveOneReferralThreshold`, `waveOneEarlyAccessMonth` and the wave-1 band
  of `accessWindowBands`. The coupons shown are computed from the confirmed
  count, which is what the recompute stores inside the same transaction.
  No scarcity wording is shown.

On `/verify`, the referral card's meter runs from the last ladder step
reached to the next, labelled with the progress line, and the card names what
that step brings: the coupon and, for a member not yet in wave 1 whose next
step reaches the wave-1 threshold, early access. On `/me`, the status card's
referral-tier fact is replaced by **Early access** ("September 2027" or "Not
yet"), the early-access line follows the facts, the referral card's meter is
`/verify`'s, and the rewards card ("Your coupons") lists each held coupon with
its percent and condition, or says what unlocks the first, and always ends
with the held condition. The welcome email and the milestone email (no longer
queued since E11.7-03) carry the same facts, progress line, early-access line
and held condition.

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

E11.5-11r restyles `/me` to the final-design canvas (`Me.dc.html`), and the
behaviour above stands except where the founder decided otherwise on
2026-11-11. **Giveaway entries are a fact on the status card**, not a card of
their own. The status card's facts are, in order: status, access wave, own
rank, confirmed referrals, early access (the referral tier until E11.7-04),
and giveaway entries when there is at least one. The referral card holds the link, Copy and Share, and the meter.
**The referral link is the wrapping read-only box used on `/verify`**, a
paragraph whose text is the whole link and whose `data-referral-url` is what
Copy referral link copies. Copy behaves as on `/verify`: the label
cross-fades to "Referral link copied." and back after `--copy-confirm-hold`,
the live region announces it, and a refused copy selects the box. Rewards are
rows, and each carries its state's word, icon and explanation. Settled is
filled ink with a check; held is an outlined badge with a clock, the outline a
real border so it survives forced colours. **The marketing switch** is still
the Turnstile-protected form posting `POST /api/me/marketing`, with the same
fields. It is drawn as the component library's switch, and its name is the
action ("Turn on marketing email" or "Turn off marketing email"). Only the
current action's label is ever in the page. On submit, the knob slides and
the "On" or "Off" word cross-fades. On success, the script sets the URL
fragment `#marketing-saved` and reloads. The reloaded page shows the route's
saved message in the notice under the switch, moves focus to it and removes
the fragment with `history.replaceState`. On an error the switch returns,
there is no reload, and the route's message shows in the same notice. There
is no query parameter and no storage. **The marketing, leave and recovery
Turnstile widgets render only when the check needs interaction**
(`data-appearance="interaction-only"`, as on the signup form). They take no
space otherwise. Leaving is still one plain action, set apart below the
cards, with no confirmation step and no plea.

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
