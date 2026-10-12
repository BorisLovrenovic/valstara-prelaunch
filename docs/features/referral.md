# Feature: Referral engine

## Summary
Every verified subscriber gets an unguessable referral code and a link. A referred person who verifies confirms the edge. Cheap rewards settle on confirmation; **milestone discounts are held until any one of the owner's confirmed referred people places a first order within 90 days after store launch** — the structural answer to referral fraud (ADR-012).

## Feature flag
`referral.enabled` — default on. Off stops new attribution; **existing edges are untouched and existing rewards still settle.**

## User flows
1. **Code** — generated at verification: unguessable, non-sequential, case-insensitive, collision-checked, and free of ambiguous characters.
2. **Attribution** — `?ref=` read server-side, signed into the form, validated on submit, written as a `referral_edge` in state `attributed`. **One edge per referred person, forever**, enforced by a unique constraint.
3. **Confirmation** — the referred person verifies → edge `confirmed` → `confirmed_referrals` recomputed → milestones evaluated.
4. **Rewards** — cheap (base and per-referral draw entries, tier progress, wave position) settle now. Both Tier 1 and Tier 2 retain settled tier progress/`wave_upgrade` alongside held 15% and 25% discounts respectively. No milestone reward is a draw entry.
5. **Settlement** — at handoff, eligible owners' held discounts are carried to the storefront with owner `email_normalised`, confirmed referral pairs, and a deadline 90 days after store launch. Both people in a pair must be in the export set. The storefront settles a discount when any one of the owner's confirmed referred people places a first order before that deadline, and voids unqualified discounts afterward. Disqualified owners' discounts are voided with audited reason `owner_disqualified`; suppressed or departed owners' with `owner_not_in_handoff`. Erasure removes awards under E9-05; marketing withdrawal alone does not bar an otherwise eligible owner. Legacy bonus-entry awards, if any, are voided with an audited reason before export, never deleted.

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
