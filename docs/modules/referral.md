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
  signRef(code: string): string                        // for the hidden field
  verifyRef(signed: string): string | null             // null on tamper or expiry — never throws
  attribute(referredId: string, code: string): Promise<AttributeResult>
  confirm(referredId: string): Promise<void>           // called on verification
  rejectEdgesOf(referrerId: string, reason: RejectReason): Promise<number>
  recomputeCounters(limit: number): Promise<{ checked: number; corrected: number }>
}
```

## Rules
- **Codes are unguessable and non-sequential**, drawn from an unambiguous alphabet, collision-checked on write.
- **`?ref=` is read server-side on the rendering request** and returned as a signed, expiring field. There is no cookie, no `localStorage`, and no client-side attribution path anywhere in the codebase. This is what keeps the mechanic outside ePrivacy Article 5(3) — and it is also simply more reliable.
- **`verifyRef()` returns `null` rather than throwing.** A bad ref must never cost a signup.
- **One edge per referred person, forever** — a database unique constraint, not an application check.
- **Cheap rewards settle on confirmation; high-value rewards enter `held`** and settle only on a post-launch first order. **A verification alone can never settle a high-value reward** — this is the module's central invariant.
- **`confirmed_referrals` is derived from edges.** `recomputeCounters()` is idempotent and **alerts on any non-zero correction** — a silently repaired counter hides the bug that caused it.
- **Single level only.** No second-degree credit, no multi-level structure, no code path that walks a referral chain.

## Dependencies
`db`, `audit`, `giveaway` (entry accrual on confirmation), `flags`.

## Contract tests
Entropy and collision over a large generated sample · a tampered signed ref returns `null` · self-referral rejected and the signup still completes · duplicate edge rejected by the database · **seeded property test: `recomputeCounters()` is idempotent and matches the edges for any generated graph** · **a high-value reward cannot reach `settled` from a verification path** · rejecting a referrer's edges leaves referred subscribers' status unchanged.
