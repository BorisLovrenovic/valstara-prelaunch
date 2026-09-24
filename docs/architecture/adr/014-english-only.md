# ADR-014: English only, served at the root

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
The target markets are multilingual, and the site carries 3–5k words of trust and legal copy — the content where translation quality matters most and machine translation is least acceptable.

## Decision
**English only. No i18n framework.** Served at the **root**, not at `/en/`.

## Alternatives rejected
- **A reviewed six-language pass** — €500–2,000 for 3–5k words of trust and legal copy. That is **10–40% of the entire marketing budget, spent on the throwaway artifact.**
- **Machine translation** — on legal text and trust copy, for an audience judging legitimacy by exactly this kind of signal. No.
- **English at `/en/` with a redirect from the root** — makes adding `/de/` cheaper later, at the cost of a redirect on every visit now, for a site whose successor will re-decide this anyway.

## Consequences
Serving at the root means **adding `/de/` later is additive rather than a site-wide redirect** — the transition cost is deferred, not increased. Astro's i18n routing is there when the store needs it.

**Language and market are separate concerns**, and conflating them is what makes i18n look mandatory when it is not. *(Amended 2026-09-25: the country selector this paragraph originally cited was removed by ADR-026, and no country is collected at signup.)*
