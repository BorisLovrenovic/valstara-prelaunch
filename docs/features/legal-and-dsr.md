# Feature: Legal pages and data-subject rights

## Summary
`/terms`, `/privacy` and `/giveaway/rules/*` at their permanent URLs, plus working export and erasure. **The privacy policy gates the first signup**, because it must name the appointed EU and UK Article 27 representatives before any personal data is collected (ADR-019).

## Feature flag
None.

## User flows
1. **Privacy policy** — what is collected, why, the lawful basis, retention periods, the named EU representative, the named UK representative, and how to exercise rights.
2. **Terms** — site terms for a pre-launch waitlist. Distinct from the store's terms, which are the storefront's.
3. **Giveaway rules** — one page per jurisdiction under `/giveaway/rules/*`, each carrying eligibility, entry methods including AMOE, the draw date and method, prize substitution, the disqualification rule, and the promoter's identity.
4. **Rights** — a request from `/me` or by email triggers a signed confirmation link; export returns the subject's data, erasure removes it.

## Content sourcing — a named dependency
**The representatives must be appointed before the first signup**, and both must be named in the policy. This is procurement, not engineering: roughly €200–500/year each, from Prighter, DataRep, EDPO or similar, and **the UK requires a separate appointment from the EU one.** The build delivers the pages and the rights machinery; the names and the reviewed legal text are founder inputs.

## Edge cases and error states
Erasure requested for a subscriber with referral edges → **anonymise rather than drop.** The edge survives with its subject nulled, so counts stay defensible and no personal data remains. Erasure requested mid-draw → honoured; the entries are voided and the draw snapshot records the void. Export requested for an unknown address → the same response as for a known one. Rules page needed for a jurisdiction not yet written → **that jurisdiction is excluded from the giveaway**, not served a generic page. Retention period elapsed on rules pages → return `410`, not `404`, and not a silent delete.

## Acceptance criteria
- [ ] `/terms` and `/privacy` exist at their **permanent URLs** with content-file prose
- [ ] **The privacy policy names both the EU and the UK representative** — a build-time assertion that neither field is a placeholder
- [ ] **No signup route is reachable while that assertion fails** — the gate is in code, not in a checklist
- [ ] Every collected field, its purpose, its lawful basis and its retention period appears in the policy — reconciled against `docs/data/model.md` by a test
- [ ] Export returns the subject's complete data within the statutory window, audited
- [ ] Erasure **anonymises referral edges rather than dropping them**, and leaves no personal data
- [ ] Every giveaway rules page carries all seven required sections — schema-validated
- [ ] Excluded jurisdictions have **no rules page and no entry path**

## Telemetry
Policy page views, DSR request volume and fulfilment time, rules-page views by jurisdiction.
