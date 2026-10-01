# Feature: Legal pages and data-subject rights

## Summary
`/terms`, `/privacy` and `/giveaway/rules` (with immutable `/giveaway/rules/<rules_version>` revisions) at their permanent URLs, plus working export and erasure. ADR-029 records the founder's decision not to appoint EU or UK Article 27 representatives and removes the former representative gate.

## Feature flag
None.

## User flows
1. **Privacy policy** — what is collected, why, the lawful basis, retention periods, and how to exercise rights. It states the ADR-027 split plainly: joining and entering run on contract, marketing on separate optional consent, and withdrawing marketing never affects the waitlist or entries. It also says that only a country of residence is collected from provisional winners, at award time; no postal address is collected (ADR-026). E9-03 embeds the one-entry storage inventory in this page.
2. **Terms** — site terms for a pre-launch waitlist. Distinct from the store's terms, which are the storefront's.
3. **Giveaway rules** — **one global page under Hong Kong law** at `/giveaway/rules` (ADR-026), carrying every section listed in `docs/legal/compliance.md#4`, including the disqualification rule and the promoter's identity.

The rules source is a versioned Markdown file in `src/content/giveaway-rules/`. Its frontmatter records the `rulesVersion`, prize values, conservative USD/EUR conversion assumption and SHA-256 of the rendered rules article. The build checks all required sections, statements, prize limits and the hash. `/giveaway/rules` serves the latest published revision; `/giveaway/rules/<rules_version>` keeps each published revision at its permanent URL. New revisions are appended as new files, while CI rejects edits or deletion of files already present on the base branch. The server's `currentRules()` reads that same validated collection for the entry ledger.
4. **Rights** — a request from `/me` or by email triggers a signed confirmation link; export returns the subject's data, erasure removes it.

## Content sourcing — a named dependency
The founder waived the representative prerequisite and authorised temporary draft text for `/terms` and `/privacy` on 2026-10-01 (ADR-029). Reviewed replacement wording remains a founder input. The draft status is visible on each page and must be addressed in the E11-05 privacy audit.

## Edge cases and error states
Erasure requested for a subscriber with referral edges → **anonymise rather than drop.** The edge survives with its subject nulled, so counts stay defensible and no personal data remains. Erasure requested mid-draw → honoured; the entries are voided and the draw snapshot records the void. Export requested for an unknown address → the same response as for a known one. Rules revised → a new immutable revision at its own URL; the old one is never overwritten. Public retention elapsed (12 months after the final award) → return `410`, not `404`, and not a silent delete; the revisions stay in the internal record for 6 years.

## Acceptance criteria
- [ ] `/terms` and `/privacy` exist at their **permanent URLs** with content-file prose
- [ ] Neither legal page implies an appointed EU or UK representative
- [ ] The signup route has no representative-dependent gate
- [ ] Every collected field, its purpose, its lawful basis and its retention period appears in the policy — reconciled against `docs/data/model.md` by a test
- [ ] Export returns the subject's complete data within the statutory window, audited
- [ ] Erasure **anonymises referral edges rather than dropping them**, and leaves no personal data
- [ ] The global rules page carries every required section — schema-validated — and every revision is immutable at its versioned URL

## Telemetry
Policy page views, DSR request volume and fulfilment time, rules-page views.
