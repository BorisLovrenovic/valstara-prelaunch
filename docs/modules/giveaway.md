# Module: giveaway

Kind: domain. Implements ADR-018.

## Responsibility
Jurisdiction eligibility, the entry ledger, AMOE, and a draw that can be reproduced afterwards.

## Data owned
`giveaway_entry`, `giveaway_draw`.

## Exposed interface
```ts
interface GiveawayService {
  eligibility(country: string, region?: string): Eligibility   // { eligible, reason, rulesVersion }
  accrue(subscriberId: string, method: EntryMethod, sourceEdgeId?: string): Promise<void>
  voidEntriesOf(subscriberId: string, reason: string): Promise<number>
  entriesFor(subscriberId: string): Promise<EntrySummary>
  executeDraw(seed: string, actor: string): Promise<DrawResult>
  reproduceDraw(drawId: string): Promise<boolean>
  assertTopTwentyReviewedAndCurrent(): Promise<void>
}
```

## Rules
- **Eligibility is decided at point of entry** from the *confirmed* country — and, for Canada, the province — and the deciding `rules_version` is stamped on every accrual. Entries keep the rules that were in force when they accrued.
- **An excluded jurisdiction never blocks the waitlist signup.** It declines the entry and says why.
- **No entry accrues for an unverified subscriber.**
- **`accrue()` is idempotent** via a unique constraint on `(subscriber_id, method, source_edge_id)`. A retry cannot double-credit.
- **AMOE carries equal weight** to an earned entry and is reachable without a referral.
- **`executeDraw()` records the seed and the entry-snapshot hash, and the result is not published until `reproduceDraw()` returns true.** A draw that cannot be reproduced is not a draw, it is an assertion.
- **A second execution is refused.**
- **Before draw publication, the raw top 20 by non-voided entries must have a current, actor-recorded review.** E5-07 provides this precondition; E7-05 calls it. Flagged accounts remain in this review ranking: it is not the public leaderboard snapshot.
- Voiding a referrer's entries never touches the entries of the people they referred.

## Dependencies
`db`, `audit`, `flags`, `subscriber`.

## Contract tests
Table test over every excluded jurisdiction including the Canada/Quebec case · excluded signup still completes · unverified accrual rejected · double accrual rejected by the database · **draw reproduces from its recorded seed** · second execution refused · voiding a referrer leaves referred entries intact.
