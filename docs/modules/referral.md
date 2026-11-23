# Module: referral

Kind: domain. Implements ADR-008 and ADR-012.

## Responsibility
Referral codes, the referral edge, the coupon ladder and wave 1 (E11.7-03, replacing the milestone tiers), and reward state — including the hold that makes referral fraud unprofitable.

## Data owned
`referral_code` (the shared code registry, E11.7-01), `referral_edge`, `milestone_award` (retired, E11.7-03), `referral_coupon` (E11.7-03); and it is the sole writer of `subscriber.confirmed_referrals`, `subscriber.referral_tier` and, after verification assigns it, `subscriber.access_window`.

## Exposed interface
```ts
interface ReferralService {
  generateCode(subscriberId: string): Promise<string>
  signRef(capture: ReferralCapture): string             // HMAC-SHA256, 24h hidden field
  verifyRef(signed: string | null): ReferralCapture | null // null on tamper or expiry — never throws
  attribute(referredId: string, code: string): Promise<AttributeResult>
  confirm(referredId: string): Promise<void>           // called on verification
  status(subscriberId: string): Promise<ReferralStatus>
  rejectEdgesOf(referrerId: string, reason: RejectReason): Promise<number>
  recomputeCounters(limit: number): Promise<{ checked: number; corrected: number }>
}

// src/server/referral/rewards.ts — the one recompute of a referrer's derived
// state (E11.7-03), called inside confirm(), every void and un-void, and
// recomputeCounters(). The caller holds the referrer's row lock.
function recomputeReferralRewards(
  connection: DatabaseConnection,
  subscriberId: string,
  options: { actor: string; now: Date; configuration?: ReferralRewardConfiguration },
): Promise<{ confirmedReferrals: number; coupons: RecomputedCoupon[]; accessWindow: AccessWindow | null; changed: boolean }>

// src/server/referral/code-registry.ts — the shared code registry (E11.7-01)
interface ReferralCodeRegistry {
  lookup(code: string): Promise<{ code: string; ownerKind: 'member' | 'partner'; ownerId: string | null; active: boolean } | null>
}

// src/server/referral/void.ts — voiding one referral (E11.7-02)
interface ReferralVoidService {
  voidReferral(referredId: string, reason: string, actor: string): Promise<ReferralVoidResult>
  unvoidReferral(referredId: string, reason: string, actor: string): Promise<ReferralVoidResult>
}
// ReferralVoidResult carries the edge, the referrer's recomputed confirmed count
// and giveawayEntry: 'voided' | 'restored' | 'unchanged' | 'none' | 'draw_committed'

// src/server/referral/partner-code.ts — the partner code rules (E11.7-01)
interface PartnerCodeRules {
  check(requested: string): Promise<
    | { outcome: 'available'; code: string }
    | { outcome: 'refused'; reason: 'format' | 'blocked' | 'taken'; alternatives: string[] }
  >
}
```

## Rules
- **Codes are unguessable and non-sequential**: 12 characters drawn without
  modulo bias from the 31-character CSPRNG-backed alphabet
  `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (more than 59 bits). Allocation is idempotent,
  limited to verified subscribers, collision-checked on write and backed by the
  database unique constraint. Lookup is case-insensitive.
- **Every code, member or partner, lives in one namespace: the `referral_code`
  registry** (E11.7-01, `docs/data/model.md#referral_code`). Codes are stored
  upper case under a primary key, so a partner code can never equal a member
  code and two codes differing only in case can never both exist. `generateCode()`
  locks the subscriber row, claims the registry row with `ON CONFLICT DO
  NOTHING`, then writes `subscriber.referral_code`, all in the caller's
  transaction; a taken code is regenerated without aborting it. A database
  trigger mirrors any other write of `subscriber.referral_code` and retires the
  code when erasure clears it. Member attribution (`attribute()`,
  `lookupCode()`) resolves only active **member** rows, so member links resolve
  exactly as they did before the registry; partner codes resolve for
  attribution from E11.7-07. `ReferralCodeRegistry.lookup()` returns any code's
  owner. Lookup upper-cases ASCII letters only, so it is case-insensitive
  without a locale-dependent case mapping.
