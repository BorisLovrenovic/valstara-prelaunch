# Feature: Legal pages and data-subject rights

## Summary
`/terms`, `/privacy` and `/giveaway/rules` (with immutable `/giveaway/rules/<rules_version>` revisions) at their permanent URLs, plus working export and erasure. **The privacy policy gates the first signup**, because it must name the appointed EU and UK Article 27 representatives before any personal data is collected (ADR-019).

## Feature flag
None.

## User flows
1. **Privacy policy** — what is collected, why, the lawful basis, retention periods, the named EU representative, the named UK representative, and how to exercise rights. It states the ADR-027 split plainly: joining and entering run on contract, marketing on separate optional consent, and withdrawing marketing never affects the waitlist or entries. It also says that only a country of residence is collected from provisional winners, at award time; no postal address is collected (ADR-026).
2. **Terms** — site terms for a pre-launch waitlist. Distinct from the store's terms, which are the storefront's.
3. **Giveaway rules** — **one global page under Hong Kong law** at `/giveaway/rules` (ADR-026), carrying every section listed in `docs/legal/compliance.md#4`, including the disqualification rule and the promoter's identity.
4. **Rights** — a request from `/me` or by email triggers a signed confirmation link; export returns the subject's data, erasure removes it.

## Content sourcing — a named dependency
**The representatives must be appointed before the first signup**, and both must be named in the policy. This is procurement, not engineering: roughly €200–500/year each, from Prighter, DataRep, EDPO or similar, and **the UK requires a separate appointment from the EU one.** The build delivers the pages and the rights machinery; the names and the reviewed legal text are founder inputs.

## Edge cases and error states
Erasure requested for a subscriber with referral edges → **anonymise rather than drop.** The edge survives with its subject nulled, so counts stay defensible and no personal data remains. Erasure requested mid-draw → honoured; the entries are voided and the draw snapshot records the void. Export requested for an unknown address → the same response as for a known one. Rules revised → a new immutable revision at its own URL; the old one is never overwritten. Public retention elapsed (12 months after the final award) → return `410`, not `404`, and not a silent delete; the revisions stay in the internal record for 6 years.

## Acceptance criteria
- [ ] `/terms` and `/privacy` exist at their **permanent URLs** with content-file prose
- [ ] **The privacy policy names both the EU and the UK representative** — a build-time assertion that neither field is a placeholder
- [ ] **No signup route is reachable while that assertion fails** — the gate is in code, not in a checklist
- [ ] Every collected field, its purpose, its lawful basis and its retention period appears in the policy — reconciled against `docs/data/model.md` by a test
- [ ] Export returns the subject's complete data within the statutory window, audited
- [ ] Erasure **anonymises referral edges rather than dropping them**, and leaves no personal data
- [ ] The global rules page carries every required section — schema-validated — and every revision is immutable at its versioned URL

## Telemetry
Policy page views, DSR request volume and fulfilment time, rules-page views.
