# ADR-023: Campaign flags with code-level fail-safe defaults

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
A twelve-week campaign with a public leaderboard, a prize draw and a mail programme will have at least one incident where a mechanic needs to stop **now**. Deploying under pressure is when mistakes happen.

## Decision
**A small `campaign_flag` table with flags registered in code, each carrying a fail-safe default.** The database value is an override.

- **An unregistered key throws** — never a silent `false`.
- **A lookup failure returns the code default** — fail-safe, never fail-open.
- Reads are cached in-process with a short TTL; `set()` invalidates immediately, and **the worst-case propagation delay is documented**. A lever whose effect is invisible for an unknown period is not a lever.

Eight flags, listed in `docs/features/README.md#flag-registry`. **Two default off** — `giveaway.open` and `email.broadcast` — because each depends on something outside the code.

## Alternatives rejected
- **Environment variables** — changing one means a deploy, which is the thing this exists to avoid.
- **A hosted flag service** — a vendor and a monthly line for eight booleans.
- **No flags** — leaves "deploy under pressure" as the only response to an incident.

## Consequences
**`leaderboard.public` is the campaign's most important flag**: a credibility incident on the board is a reputational problem that must be stoppable in seconds, and the weekly email's top-10 block is the designed fallback surface.

Flags are drilled, not assumed — flipping `leaderboard.public` and confirming the section disappears is a chaos drill (`docs/architecture/fallbacks.md#chaos-drills`).
