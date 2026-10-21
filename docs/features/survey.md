# Feature: Preference survey

## Summary
Two questions on the verification success page — category preference and one qualifying question — written back to the subscriber so the launch segmentation is real rather than guessed. **This is deliberately not a separate step**: the success page is the highest-attention moment in the funnel, and a second page costs completion.

## Feature flag
`survey.enabled` — default on. Off skips the questions; verification is unaffected.

## Question sets (ADR-025, amended by ADR-031)
New `/verify` and `/me` renders use version `"2026-10-19"`:

1. **`category_preference`** (multi-select — **the handoff export field**): `[ai, subscriptions, software, gift_cards, game_keys, game_top_ups, in_game_currency]`. Labels: AI tools, Streaming and subscriptions, Software, Gift cards, Game keys, Game top-ups, In-game currency. These match the storefront navigation categories.
2. **`shopping_frequency`** (single-select): "How often do you buy digital goods?" → `[weekly, monthly, a few times a year, rarely]`.

Version `"2026-09-08"` remains valid for a form rendered before deployment: categories `[apparel, footwear, accessories, home, beauty]`, with the same four frequency answers. New pages never render the old labels. A version change does not rewrite an earlier response; only an explicit re-answer from `/me` replaces a response and audits that action. No backfill is needed because campaign data does not yet exist.

The launch handoff exports `category_preference` and nullable `survey_version` together. A response saved with either version retains its version; a person with no response exports `survey_version: null`. The admin CSV's fixed field contract is separate.

Skipping either is a first-class outcome, recorded, with no follow-up prompt.
On the redesigned verification success page (E11.5-07), category options
appear as selectable chips and frequency options as segmented choices. Save
and Skip have equal button weight. With JavaScript, both submit through the
existing same-origin survey route without a page load; Skip sends no selected
answers.

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
Survey completion rate, per-question skip rate, answer distribution by source, completion versus subsequent referral activity. The `survey_completed` event is emitted after commit only for the first saved submission with at least one answer (founder-authorised 2026-10-06). An all-skip submission does not emit it; a later answered submission does. Replacements do not repeat it. `survey_response.first_answered_at` preserves that fact through subsequent changes.
