# Feature: Giveaway

## Summary
**One global prize draw under Hong Kong law** (ADR-026) that drives referrals and runs so the result can be reproduced and defended afterwards. No country is excluded and none is collected at entry. The rules are small and uniform: 18+, one registration per person, no purchase necessary, one prize per person, and small prizes. Location is collected only from provisional winners at award time.

## Feature flag
`giveaway.open` — **default off.** It stays off until the global rules page is published (P4, E7-02) and the ESP tiers are upgraded (P5). ADR-029 removes the former representative prerequisite. The current published rules revision still contains the superseded representative claim; a new immutable revision is required before that claim can be corrected.

## User flows
1. **Entry** — a subscriber verified within the entry period is an entrant; entries accrue while `giveaway.open` is on, and any missed while it was off are added when it opens. **No purchase, referral or marketing consent is needed**: the ordinary verified signup is the free entry route, and a "No purchase necessary" line sits beside the signup call to action (E7-04).
2. **Entries** — one base entry on verification, plus one per confirmed referral (a unique referred person who verifies). Every ledger row has exactly one unit, enforced by a check constraint, and stamps the `rules_version` and rules hash in force. E7-05 proves equal weight in draw selection.
3. **Rules** — one page at `/giveaway/rules`, governed by Hong Kong law, with every revision immutable at `/giveaway/rules/<rules_version>`.
4. **Draw** — the admin action closes entry inserts and commits a batch-copied snapshot of the non-voided ledger. It records a drand round scheduled at least five minutes after commitment. A maintenance worker obtains the signed round from two configured relays, derives the seed and selects **one prize per person** with an ordered reserve list. **The result is not published until it reproduces, including the offline beacon signature check.** An unavailable or invalid beacon keeps the commitment pending and alerts the operator; there is no local-seed fallback or second draw.
5. **Review** — the top 20 by raw, non-voided entries are reviewed manually before any award. A membership change invalidates the completed review; E7-05 calls E5-07's server-side current-review precondition before draw publication.
6. **Award** — E7-06 queues one provisional winner notification per draw and selected person in `email_send`, with a deterministic business key and a recorded notification time that starts the response deadline. E8-01 later dispatches queued mail, and E8-03 supplies the seventh transactional template. Provisional winners then give their country of residence (no postal address — prizes are digital and delivered electronically) and confirm they are 18 or over. The country is screened against the sanctioned-jurisdiction list. A winner resident in Canada answers a skill-testing question. A failed check or a missed deadline moves the prize to the next reserve. The award is recorded against the entry snapshot that produced it. `/giveaway/award` renders every state on the shared task card (E11.5-10): the check form, the substitution choice (replacement goods as the primary action, the cash decline as a secondary button), confirmed, cash, replacement, replaced, exhausted and unavailable, each with an icon. A POST outcome shows as a notice with an icon. Fields, Turnstile, token use and responses are unchanged.

## Prize and rules limits (ADR-026)
Each prize **≤ €449** approximate retail value; the total pool **below US$5,000**, checked at a conservative euro-to-dollar rate. **Current prize: 5 Valstara product bundles at €300 each (€1,500).** Entries open 1 October 2026 (or when the waitlist goes live, if later), close 1 March 2027, and winners are drawn on 1 April 2027. Winners pay any local taxes; prizes are delivered electronically at no cost to the winner. A product unavailable in the winner's region follows the substitution rule. Substitution: Bundle first; if a product in it is unavailable at award time, the winner picks replacement products so the bundle keeps at least its stated retail value; if the winner wants no replacement, the promoter pays that unavailable product's retail value in cash, as a last resort. Bundle contents may be "to be announced" until they are chosen, and the draw refuses to run until they are listed. The sanctions list may be empty until the founder adds it. Honest odds: each eligible entry has equal weight, and a person's odds are their eligible entries divided by all eligible entries when entries close, subject to one prize per person.

## Edge cases and error states
Rules revised mid-campaign → a new immutable revision; earlier entries keep the version they accrued under. Referrer disqualified → their referral-derived entries are voided, **and the entries of the people they referred are not.** Draw cannot be reproduced → **blocking; nothing is published.** Winner in a sanctioned jurisdiction, under 18, failing the Canadian skill-testing question, or silent past the 14-day Section 9 response deadline → the next reserve, never a new draw. Passing those checks confirms the award. An unavailable product then opens a separate substitution offer on that confirmed award; its configurable 14-day deadline starts when the offer is recorded. The founder-approved catalog marks global and country-specific availability and fixes each product's retail value. The winner chooses catalog-approved replacement goods preserving at least the stated bundle value, or declines for cash equal only to the unavailable product's value. Silence when the substitution deadline expires settles that same cash amount without replacing the winner. Offer, replacement choice, decline and expiry-to-cash are audited. Marketing consent withdrawn → no effect on entries.

A replaced provisional winner sees a plain status notice through their existing status link. Each replacement writes a P3 operational record after its database transaction commits; the audit log retains the specific check or deadline reason.

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
