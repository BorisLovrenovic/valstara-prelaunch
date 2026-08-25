# ADR-015: Design tokens in one framework-free CSS file

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
The pre-launch site and the storefront are separate repositories on different frameworks (ADR-002). Components will not transfer. Something must, or the storefront starts from a blank brand.

## Decision
**Every token — colour, type scale, spacing, radii, motion — lives in `src/styles/tokens.css` as CSS custom properties, with no framework coupling of any kind.** No Tailwind config, no JS theme object.

**No component contains a literal colour, font, radius, spacing or duration value.** CI-scanned; a hex code in a component is a review blocker.

**This file is canonical during pre-launch.** The storefront copies it verbatim; any later change is made here first and re-ported.

## Alternatives rejected
- **A Tailwind config as the source** — couples the tokens to a build tool the storefront may not share.
- **A JS/TS theme object** — same coupling, plus it cannot be consumed by plain CSS.
- **A published npm package shared by both repos** — correct at scale, over-engineered for one throwaway site and one storefront, and it introduces a release cycle between a colour change and seeing it.

## Consequences
**The single highest-value portable artifact in the repository**, and the reason ADR-002's cost is 15–25 hours rather than a brand restart.

**Named risk 6 is the failure mode**: if the design system diverges during the campaign, the storefront inherits a subtly different brand and nobody notices until both are live side by side. The port checklist in `docs/brand/tokens.md` exists for that reason, and it is kept current from the first commit rather than assembled at launch.

Values are **transcribed** from the brand guidelines, not invented here. A placeholder value shipping to production is a blocking finding.
