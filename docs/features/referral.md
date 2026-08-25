# Feature: Referral engine

## Summary
Every verified subscriber gets an unguessable referral code and a link. A referred person who verifies confirms the edge. Cheap rewards settle on confirmation; **high-value rewards are held until the referred person completes a first order after launch** — the structural answer to referral fraud (ADR-012).

## Feature flag
`referral.enabled` — default on. Off stops new attribution; **existing edges are untouched and existing rewards still settle.**

## User flows
1. **Code** — generated at verification: unguessable, non-sequential, case-insensitive, collision-checked, and free of ambiguous characters.
2. **Attribution** — `?ref=` read server-side, signed into the form, validated on submit, written as a `referral_edge` in state `attributed`. **One edge per referred person, forever**, enforced by a unique constraint.
3. **Confirmation** — the referred person verifies → edge `confirmed` → `confirmed_referrals` recomputed → milestones evaluated.
4. **Rewards** — cheap (draw entries, tier progress, wave position) settle now. High-value (large discounts, extra entries) enter `held`.
5. **Settlement** — a held reward settles only on a post-launch first order by the referred person; at campaign close, unsettled holds become `void` — recorded, not deleted, because the rule was published and must be checkable.

## Edge cases and error states
Self-referral → edge rejected with `self_referral`, flagged, **and the signup still succeeds.** Referred person already exists → no edge; the earlier row keeps its original `referred_by_id`, which is never reassigned. Referrer disqualified after edges exist → edges move to `rejected`; **the referred subscribers stay on the list** — nobody is punished for their referrer. Counter drifts from edges → the daily repair job recomputes from edges and **alerts on any non-zero delta**. Ref code that does not exist → signup proceeds without attribution. Ref field expired → same. Chain referrals → **single level only**; there is no second-degree credit and no multi-level structure, deliberately.

## Acceptance criteria
- [ ] Codes are unguessable and non-sequential — asserted by an entropy and collision test over a large generated sample
- [ ] **One edge per referred person**, enforced by a database unique constraint, not application logic
- [ ] `referred_by_id` is **write-once** — asserted at the schema level
- [ ] Self-referral is rejected and flagged, **and the signup still completes**
- [ ] Edges confirm **only** on the referred person's verification
- [ ] **`confirmed_referrals` is recomputable from edges**, and the repair job is idempotent — asserted by a seeded property test
- [ ] High-value rewards enter `held` and **cannot settle from a verification alone** — the anti-fraud invariant, asserted explicitly
- [ ] Disqualifying a referrer rejects their edges and **changes no referred subscriber's status**
- [ ] Only one referral level exists anywhere in the code

## Telemetry
Referral link share rate, attributed share of signups, confirmation rate per referrer, referrals-per-referrer distribution, held-versus-settled reward mix, rejection reason mix.
