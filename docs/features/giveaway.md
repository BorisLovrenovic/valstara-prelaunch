# Feature: Giveaway

## Summary
**One global prize draw under Hong Kong law** (ADR-026) that drives referrals and runs so the result can be reproduced and defended afterwards. No country is excluded and none is collected at entry. The rules are small and uniform: 18+, one registration per person, no purchase necessary, one prize per person, and small prizes. Location is collected only from provisional winners at award time.

## Feature flag
`giveaway.open` — **default off.** It stays off until the global rules page is published (P4, E7-02), the representatives are named in the privacy policy, and the ESP tiers are upgraded (P5).

## User flows
1. **Entry** — a verified subscriber is an entrant. **No purchase, referral or marketing consent is needed**: the ordinary verified signup is the free entry route, and a "No purchase necessary" line sits beside the signup call to action (E7-04).
2. **Entries** — one base entry on verification, plus one per confirmed referral (a unique referred person who verifies). Every entry has the same weight and stamps the `rules_version` and rules hash in force.
3. **Rules** — one page at `/giveaway/rules`, governed by Hong Kong law, with every revision immutable at `/giveaway/rules/<rules_version>`.
4. **Draw** — executed against a snapshot of the entry ledger. The snapshot hash is committed before the seed exists, winners are selected with **one prize per person**, and an ordered reserve list is produced in the same execution. **The result is not published until it reproduces.**
5. **Review** — the top 20 by raw, non-voided entries are reviewed manually before any award. A membership change invalidates the completed review; E7-05 calls E5-07's server-side current-review precondition before draw publication.
6. **Award** — provisional winners are notified, then give their country of residence (no postal address — prizes are digital and delivered electronically) and confirm they are 18 or over. The country is screened against the sanctioned-jurisdiction list. A winner resident in Canada answers a skill-testing question. A failed check or a missed deadline moves the prize to the next reserve. The award is recorded against the entry snapshot that produced it.

## Prize and rules limits (ADR-026)
Each prize **≤ €449** approximate retail value; the total pool **below US$5,000**, checked at a conservative euro-to-dollar rate. **Current prize: 5 Valstara product bundles at €300 each (€1,500).** Entries open 1 October 2026 (or when the waitlist goes live, if later), close 1 March 2027, and winners are drawn on 1 April 2027. Winners pay any local taxes; prizes are delivered electronically at no cost to the winner. A product unavailable in the winner's region follows the substitution rule. Substitution: Bundle first; if a product in it is unavailable at award time, the winner picks replacement products so the bundle keeps at least its stated retail value; if the winner wants no replacement, the promoter pays that unavailable product's retail value in cash, as a last resort. Bundle contents may be "to be announced" until they are chosen, and the draw refuses to run until they are listed. The sanctions list may be empty until the founder adds it. Honest odds: each eligible entry has equal weight, and a person's odds are their eligible entries divided by all eligible entries when entries close, subject to one prize per person.

## Edge cases and error states
Rules revised mid-campaign → a new immutable revision; earlier entries keep the version they accrued under. Referrer disqualified → their referral-derived entries are voided, **and the entries of the people they referred are not.** Draw cannot be reproduced → **blocking; nothing is published.** Winner in a sanctioned jurisdiction, under 18, failing the Canadian skill-testing question, or silent past the deadline → the next reserve, never a new draw. Prize unavailable at award time → the substitution clause applies. Marketing consent withdrawn → no effect on entries.

## Acceptance criteria
- [ ] **No location is read or collected at entry**; only a provisional winner's country of residence is collected, and no postal address
- [ ] Entry is reachable **without a referral, a purchase or marketing consent**, and every entry carries equal weight
- [ ] Every entry stores its `rules_version` and rules hash
- [ ] Entry accrual is idempotent — a retry never double-credits, enforced by a unique constraint
- [ ] **No entry accrues for an unverified subscriber**
- [ ] The rules page states "No purchase necessary", 18+, one prize per person, the odds wording, that winners pay local taxes, the award-time checks and Hong Kong governing law; prize values above the limits fail the build
- [ ] The draw commits its snapshot hash before the seed, produces a reserve list, and **refuses to publish until it reproduces**
- [ ] The top-20 manual review is a required step before any award — enforced server-side, not by procedure
- [ ] A sanctioned-jurisdiction winner is replaced from the reserve list
- [ ] Every claim about the giveaway on the site matches the current global rules page — CI-checked where the copy is structured, reviewed where it is prose

## Telemetry
Entries by method (base, referral), referral entries per entrant, top-20 review outcomes, award-time replacements by reason.
