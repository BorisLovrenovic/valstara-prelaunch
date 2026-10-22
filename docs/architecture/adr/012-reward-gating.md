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
