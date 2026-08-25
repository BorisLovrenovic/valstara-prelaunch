# ADR-012: Reward gating — high-value rewards held to a post-launch first order

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Referral fraud on a giveaway is an economics problem before it is a detection problem. If a fake referral pays out on verification, someone will manufacture verifications, and no detection layer wins that race cheaply.

## Decision
**Confirm cheap rewards on verification. Hold high-value rewards — large discounts, extra draw entries — until the referred person completes a first order after launch.**

Cheap: draw entries at the base rate, tier progress, wave position. High-value: anything with real money attached.

Held rewards that never qualify become `void` at campaign close — **recorded, not deleted**, because the rule was published and must be checkable afterwards.

## Alternatives rejected
- **Pay everything on verification** — makes fraud immediately profitable.
- **Pay everything post-order** — removes the motivation that makes the referral mechanic work at all during the campaign.
- **Detection-first: fingerprinting, ML scoring, aggressive auto-bans** — expensive, consent-implicating (ADR-013), and it punishes real people on shared networks. **Fraud is economics, not detection.**

## Consequences
**The single most valuable anti-fraud control in the campaign, and it costs almost nothing to build.** It also aligns the mechanic with the business: a referral is worth rewarding when it produces a customer.

It makes the reward state machine explicit — `none` → `settled` | `held` → `settled` | `void` — and creates one invariant worth testing directly: **a high-value reward can never reach `settled` from a verification path.**

The messaging must be honest about it. The milestone email **plainly states which reward is settled and which is held**, because a reward a person believes they have and then does not receive is worse than one they knew was conditional.
