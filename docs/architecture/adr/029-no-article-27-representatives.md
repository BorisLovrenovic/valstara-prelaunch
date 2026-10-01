# ADR-029: Do not appoint Article 27 representatives for pre-launch

- Status: Accepted
- Date: 2026-10-01
- Deciders: founder
- Supersedes: ADR-019

## Context

ADR-019 and prerequisite P2 required an EU and a UK representative before the first signup. E9-03 was to enforce both appointments in the build and signup route. The founder reversed that decision on 2026-10-01.

## Decision

Valstara will not appoint an EU or UK Article 27 representative for this pre-launch campaign. E9-03 publishes `/terms` and `/privacy` without representative fields, a representative build assertion or a representative-dependent signup gate.

The founder authorised temporary draft wording for these two pages while reviewed wording is unavailable. Each page identifies itself as a draft. This authorisation does not turn draft wording into reviewed legal copy.

## Consequences

The privacy notice cannot name a representative. The prior representative claim on `/legit` is removed. The plan, legal feature specification, compliance document, prerequisites and launch checklists must reflect this decision.

The immutable giveaway rules revisions published before this decision still claim that representatives are listed in `/privacy`. They cannot be edited in place; a new revision is needed to correct the current rules page.

This is a founder risk decision, not a finding that an exemption applies. The [EU GDPR Article 27](https://eur-lex.europa.eu/eli/reg/2016/679) and the [ICO's UK representative guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/international-transfers/receiving-personal-information-from-the-eea/) remain the applicable external references. The E11-05 privacy audit must record the unresolved legal assessment before campaign launch.
