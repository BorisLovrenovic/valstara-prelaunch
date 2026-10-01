# ADR-019: EU and UK Article 27 representatives named before the first signup

- Status: Superseded by ADR-029
- Date: 2026-08-25
- Deciders: founder

## Context
A controller outside the EU offering goods to EU data subjects must designate an Article 27 representative in writing. The UK requires a separate one under UK GDPR. Both must be **named in the privacy policy**, and the privacy policy must exist before any personal data is collected.

## Decision
**Appoint both, before the first signup.** Bought as a service — Prighter, DataRep, EDPO or similar — at roughly **€200–500/year each.**

**The build enforces it.** A build-time assertion checks that neither representative field is a placeholder, and **the signup route is unreachable while that assertion fails.**

## Alternatives rejected
- **Appoint later, launch now** — the obligation attaches when the data is collected, not when it is convenient.
- **Appoint the EU representative only** — UK GDPR is a separate regime requiring a separate appointment. Two appointments, two fees.
- **Track it as a checklist item** — a checklist item under launch pressure is a checklist item that gets deferred. A failing build cannot be.

## Consequences
**This has the longest lead time of any prerequisite, and it gates the first signup.** It is procurement, not engineering — start it before anything else.

Neither appointment creates a subsidiary or a taxable presence, and each must be established in a member state where the data subjects are. Both hold a copy of the records of processing.

Recorded as an open item in the ADR index until the appointments are made.
