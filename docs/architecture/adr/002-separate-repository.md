# ADR-002: A separate repository from the storefront

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
v1 put the waitlist inside the storefront repository as a route group, so launch would be a deletion and a deploy. The founder prefers clean separation.

## Decision
**A separate repository, `valstara-prelaunch`.** Accepted with two carried costs stated openly rather than discovered later.

## Alternatives rejected
- **Inside the storefront repo** — component reuse and a trivial launch, at the price of a throwaway campaign living inside the codebase that has to be maintained for years.

## Consequences

**Two costs, both real:**

1. **~15–25 hours of component rebuild in the storefront later** — buttons, cards, inputs, theme handling, the country selector, the FAQ accordion. Unavoidable once the frameworks differ.
2. **Trust and legal pages must be ported** so `/legit`, `/guarantee`, `/about`, `/terms` and `/privacy` keep their URLs and their accumulated authority. Copy plus markup — a few hours, not a rewrite of the argument.

**Three mitigations, from the first commit, and they are the reason this is affordable:**

- Design tokens as a **plain CSS custom-property file** with no framework coupling (ADR-015). It transfers verbatim and is the single highest-value portable artifact.
- Trust-page copy as **content files** (ADR-017), so porting is a copy operation.
- The two repositories kept deliberately consistent on tokens. **Drift during the campaign means the storefront inherits a subtly different brand** — named risk 6.

Also a consequence: launch becomes a host cutover rather than a deploy (ADR-021).
