# Module: giveaway

Kind: domain. Implements ADR-026 (which superseded ADR-018) and respects ADR-027.

## Responsibility
One global draw under Hong Kong law: entry eligibility, the entry ledger, a draw that can be reproduced afterwards, and the award-time checks.

## Data owned
`giveaway_entry`, `giveaway_draw`, `giveaway_award`.

## Exposed interface
```ts
interface GiveawayService {
  isEligible(subscriberId: string): Promise<boolean>          // verified + giveaway open; no location input
  currentRules(): RulesVersion                                 // { rulesVersion, sha256 } from E7-02's content source
  accrue(subscriberId: string, method: 'base' | 'referral', sourceEdgeId?: string): Promise<void>
  voidEntriesOf(subscriberId: string, reason: string): Promise<number>
  entriesFor(subscriberId: string): Promise<EntrySummary>
  executeDraw(actor: string): Promise<DrawResult>              // winners + ordered reserve list
  reproduceDraw(drawId: string): Promise<boolean>
  assertTopTwentyReviewedAndCurrent(): Promise<void>
  recordWinnerDetails(awardId: string, details: WinnerDetails): Promise<AwardCheckResult>  // country of residence, 18+ confirmation, CA skill answer
}
```

## Rules
- **No location input anywhere in eligibility or accrual.** Eligibility is: `verified`, and the giveaway is open. 18+ is a rules condition confirmed with provisional winners at award time; one registration per person is enforced by normalisation and the fraud controls.
- E7-01 implements the eligibility decision only. E7-03 writes `subscriber.giveaway_rules_version` once in the first-accrual transaction and owns the application grant for that column.
- **Entry never depends on marketing consent** (ADR-027). The ordinary verified signup is the free entry route; there is no separate AMOE route.
- **Every accrual stamps `rules_version` and `rules_sha256`** from the single global rules page. Entries keep the rules that were in force when they accrued.
- E7-03 calls accrual after a fresh verification and referral confirmation, inside the verification transaction. It writes one base entry for the newly verified person and one referral entry for their referrer when the edge is confirmed. A replay adds nothing. The `giveaway.open` flag prevents all accrual when off.
- The first successful entry also stamps `subscriber.giveaway_rules_version` in that transaction. A later rules revision changes new entries only; the subscriber's first version and prior entries remain unchanged.
- **No entry accrues for an unverified subscriber.**
- **`accrue()` is idempotent** via a unique constraint on `(subscriber_id, method, source_edge_id)`. A retry cannot double-credit. A validated check constraint requires `entries = 1` on every ledger row (E7-04); E7-05 tests equal weight in draw selection.
- A referral accrual requires a confirmed edge belonging to the credited referrer. Ineligible subscribers receive no entry even if an edge exists.
- **Founder-authorised 2026-09-26:** entitlement comes from the recorded verification and edge confirmation times within the published entry period. The flag controls writes, so a bounded reconciliation runs when it opens and hourly while on to restore missing entitlements. Each run records `giveaway.entries_backfilled` with checked and accrued counts. A rerun uses the ledger unique constraint and adds nothing. No event at or after 00:00 UTC 2 March 2027 earns an entry.
- The entry period starts at the later of 00:00 UTC 1 October 2026 and the actual waitlist go-live recorded in `WAITLIST_LIVE_AT`. Production requires that validated UTC value before `giveaway.open` can be enabled.
- **`executeDraw()` opens no earlier than 1 April 2027 UTC and commits the entry-snapshot hash before the seed exists**, records the seed, applies **one prize per person**, and produces an ordered reserve list in the same execution. **The result is not published until `reproduceDraw()` returns true.** A draw that cannot be reproduced is not a draw, it is an assertion.
- **Founder-authorised 2026-09-26:** The randomness source is a future public drand round, never local RNG. The commitment records a round scheduled at least five minutes later, with configured chain hash and key. Two relays must confirm that the target is still future at commitment; a published round causes an abort and recommit, while a validation outage refuses the commitment. The worker fetches the target from at least two configured relays, checks agreement and the official client signature verification, and derives `SHA-256(snapshot_hash || uint64_be(round) || randomness_bytes)`. The complete beacon evidence is stored on `giveaway_draw`. Target-round outages leave the draw pending with bounded backoff and a P1 operator alert. `reproduceDraw()` verifies the stored beacon offline and makes no network request. A randomness-source change needs a founder decision and a rules revision.
- Every ledger row has one independent exponential-race ticket derived from the seed and entry ID. Sorting tickets and retaining each person's first occurrence gives row-proportional selection without replacement. The first `prize_count` people are winners; all others form the ordered reserve list. Snapshot copying, score computation and selection storage are batch-capped at 1,000 rows. The database retains the full order rather than loading it into application memory.
- **A second execution is refused.** Replacements come only from the reserve list.
- **Before draw publication, the raw top 20 by non-voided entries must have a current, actor-recorded review.** E5-07 provides this precondition; E7-05 calls it. Flagged accounts remain in this review ranking: it is not the public leaderboard snapshot.
- **Only a provisional winner's country of residence is collected**, with no postal address, because prizes are delivered electronically. The country is screened against the configured sanctioned-jurisdiction list; a winner resident in Canada must answer a skill-testing question; a failed check or missed deadline moves the prize to the next reserve.
- E7-06 queues one `email_send` notice per draw and selected entry with a deterministic business key. The queue timestamp starts the published 14-day response deadline. E8-01 later owns dispatch and E8-03 owns the seventh template. The winner form requires a reusable status token and Turnstile; only the current provisional winner may submit country and age confirmation. A configured sanctions list may be empty. A correct mathematical answer is required for Canada. Failed or missed Section 9 checks advance through the draw's ordered reserves; candidate claims prevent reuse, and every outcome is audited.
- A successful Section 9 response confirms the award against the published entry snapshot. If an item is unavailable generally or in the winner's country, a separate substitution offer starts a configured 14-day choice period. A founder-approved repository catalog is the authority for retail values, regional availability and replacement choices. Server-side validation requires the chosen replacement goods plus available original goods to retain at least the stated bundle value. Explicit decline or silence at the substitution deadline settles cash for unavailable items only. The confirmed winner retains the prize in all substitution outcomes; each is audited.
- Voiding a referrer's entries never touches the entries of the people they referred.

## Dependencies
`db`, `audit`, `flags`, `subscriber`.

## Contract tests
No location parameter or read in eligibility · consent-independent entry · unverified accrual rejected · double accrual rejected by the database · rules version and hash stamped · **draw reproduces from its recorded seed, reserves included** · hash committed before seed · second execution refused · one prize per person · sanctions replacement from reserves · voiding a referrer leaves referred entries intact.
