# Feature: Fraud signals and review

## Summary
Layers that make referral fraud visible and unprofitable, in order of value per hour: **address normalisation before any uniqueness check**, a disposable-domain blocklist with an MX check, self-referral and velocity flags, and a manual review of the top 20 before prizes. **Every signal flags; no signal bans.** The structural answer is reward gating, not detection (ADR-012, ADR-013).

## Feature flag
None — the signals are part of signup. Individual checks are configuration, and velocity anomaly detection is cut-list item 6.

## User flows
1. **Normalise** — lowercase, strip `+tags`, remove dots for Gmail-family domains, then check uniqueness. This one step removes the cheapest attack entirely.
2. **Screen** — disposable-domain blocklist and an MX lookup at signup.
3. **Flag** — self-referral, duplicate identity, and /24 velocity anomalies write `fraud_flag` rows. **Nothing changes the subscriber's status.**
4. **Review** — an operator queue: dismiss or uphold. Upholding disqualifies, rejects the referrer's edges, and is audited.
5. **Prize gate** — the top 20 by entries are reviewed before any award.

## Edge cases and error states
MX lookup times out → **accept and flag.** A slow resolver must never cost a real signup. Blocklist false positive → an operator can allow a domain, audited. Velocity flag on a shared network (a university, an office, a mobile carrier NAT) → **exactly why it is a flag and not a ban.** Legitimate high performer → they will be flagged by volume and cleared by review; that is the system working. Disqualification appealed → an operator can reverse it, audited; a reversal restores the edges it rejected.

## Acceptance criteria
- [ ] **Normalisation happens before the uniqueness check** — asserted with `+tag` and Gmail-dot cases
- [ ] Disposable domains are rejected with plain copy; the list is configuration, not code
- [ ] **An MX timeout accepts and flags** rather than rejecting
- [ ] **No code path sets `disqualified` without a recorded human action** — asserted over every write site
- [ ] Upholding a flag rejects the referrer's edges and **changes no referred subscriber's status**
- [ ] IP handling stores only a **truncated, hashed prefix**, purged at 90 days — asserted by test and by the purge job
- [ ] **Deferred to E7-02 (founder-authorised 2026-09-16):** the disqualification rule is published on every counsel-reviewed per-jurisdiction rules page before `giveaway.open` can be enabled; no standalone wording is published while P4 is outstanding
- [ ] No fingerprinting library or browser-entropy collection exists anywhere in the codebase — CI-scanned

## Telemetry
Flag volume by kind, review outcome mix, disqualification count, share of referrals from flagged accounts, blocklist hit rate.