- **Partner code rules** (`PartnerCodeRules.check()`, E11.7-01). Checked in this
  order, each refusing with its own reason:
  1. `format`: 4–16 of A–Z and 0–9 in any case, surrounding spaces ignored,
     stored upper case;
  2. `blocked`: `config/partner-code-blocklist.json`, validated when
     `partner-code.ts` loads, so a malformed list fails startup once a route
     imports it (E11.7-05). Its `brand`, `reserved` and `profanity`
     categories each hold `contains` terms (refuse any code that includes
     them) and `exact` terms (refuse only that
     whole code, for words that occur inside ordinary names, such as `NOTION`,
     `FREE` or `RAPE`). Terms are upper case, so a match ignores case. Every
     provider in `src/content/provider-showcase.json` is a brand term, by name
     with spaces and punctuation removed, reconciled by test;
  3. `taken`: the code is in the registry in any state, including a retired
     member code.

  A refusal carries up to three alternatives, each of which passed all three
  rules when checked. They are built first from the request's letters and
  digits with any contained blocklist term removed, then from the request as
  typed, by appending `1`, `2`, `3` … within 16 characters. Where nothing usable
  remains, they are random eight-character codes from the member-code alphabet.
  Availability is advisory, because the registry's primary key decides a race.
- **Partner codes are registered at approval** (E11.7-06, `docs/features/admin.md#user-flows`).
  `approve` runs `PartnerCodeRules.check()` again on the requested code or the
  founder's `--code`, then inserts the row with `ON CONFLICT DO NOTHING`; a
  refusal, or a race lost to another insert, changes nothing. The row enters
  inactive (D-044), one per partner. It stays registered after a reject, and
  when the partner's personal data is purged or erased a database trigger
  retires it (inactive, owner cleared), so a partner code is never reissued.
