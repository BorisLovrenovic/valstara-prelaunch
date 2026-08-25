# ADR-018: Giveaway jurisdiction exclusions enforced at point of entry

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Several target markets regulate promotional prize draws directly, in ways that are disproportionate for a campaign of this size: Italy requires local data hosting and a ministry notification; Poland requires permits and bank guarantees; Spain requires the draw to occur in Spain and taxes the prize at 10%; the Nordics have restrictive regimes; Quebec has its own, separate from the rest of Canada.

## Decision
**Exclude Italy, Poland, Spain, the Nordics and Quebec from the giveaway, decided at point of entry** from the confirmed country — and, for Canada, the confirmed province.

**An excluded visitor still joins the waitlist.** The giveaway declines, the reason is stated plainly at that point, and nothing else about their signup changes.

**Every remaining jurisdiction has a published rules page.** A jurisdiction without one is excluded — never served a generic page.

## Alternatives rejected
- **Comply everywhere** — permits, bank guarantees, local hosting and a draw held in Spain, for a campaign whose entire prize pot is smaller than the compliance cost.
- **Exclude at draw time** — an entrant who was allowed to enter and is then excluded is a complaint, and in several of these jurisdictions a legal one.
- **Rely on the terms alone** — an unenforced exclusion in a document nobody reads is not an exclusion.

## Consequences
Canada is the only country where a region is collected, and it is collected **only because it changes eligibility**. Every accrual stamps its `rules_version`, so a mid-campaign rules change is survivable: entries keep the rules in force when they accrued.

The exclusion table is **table-tested per jurisdiction**. Adding a market means adding a rules page and a test row, in the same change.
