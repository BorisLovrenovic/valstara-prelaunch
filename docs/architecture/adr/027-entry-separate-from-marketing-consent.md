# ADR-027: Joining and entering are separate from marketing consent

- Status: Accepted
- Date: 2026-09-25
- Deciders: founder
- Amends: ADR-011

## Context
ADR-011 treated the double opt-in as the single consent record covering the waitlist, the launch announcement and the giveaway. Both P4 research reports independently flagged this as bundled consent. Under GDPR Art. 7(4), consent is not freely given when a service, in this case entering the prize draw, depends on it. The ICO's guidance says in terms that consenting to a prize draw is not consenting to marketing.

## Decision
- **Joining the waitlist and entering the giveaway do not require marketing consent.** Waitlist and giveaway data are processed to provide the service the person asked for (GDPR Art. 6(1)(b)). That covers these messages: verification and its reminders, the status link, referral and milestone updates, the giveaway entry receipt, winner notification, and the single launch-access notification that joining the waitlist promises.
- **Marketing is a separate, optional, unticked opt-in on the signup form.** It covers the weekly update, product news, any other broadcast, and marketing by the storefront after handoff. It can be switched on or off later from `/me`.
- **Consent at signup takes effect when the address is verified.** The same verification click that proves ownership of the address confirms the opt-in, so marketing consent is double-opted-in. An opt-in from `/me` takes effect immediately, because the signed status link already proves ownership of the address.
- **What is recorded:** the subscriber row holds the current state (`marketing_consent_at`, `marketing_consent_version`, `marketing_consent_source`, `marketing_opt_in_pending`). Every grant and every withdrawal is an audited event. The wording shown is versioned.
- **Withdrawal never costs the person their waitlist place or their giveaway entries.** Unsubscribing from a marketing message withdraws marketing consent only. Leaving everything is a separate, explicit action.
- **Broadcast sending re-checks current marketing consent at dispatch,** just as it re-checks suppression.

Double opt-in stays unconditional (ADR-011). What changes is what it evidences: ownership of the address in every case, plus marketing consent when the person opted in.

## Alternatives rejected
- **One bundled consent (the original ADR-011 wording)** — entry becomes conditional on marketing, which invalidates the marketing consent.
- **A separate "draw only" entry form** (research report 1) — it works, but it duplicates the signup route when a single form with a separate opt-in achieves the same result.
- **A pre-ticked opt-in** — unlawful in the target markets, and already forbidden by the copy rules.

## Consequences
- The broadcast audience becomes the marketing-consented subset of verified, unsuppressed subscribers. It is smaller than the waitlist, and that is honest.
- The handoff payload carries the marketing-consent state, and the storefront must honour it.
- Classifying the launch-access notification as a requested service message, rather than marketing, is confirmed in the privacy audit (E11-05).
- **What would reopen this decision:** regulator guidance or counsel advice that changes the lawful basis for waitlist messages.
