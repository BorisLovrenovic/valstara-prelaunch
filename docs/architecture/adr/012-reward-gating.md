# ADR-012: Reward gating — high-value rewards held to a post-launch first order

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Referral fraud on a giveaway is an economics problem before it is a detection problem. If a fake referral pays out on verification, someone will manufacture verifications, and no detection layer wins that race cheaply.

## Decision
**Confirm cheap rewards on verification. Hold milestone discounts until any one of the owner's confirmed referred people completes a first order within 90 days after store launch.** The store-launch instant is supplied at handoff.

Cheap: draw entries at the base rate, tier progress, wave position. High-value: anything with real money attached.

For held discounts, campaign close means handoff: the pre-launch repository exports eligible owners' rewards in state `held` with owner `email_normalised` and the qualification deadline, and audits `carried_to_storefront` for each. Confirmed referral pairs are exported only if both people are in the customer set. The storefront settles a discount when any one of those referred people places a first order before the deadline, or voids it after the deadline. A disqualified owner's held discount is voided with audited reason `owner_disqualified`; a suppressed or departed owner's is voided with audited reason `owner_not_in_handoff`. Erasure removes the award under E9-05. Marketing withdrawal alone does not affect an otherwise eligible owner's reward. Legacy bonus-entry milestone awards are already unqualifiable under the published rules and are voided in pre-launch with an audited reason, never deleted. Founder-authorised 2026-10-11.

## Amendment — the coupon ladder (E11.7-03, founder-authorised 2026-11-17)
**The coupon ladder replaces the milestone discounts, and the invariant stands.** The founder replaced ADR-025's milestone tiers with a ladder of up to three coupons (`docs/features/partner-programme.md#the-referrer-coupon-ladder-members-and-partners`). This amends the decision above as follows; where the text above says otherwise for discounts, this section wins.

- **A coupon is the high-value reward.** Every coupon is recorded here as `held`. The main platform makes **all** of a holder's coupons usable once **any one of the holder's confirmed referred friends places a first order**.
- **The five-year expiry replaces the 90-day qualification deadline.** A coupon expires five years after the configured public-launch date (`couponLadder.publicLaunchDate`, default 2027-09-01, so 2032-09-01). The founder sets the real date in that configuration at handoff, and the export carries the computed expiry. There is no store-launch handoff parameter any more.
- **Repository boundary.** A coupon's only states here are `held` and `void`, and its only transitions are `none → held`, `held → held` (a percent step), `held → void` (the confirmed, non-voided count fell below its unlock) and `void → held` (`couponTransitions`, `src/server/referral/reward-state.ts`). The database refuses `settled`. **Nothing in this repository moves a coupon to `settled`.** Coupons are entitlements: no checkout code is generated here.
- **Handoff.** E11-06 exports every held coupon whose owner is in the customer export set as a `held_coupon` record with its percent and expiry, and audits `handoff.coupon_carried` for each. A disqualified, suppressed or departed owner's coupons are not exported; erasure deletes them (E9-05); marketing withdrawal alone does not affect an otherwise eligible owner.
- **The milestone awards are retired**, voided with the reason `ladder_replaced` and never deleted (migration 0061). The confirmation path no longer creates `none → held` milestone discounts or `none → settled` wave upgrades; wave position is recomputed from the referral count instead (ADR-025, as amended). The cheap rewards that still settle on confirmation are the referral edge's own reward state and the draw entries.
- **The messaging rule stands.** Every surface that mentions a coupon says plainly that it is usable once one of the member's friends places a first order, and how long it lasts (E11.7-04). As built: "Coupons become usable once one of your referred friends places their first order, and last 5 years after launch." on `/verify`, `/me` and the referral emails, the landing card's shorter "Coupons apply once a referred friend places a first order, for 5 years after launch.", and each `/me` coupon row's "Usable once one of your referred friends places their first order." The expiry is the configured `expiryYears`; `test/ladder-copy-surfaces.test.mjs` asserts the condition on every surface.

## Alternatives rejected
- **Pay everything on verification** — makes fraud immediately profitable.
- **Pay everything post-order** — removes the motivation that makes the referral mechanic work at all during the campaign.
- **Detection-first: fingerprinting, ML scoring, aggressive auto-bans** — expensive, consent-implicating (ADR-013), and it punishes real people on shared networks. **Fraud is economics, not detection.**

## Consequences
**The single most valuable anti-fraud control in the campaign, and it costs almost nothing to build.** It also aligns the mechanic with the business: a referral is worth rewarding when it produces a customer.

It makes the reward state machine explicit — `none` → `settled` | `held` → `settled` | `void` — and creates one invariant worth testing directly: **a high-value reward can never reach `settled` from a verification path.**

**Repository boundary (founder-authorised 2026-09-13; amended 2026-10-11):** this pre-launch repository implements `none` → `settled` for cheap confirmation rewards and `none` → `held` for milestone discounts. It has no qualifying-order path and never reads or writes Medusa. The storefront is the authoritative order source and owns both `held` → `settled` and deadline-driven `held` → `void` after handoff. E11-06 carries every export-set owner's held discount with a store-launch-plus-90-days deadline and records each outcome before the waitlist database becomes read-only. It voids ineligible owners' discounts and legacy bonus-entry awards with audited reasons.

The messaging must be honest about it. The milestone email **plainly states which reward is settled and which is held**, because a reward a person believes they have and then does not receive is worse than one they knew was conditional.

E11.5-07's verification success card shows the configured next-tier discount
with its first-order condition in one line. When a tier has been reached, any
attained held or settled state comes from ReferralService.status; verification
page presentation does not settle rewards.
