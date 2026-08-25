# ADR-022: The waitlist database is frozen read-only for 90 days after handoff

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Once the list is imported into Medusa, the waitlist database has no operational role. The temptation is to drop it. The reason not to is that it is the only record of how every customer got there.

## Decision
**Freeze it read-only for 90 days after the handoff**, as the audit trail. Then review for deletion.

It is the record that answers, after the fact: was this referral real, why was that account disqualified, what rules version governed those entries, who was in wave 2 and why.

## Alternatives rejected
- **Drop it after import** — destroys the evidence for exactly the questions that arrive after a prize draw.
- **Keep it writable** — a database nobody owns but anything can write to is how a stale system becomes a second source of truth.
- **Keep it indefinitely** — personal data retained without a purpose. Ninety days covers the realistic dispute window; after that the purpose has ended.

## Consequences
The import is verified against a source that cannot have changed underneath it. Disqualification and draw disputes are answerable from data.

**Read-only is enforced at the database role level**, not by convention, and the cutover checklist verifies that a write is rejected. Deletion at the end of the 90 days is a deliberate, recorded action — not an expiry that quietly does or does not happen.
