# Module: referral

Kind: domain. Implements ADR-008 and ADR-012.

## Responsibility
Referral codes, the referral edge, tier and milestone computation, and reward state — including the hold that makes referral fraud unprofitable.

## Data owned
`referral_edge`, `milestone_award`; and it is the sole writer of `subscriber.confirmed_referrals` and `subscriber.referral_tier`.

## Exposed interface
```ts
interface ReferralService {
  generateCode(subscriberId: string): Promise<string>
  signRef(capture: ReferralCapture): string             // HMAC-SHA256, 24h hidden field
  verifyRef(signed: string | null): ReferralCapture | null // null on tamper or expiry — never throws
  attribute(referredId: string, code: string): Promise<AttributeResult>
  confirm(referredId: string): Promise<void>           // called on verification
  status(subscriberId: string): Promise<ReferralStatus>
  voidHeldRewardsAtCampaignClose(limit: number): Promise<{ voided: number }>
  backfillTier(tier: number, actor: string, limit: number): Promise<{ checked: number; awarded: number }>
  rejectEdgesOf(referrerId: string, reason: RejectReason): Promise<number>
  recomputeCounters(limit: number): Promise<{ checked: number; corrected: number }>
}
```

## Rules
- **Codes are unguessable and non-sequential**: 12 characters drawn without
  modulo bias from the 31-character CSPRNG-backed alphabet
  `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (more than 59 bits). Allocation is idempotent,
  limited to verified subscribers, collision-checked on write and backed by the
  database unique constraint. Lookup is case-insensitive.
- **`?ref=` and accepted UTM parameters are read server-side on the rendering request** and returned as one signed, HMAC-SHA256 field with a named 24-hour TTL. `REFERRAL_SIGNING_SECRET` is server-only and signatures are compared in constant time. There is no cookie, no `localStorage`, and no client-side attribution path anywhere in the codebase. This is what keeps the mechanic outside ePrivacy Article 5(3) — and it is also simply more reliable.
- UTM accepts only source, medium, campaign, content and term; values are trimmed, control-character-free, capped at 128 characters and 512 serialized bytes. Invalid values are dropped. It is analytics-only and never gates attribution or rewards.
- **`verifyRef()` returns `null` rather than throwing.** A bad ref must never cost a signup.
- **One edge per referred person, forever** — a database unique constraint, not an application check.
- **Cheap rewards settle on confirmation; high-value rewards enter `held`.** This repository implements the hold and campaign-close `void` transition only. The storefront is the authoritative post-launch order source and owns `held` → `settled` after handoff. **A verification alone can never settle a high-value reward** — this is the module's central invariant.
- A configured tier is awarded only by the confirmation that reaches its threshold. Enabling a tier after a subscriber has already passed that threshold is deliberately non-retroactive. Retroactive awards require the actor-named, batch-capped `backfillTier()` action, and every batch writes `referral.milestone_backfilled` to the audit log.
- **`referral_tier` is derived from the highest settled `milestone_award`.** Held awards do not raise it.
- **Referral status has one computation.** `status()` returns the code-derived referral link, the subscriber row's exact `confirmed_referrals` value without display transformation, the tier derived afresh from settled awards, and every active milestone reward with its `settled` or `held` state. E6-05 and E8-03 render this result; they do not recompute it. Founder-authorised 2026-09-14.
- **`confirmed_referrals` is derived from edges.** `recomputeCounters()` is idempotent, batch-capped at 1,000 and records every run in the append-only audit log. Its daily job sends a **P2** alert carrying the correction count for any non-zero correction — a silently repaired counter hides the bug that caused it. It locks each repaired subscriber row transactionally, so concurrent signup and verification work cannot be overwritten.
- **Single level only.** No second-degree credit, no multi-level structure, no code path that walks a referral chain.

## Configuration (ADR-025)
Values, not schema. Changing any of them requires no migration.

- **Base entry:** `1` on verification. **Per confirmed referral:** `+1` entry — cheap, settles on confirmation.
- **Tier ladder** (`milestone_award`, unique on `(subscriber_id, tier, reward_kind)`):
  - **Tier 1 — 3 confirmed referrals:** cheap settled = tier progress + `wave_upgrade`; **held** = 15% launch discount + `+5` bonus entries.
  - **Tier 2 — 5 confirmed referrals** (cut-list item 7, added mid-campaign, no migration): held = 25% discount + `+10` bonus entries.
- **Cheap vs high-value** follows ADR-012: base/per-referral entries, tier progress and wave position settle on confirmation; **milestone discount codes and milestone bonus entries are `held`**, then become `void` at campaign close if they remain in pre-launch. The classification is configuration, not schema.
- **Access-window bands** (assigned at verification — see `docs/data/model.md` `access_window`): base band by verification order `≤1,000 → wave-1 · ≤5,000 → wave-2 · ≤15,000 → wave-3 · else wave-4`, then each tier promotes one band toward `wave-1` (promotion only, audited).
  The count-and-assignment section is serialised, so concurrent verifications receive distinct ordinals at a band boundary. Every later promotion records `referral.access_window_promoted` with its previous and resulting tier and wave.

The held discount percentages (15% / 25%) are **confirmed production values** (ADR-025).

## Dependencies
`db`, `audit`, `fraud` (the E4-03 `self_referral` signal only), `giveaway` (entry accrual on confirmation), `flags`.

## Contract tests
Entropy and collision over a large generated sample · a tampered signed ref returns `null` · self-referral rejected and the signup still completes · duplicate edge rejected by the database · duplicate milestone award rejected by the database · a mid-campaign tier addition stays non-retroactive until an audited backfill · tier derives only from settled awards · referral status returns the exact stored count and active reward states · **seeded property test: `recomputeCounters()` is idempotent and matches the edges for any generated graph** · **a high-value reward cannot reach `settled` from a verification path** · rejecting a referrer's edges leaves referred subscribers' status unchanged.
