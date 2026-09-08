# ADR-025: Campaign business configuration — tier ladder, wave bands, survey v1

- Status: Accepted
- Date: 2026-09-08
- Deciders: founder (2026-09-08 — the discount percentages and the survey taxonomy are confirmed as the production values, not placeholders)

## Context
Several tickets deliberately defer their business numbers to keep the schema and the
mechanic decisions clean: E4-05 (the tier ladder), E4-06 (which rewards are cheap
versus high-value), E4-07 (the wave distribution) and E6-03 (the two survey
questions). The classification *principle* is already settled — ADR-012 fixes cheap
versus high-value; the data model fixes the `access_window` and `category_preference`
export contract — but the concrete values were left open.

E3-07 performs all five verification transitions **in one transaction** (set
`verified`, confirm the edge, settle/hold rewards, assign the wave, render the survey).
That transaction cannot be implemented against `TODO`s: each branch needs a value.
This ADR supplies them, records them as **configuration** (changeable without a
migration, per E4-05/E4-06/E4-07), and is the single source of the numbers.

## Decision
The values below are the **confirmed production values**. They are configuration —
editing them requires no schema change and no migration. Downstream specs point here as
the single source of the numbers.

### Reward classification (restates ADR-012 — not re-litigated)
- **Cheap — settle on confirmation:** the base draw entry, `+1` entry per confirmed
  referral, tier progress, and wave position (`wave_upgrade`).
- **High-value — enter `held`, settle only on a post-launch first order, `void` at
  campaign close:** milestone discount codes and milestone **bonus** entries.

### Entries
- **Base entry:** `1`, accrued on verification.
- **Per confirmed referral:** `+1` entry — cheap, settles on confirmation.

### Tier ladder (`milestone_award`, unique on `(subscriber_id, tier)`)
| Tier | Threshold (confirmed referrals) | Cheap (settled on confirmation) | High-value (`held`) |
|---|---|---|---|
| 1 | 3 | tier progress · `wave_upgrade` | **15%** launch discount code · `+5` bonus entries |
| 2 | 5 | tier progress · `wave_upgrade` | **25%** launch discount code · `+10` bonus entries |

Tier 1 ships. Tier 2 is cut-list item 7 (`docs/features/README.md#cut-list-in-order`):
added mid-campaign with no migration, and **never retroactively awarded** to people who
already passed it unless a separate, audited backfill runs (E4-05).

### Access-window bands (`access_window`, assigned at verification — E4-07)
Assignment is deterministic **at the moment of verification**, so the bands are absolute
verification-order thresholds, not shares of the final list (the final size is not known
when a row verifies).

1. **Base band from verification order:** `≤ 1,000 → wave-1` · `≤ 5,000 → wave-2` ·
   `≤ 15,000 → wave-3` · else `wave-4`.
2. **Tier promotes:** each tier promotes the subscriber one band toward `wave-1`
   (Tier 1 → one band, Tier 2 → two bands), capped at `wave-1`. **Promotion only, never
   demotion**, and every promotion is audited (E4-07 acceptance criterion).

The four values `wave-1`…`wave-4` are frozen — they become Medusa customer groups at
handoff (`docs/data/model.md#the-launch-day-handoff-contract`). Only the *thresholds*
above are tunable.

### Survey v1
- **`version`:** `"2026-09-08"`. A later version never rewrites earlier responses
  (E6-03); the stored version keeps each answer interpretable.
- **Q1 — `category_preference`** (multi-select; **this is the handoff export field**):
  `[apparel, footwear, accessories, home, beauty]`. This is the **canonical** taxonomy:
  prelaunch owns it, and the storefront's Medusa product categories are created to match
  it at handoff — the export does not bend to a category set defined elsewhere.
- **Q2 — `shopping_frequency`** (single-select, the qualifying question):
  "How often do you shop this kind of product?" → `[weekly, monthly, a few times a year, rarely]`.
- **Skipping is a first-class outcome** — recorded, no follow-up prompt.

## Alternatives rejected
- **Leave the values as `TODO` and build E3-07 anyway** — the five-in-one transaction
  has no defined branches without them; it cannot be tested to its acceptance criteria.
- **Wave bands as a percentage of the final list** — not computable at verification time,
  when E4-07 requires the assignment to be made and recorded. Rejected for absolute
  ordinal thresholds.
- **Block all of E4/E6 until every number is founder-confirmed copy** — the *shape* of
  the mechanic never needed sign-off; only the discount % and the taxonomy did, and both
  are now confirmed (see below). Blocking the whole engine on them would have cost
  schedule for no design benefit.

## Consequences
The referral engine, wave assignment and the survey are built and tested against these
values, and tuned later without a migration. `docs/modules/referral.md`,
`docs/data/model.md` and `docs/features/survey.md` cite this ADR as the source of the
numbers; a change to any value updates this ADR in the same ticket (ADR index rule 2).

The two values that carried real-world consequence are **confirmed** (2026-09-08):
- **The held discount percentages — 15% (Tier 1) / 25% (Tier 2)** are production values.
  The launch-day handoff generates per-customer discount codes at these rates
  (`docs/data/model.md#the-launch-day-handoff-contract`).
- **The `category_preference` taxonomy** `[apparel, footwear, accessories, home, beauty]`
  is the canonical set. The storefront creates Medusa product categories to match it; the
  handoff export carries these exact tokens.

The trigger that reopens this ADR: the founder revising a discount rate or the taxonomy,
or any tuning of the wave thresholds during the campaign — each a config change, no
migration.
