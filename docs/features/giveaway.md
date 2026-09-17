# Feature: Giveaway

## Summary
A prize draw that drives referrals, **scoped by jurisdiction at point of entry** and run so the result can be reproduced and defended afterwards. The mechanics are constrained by law in more places than is comfortable, and those constraints are enforced in code rather than in the terms (ADR-018, `docs/legal/compliance.md`).

## Feature flag
`giveaway.open` — **default off.** It stays off until the per-jurisdiction rules pages are published, the representatives are named in the privacy policy, and the ESP tiers are upgraded.

## User flows
1. **Eligibility** — decided at signup from the **confirmed** country, and for Canada the province. Excluded: Italy, Poland, Spain, the Nordics and Quebec. The reason is stated plainly at that point, and **the waitlist signup still completes.**
2. **Entries** — a base entry on verification, plus entries per confirmed referral. Every accrual stamps the `rules_version` in force.
3. **AMOE** — an alternative method of entry with no referral requirement, offered wherever it is required, and given **the same weight as an earned entry**.
4. **Draw** — executed against a snapshot of the entry ledger with a recorded seed. **The result is not published until it reproduces from that seed and snapshot hash.**
5. **Review** — the top 20 by raw, non-voided entries are reviewed manually before any award. A membership change invalidates the completed review; E7-05 calls E5-07's server-side current-review precondition before draw publication.
6. **Award** — winners notified; the award is recorded with the entry snapshot that produced it.

## Edge cases and error states
Excluded country → giveaway declines, waitlist proceeds, copy explains it. Country changed after accrual → **entries already accrued keep their rules version**; the page says so. Rules change mid-campaign → both versions published; earlier entries keep the earlier version. Referrer disqualified → their referral-derived entries are voided, **and the entries of the people they referred are not.** Draw cannot be reproduced → **blocking; nothing is published.** Prize unavailable at award time → the rules' stated substitution clause applies, which is why that clause is a required section of every rules page.

## Acceptance criteria
- [ ] Eligibility is decided **at point of entry** from the confirmed country and, for Canada, the province — asserted by a table test over every excluded jurisdiction
- [ ] An excluded visitor **still completes the waitlist signup**
- [ ] Every entry stores its `rules_version`
- [ ] Entry accrual is idempotent — a retry never double-credits, enforced by a unique constraint
- [ ] **AMOE exists, is reachable without a referral, and carries equal weight**
- [ ] The draw records seed and entry-snapshot hash, and **refuses to publish until it reproduces**
- [ ] The top-20 manual review is a required step before any award — enforced server-side, not by procedure
- [ ] **No entry accrues for an unverified subscriber**
- [ ] Every claim about the giveaway on the site matches the rules page for that jurisdiction — CI-checked where the copy is structured, reviewed where it is prose

## Telemetry
Entries by method and jurisdiction, eligible-versus-excluded signup mix, AMOE usage, referral entries per entrant, top-20 review outcomes.