- **`?ref=` and accepted UTM parameters are read server-side on the rendering request** and returned as one signed, HMAC-SHA256 field with a named 24-hour TTL. `REFERRAL_SIGNING_SECRET` is server-only and signatures are compared in constant time. There is no cookie, no `localStorage`, and no client-side attribution path anywhere in the codebase. This is what keeps the mechanic outside ePrivacy Article 5(3) — and it is also simply more reliable.
- UTM accepts only source, medium, campaign, content and term; values are trimmed, control-character-free, capped at 128 characters and 512 serialized bytes. Invalid values are dropped. It is analytics-only and never gates attribution or rewards.
- **`verifyRef()` returns `null` rather than throwing.** A bad ref must never cost a signup.
- **One edge per referred person, forever** — a database unique constraint, not an application check.
- **Cheap rewards settle on confirmation; coupons are `held`.** The coupon ladder (E11.7-03, founder 2026-11-17) replaces ADR-025's milestone tiers. Coupons unlock at 3, 21 and 39 confirmed, non-voided referrals, start at 5%, rise 5% every 3 referrals and stop at 30%; the ladder ends when coupon 3 reaches 30%. A coupon's only states here are `held` and `void` (`couponTransitions`: `none → held`, `held → held`, `held → void`, `void → held`), and the database refuses `settled`. This repository carries every export-set owner's held coupons to the storefront with their normalised email key, confirmed referral pairs and the computed expiry, five years after the configured public-launch date. The main platform makes all of an owner's coupons usable once any one of the owner's confirmed referred friends places a first order. A disqualified, suppressed or departed owner's coupons are not exported; erasure deletes them (E9-05); marketing withdrawal alone does not bar an otherwise eligible owner. **A verification alone can never settle a high-value reward** — this is the module's central invariant.
- **The ladder and wave 1 are derived state with one recompute.** `recomputeReferralRewards()` reads the confirmed, non-voided count and rewrites `confirmed_referrals`, `referral_tier`, the owner's `referral_coupon` rows and `access_window`, writing only what differs. It runs in the transaction of every confirmation, every void and un-void, the daily repair and the handoff recompute (D-047), after the referrer's row lock, so concurrent confirmations and voids for one referrer serialise. A coupon row is created at its unlock and afterwards only changes percent or moves between `held` and `void`, so a void lowers or voids a coupon and an un-void restores it exactly.
- **Wave 1** (founder D1, 2026-11-17). Verification records `verification_order_window`, once, from ADR-025's bands; `wave-1` there is the first-1,000 place, which no void removes. `access_window` is that window, or `wave-1` while the member has 3 or more confirmed, non-voided referrals or an eligible partner reason applies (E11.7-07). It is recalculated up to handoff, so dropping below 3 returns the member to their verification-order window. Every change writes `referral.access_window_recalculated` with the count, the windows before and after, and the actor. The recorded window is write-once in the database.
- **The milestone tiers are retired** (E11.7-03). Migration 0061 voided every award with `ladder_replaced` and audited each one; none was deleted. No confirmation awards a tier, the tier backfill is removed, the application role can no longer insert an award, and no milestone email is queued.
- **`referral_tier` is derived from the highest settled `milestone_award`.** Held awards do not raise it, and since every award is void it is 0.
- **Referral status has one computation.** `status()` returns the code-derived referral link, the subscriber row's exact `confirmed_referrals` value without display transformation, the tier derived afresh from settled awards, and every active milestone reward with its `settled` or `held` state. E6-05 extends that result with the authenticated subscriber's own rank, computed server-side against the referral ordering; it is personal `/me` content and never comes from the anonymised public snapshot. E6-05 and E8-03 render this result; they do not recompute it. Referral-status rendering ownership was founder-authorised 2026-09-14; the own-rank scope move was founder-authorised 2026-09-21.
- **`confirmed_referrals` is derived from edges.** `recomputeCounters()` runs the reward recompute for each subscriber it checks, so it also repairs drifted coupons and waves; a subscriber with any corrected value counts once. It is idempotent, batch-capped at 1,000 and records every run in the append-only audit log. Each run checks at most 1,000 verified subscribers, lowest IDs first, so it does not reach every referrer. A ladder or wave-1 configuration change reaches a referrer at their next recompute — a confirmation, void or un-void — or at the repair if they are among the subscribers it checks, and the first repair after a change reports those it changes as corrections. The handoff first recomputes everyone: before its snapshot, `exportHandoff()` recomputes every verified subscriber's coupons and wave under the configured ladder, keyset-paged by ID in batches of at most 1,000 under each subscriber's row lock, and audits each subscriber whose coupons or access window change as `handoff.rewards_recomputed` (D-047). The export therefore follows the configured ladder, and the first-1,000 place is kept. Its daily job sends a **P2** alert carrying the correction count for any non-zero correction — a silently repaired counter hides the bug that caused it. It locks each repaired subscriber row transactionally, so concurrent signup and verification work cannot be overwritten.
- **Attribution health** is an aggregate-only `ReferralService.attributionHealth()` result: new signups with a referral edge divided by all new signups. SQL stays in `server/db`; neither the result nor its alert includes subscriber IDs or referral codes. The hourly monitor compares the preceding 24 hours with the preceding seven days. Configurable defaults require at least 50 current signups and a baseline share above zero; a relative drop of at least 50% raises P1. It accepts an injected clock. With `referral.enabled` off, it does not evaluate or alert and reports `disabled`. E10-05 owns this monitor and displays it beside verification health.
- **A voided referral counts nowhere** (E11.7-02). The founder voids one referral, identified by its referred person, with a reason, through `POST /api/admin/referrals/void` and the founder command line; `/unvoid` reverses it. A void sets `voided_at`, `void_reason` and `voided_by` on the edge and never changes `state` or `reward_state`, so no reward transition is added. Every count reads only confirmed, non-voided edges: `confirmed_referrals`, the coupon ladder and wave 1 (all recomputed in the void transaction and by `recomputeCounters()`), giveaway referral entitlement and accrual, and the handoff's confirmed pairs; the leaderboard snapshot, `/me`, own rank and the admin CSV follow from the recomputed counter. A confirmation that meets a voided edge still moves it to `confirmed`, but it counts only once un-voided. The service locks the referrer row, then the edge, then the entry ledger, in the verification transaction's order. Before the draw snapshot is committed it voids or restores the edge's giveaway entry; after commitment it leaves the giveaway untouched. It refuses a void of a rejected or already voided edge, an un-void of an edge that is not voided, and both while the referrer is disqualified, being erased or erased. The reason is one line of 1–200 characters with no email or IP address, and the actor must be human. Every void and un-void writes `referral.voided` or `referral.unvoided` with before and after values, including the referrer's coupons and access window.
- **Single level only.** No second-degree credit, no multi-level structure, no code path that walks a referral chain.

## Configuration (ADR-025, as amended by E11.7-03)
Values, not schema. Changing any of them requires no migration. They live in `src/server/referral/config.ts`.

