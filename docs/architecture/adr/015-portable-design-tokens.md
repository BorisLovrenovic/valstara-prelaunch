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

**E11.5-01 amendment, founder-authorised 2026-10-19:** the portable file also carries the exact elevation, layout, weight, tracking, sizing and layering tokens recorded in E11.5-01 of the plan. `--on-midnight` is the required text/icon foreground role on `midnight`: it reuses locked light `paper` and dark `ink`, so it adds no palette colour. The two dark blocks keep identical token-name sets. The closed media breakpoints are 40rem, 64rem and 80rem, documented in `docs/brand/tokens.md`; CSS variables cannot appear in media conditions. The component literal scan now covers every Astro file under `src/`.

**E11.5-11 note (2026-10-24):** email clients such as Gmail and Outlook ignore CSS custom properties, so the email layout cannot use `var()`. It reads `tokens.css` at render time and inlines the resolved colour, font, size and radius values, including the dark block for `prefers-color-scheme: dark`. The token file stays the only place those values are defined, and a test changes a token fixture and checks that the mail output follows. This adds no token and changes no value.
