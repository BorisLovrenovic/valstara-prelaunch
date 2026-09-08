# Feature: Preference survey

## Summary
Two questions on the verification success page — category preference and one qualifying question — written back to the subscriber so the launch segmentation is real rather than guessed. **This is deliberately not a separate step**: the success page is the highest-attention moment in the funnel, and a second page costs completion.

## Feature flag
`survey.enabled` — default on. Off skips the questions; verification is unaffected.

## Question set (v1 — ADR-025)
`version` = `"2026-09-08"`. A version change never rewrites earlier responses.

1. **`category_preference`** (multi-select — **this is the handoff export field**): `[apparel, footwear, accessories, home, beauty]`. This is the **canonical** taxonomy — the storefront's Medusa product categories are created to match it at handoff (ADR-025).
2. **`shopping_frequency`** (single-select, the qualifying question): "How often do you shop this kind of product?" → `[weekly, monthly, a few times a year, rarely]`.

Skipping either is a first-class outcome, recorded, with no follow-up prompt.

## User flows
1. **Ask** — on the verification success page, below the referral link, answerable in one interaction each.
2. **Write back** — answers stored as a versioned `survey_response` and the category preference denormalised onto the subscriber, because that is the field the handoff exports.
3. **Change** — the same questions are re-answerable from `/me`; a resubmission replaces the previous answer and the replacement is audited.

## Edge cases and error states
Skipped → **no penalty and no nagging.** A skipped survey is a valid state, not a funnel to re-enter. Questions change mid-campaign → the stored `version` keeps earlier answers interpretable; a new version never rewrites old responses. Submitted twice → replaces, audited. Submitted for an unverified subscriber → rejected; **only a verified person has a preference worth storing.**

## Acceptance criteria
- [ ] The questions render on the verification success page and are answerable **without a page load**
- [ ] Skipping is a first-class outcome with no follow-up prompt
- [ ] Answers are validated against the **versioned** question set, and the version is stored
- [ ] `category_preference` is written to the subscriber, because that is the export field
- [ ] A resubmission replaces and is audited
- [ ] An unverified subscriber cannot submit

## Telemetry
Survey completion rate, per-question skip rate, answer distribution by country and source, completion versus subsequent referral activity.