- **Base entry:** `1` on verification. **Per confirmed referral:** `+1` entry — cheap, settles on confirmation.
- **Coupon ladder** (`couponLadder`): unlocks at `[3, 21, 39]` (one coupon each), `stepReferrals = 3`, `stepPercent = 5`, `maximumPercent = 30`, `publicLaunchDate = '2027-10-01'`, `expiryYears = 5`. `computeCouponLadder(count)` gives each unlocked coupon's percent, `min(30, 5 × (1 + ⌊(count − unlock) / 3⌋))`; `couponExpiresAt()` gives the expiry, `2032-10-01T00:00:00.000Z` (founder, 2026-11-22: public launch 1 October 2027). The founder sets the real launch date here at handoff.
- **Wave 1** (`waveOneReferralThreshold`): 3 confirmed, non-voided referrals.
- **Access-window bands** (`accessWindowBands`, assigned once at verification as `verification_order_window`): `≤1,000 → wave-1 · ≤5,000 → wave-2 · ≤15,000 → wave-3 · else wave-4`. The count-and-assignment section is serialised, so concurrent verifications receive distinct ordinals at a band boundary.
- **Cheap vs high-value** follows ADR-012: base/per-referral entries and wave position settle on confirmation; **coupons are `held`** and carried to the storefront. No configured reward is a draw entry.
- **Wave-1 early access** (`waveOneEarlyAccessMonth`): `'2027-09'` (founder, 2026-11-22; previously `'2027-07'`), the month every surface names for wave 1's early access (E11.7-04).
- **What the surfaces show (E11.7-04).** `ladder-presentation.ts` turns the configuration and a member's confirmed count and windows into the ladder copy every surface shows: the progress line in the founder's form, the held condition with the configured expiry, the next step for the meter, early access and its reason, and the landing card. `ReferralService.status` no longer reads milestone awards or the tier, and the retired `milestoneTiers` figures are removed; `docs/features/member-status.md` has the surfaces.

## Partner attribution and signup counts

E11.7-07 resolves an active partner's registered code and member code to the same verified subscriber and partner identity. When the partner programme is off, or the partner is paused or terminated, their member code still creates an ordinary member edge. The partner's short URL redirects into the existing signed capture only while the code can attribute. A friend earns the stored welcome discount and wave 1 on confirmation, subject to their own edge's void state. A partner qualifies for wave 1 while active and live. New programme effects share a transaction lock with changes to the live flag override. The recompute also recognises an independent wave reason and a friend-owned entitlement retained on partner erasure.

When fraud review disqualifies the partner, recomputation uses the prior confirmation recorded on a rejected edge to preserve the friend's earned perks if the edge has no void. The edge stays excluded from the partner's own referral count.

New partner and plain member edges capture the confirmed, non-voided ladder count in the edge-creation transaction under the referrer's subscriber lock. Confirmation and voids share that lock. The count includes confirmed evidence retained after a referred person's erasure; storing the count requires no list of people. Member edges record no welcome discount. A partner edge uses the captured count and the ambassador floor to fix its percentage. Catch-up uses the captured count for pre-approval member edges, including zero.

For an eligible legacy edge without a count, compare recorded times with the friend's original signup. Count the referrer's other edges confirmed strictly before signup, including retained confirmation evidence, and exclude an edge voided at that cutoff. A void starts at the recorded `after.voided_at`; an un-void ends it at the audit entry's `at` paired by edge and `before.voided_at`. Both endpoints of the interval are inclusive. An un-void timestamp that precedes its void makes a one-instant interval at the void. A still-open void continues indefinitely. The rule uses recorded event times when the legacy transaction visibility cannot be reconstructed.

## Dependencies
`db`, `audit`, `fraud` (the E4-03 `self_referral` signal only), `giveaway` (entry accrual on confirmation; a referral void voids or restores the edge's entry before commitment, E11.7-02), `flags`.

## Contract tests
Entropy and collision over a large generated sample · **one code namespace: case variants never coexist under genuine concurrency, and a member code generated after a partner code never equals it** · backfilled member codes resolve exactly as before · each partner-code rule refuses with its own reason, and every alternative passes all three · a tampered signed ref returns `null` · self-referral rejected and the signup still completes · duplicate edge rejected by the database · duplicate milestone award rejected by the database · tier derives only from settled awards · **no coupon transition reaches `settled`, enumerated, and the database refuses one** · **seeded property test: coupons and wave always equal the ladder from the current non-voided count over generated confirmations, voids and un-voids** · the founder's table cases · a void lowers or voids a coupon and drops wave 1 below 3, and an un-void restores both · the first-1,000 place survives every void · every milestone award retired as `ladder_replaced`, none deleted · a different ladder applies without a migration · referral status returns the exact stored count and active reward states · **seeded property test: `recomputeCounters()` is idempotent and matches the edges for any generated graph** · **a high-value reward cannot reach `settled` from a verification path** · rejecting a referrer's edges leaves referred subscribers' status unchanged · **a void removes one referral from every consumer of the confirmed count and an un-void restores each exactly** · a void needs a reason and a human actor, in the service and the database · every void and un-void is audited with before and after values · before commitment a void voids the entry and an un-void restores it; after commitment the draw is untouched and reproduces.
