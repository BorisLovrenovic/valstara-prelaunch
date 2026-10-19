# ADR-030: Founder accepts launch legal review risk

- Status: Accepted — legal review waived, not reviewed
- Date: 2026-10-18
- Deciders: founder

## Context

The E11-05 local privacy audit closed its technical findings but left a legal review outcome open. The founder-authorised `/privacy` and `/terms` pages remain drafts. No lawyer has reviewed the Turnstile storage basis, the Cloudflare processor disclosure or those pages.

## Decision

The founder accepts the risk of proceeding with the pre-launch campaign **without a lawyer's review** of:

1. The stated Article 5(3) strictly-necessary form-security basis for Cloudflare Turnstile's `cf.turnstile.u` read and write on protected forms, and the related two-entry browser-storage inventory.
2. The Cloudflare processor wording describing server-side IP, TLS and user-agent processing.
3. The current founder-authorised draft `/privacy` and `/terms` pages.

This resolves the E11-05 legal finding by **founder risk acceptance**, labelled **waived** in E11-08. It is neither legal sign-off nor a finding that the wording or processing complies with applicable law. The pages remain drafts, and reviewed replacement wording has not been supplied. A material change to this scope needs a new assessment and decision.

## Consequences

The technical privacy controls, rendered-page and source-code gates, and E12-05 production check remain required. The E11-08 privacy row records a waiver rather than a clean legal review. This decision does not complete P5: Brevo's paid plan is not yet purchased, so the campaign-open gate remains closed.
