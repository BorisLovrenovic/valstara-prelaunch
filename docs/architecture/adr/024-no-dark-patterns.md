# ADR-024: No countdown timers, inflated positions or manufactured scarcity

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Every hosted waitlist product ships these patterns and sells them as conversion features. LaunchList sells **ranking inflation** by name. They demonstrably lift short-term signup numbers.

## Decision
**None of them ship.** No countdown timers, no inflated or offset positions, no fake scarcity, no exit-intent popups, no pre-checked opt-ins, no visible position before verification, no dark-pattern unsubscribe.

**The count shown is the count in the database.** Any figure that is rounded or approximate is labelled as one.

This is enforced, not aspirational: the patterns are named in `docs/brand/copy-rules.md`, the never-use vocabulary is CI-scanned, and it is one of the reasons the campaign is built rather than bought (ADR-020).

## Alternatives rejected
- **Use them; everyone does** — that is precisely the argument against. The audience is a **suspicious buyer in a category full of scams**, actively scanning for exactly these signals. Every one of them makes a suspicious visitor more suspicious, which is the opposite of the brand's entire position.
- **Use a mild version** — "you're #4,182" when 300 people have signed up is not a mild version of anything.

## Consequences
Some measurable short-term conversion is given up. **What is bought is the only thing this brand is actually selling**, which is a visitor's belief that the company is real.

It also constrains the leaderboard's design (ADR-024's practical consequence): rank is the real rank, ties break deterministically, flagged accounts are excluded rather than hidden, and the board renders short rather than padded.
