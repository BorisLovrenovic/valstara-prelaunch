# Design Tokens — the Portable Contract

Status: authoritative. Implements ADR-015. **These are engineering constraints, not styling preferences.**

## Why this file outranks its own contents

The pre-launch site and the storefront are separate repositories on different frameworks (ADR-002). The component library does not transfer; **the token file does.** It is the single highest-value thing to keep portable, and named risk 6 in the stack decisions is exactly what happens if it drifts: the storefront inherits a subtly different brand, and nobody notices until both are live side by side.

So the rule is stronger than "use tokens":

1. **One file — `src/styles/tokens.css` — declares every token as a CSS custom property.** No Tailwind config, no JS theme object, no framework coupling of any kind. It must be copyable into the Next.js storefront **verbatim**.
2. **No component contains a literal colour, font family, radius, spacing or duration value.** CI-scanned. A hex code in a component is a review blocker.
3. **The values come from `Brand Identity Guidelines — Valstara.md`.** This repository transcribes them; it does not invent them, and it does not "improve" them. Where the guidelines are silent, that is a founder question, not a developer decision.
4. **This file is canonical during pre-launch.** When the storefront starts, the token file is copied from here, and any subsequent change is made here first and re-ported.

## Token groups and their shape

The names below are the contract. **The values are transcribed in E2-01 from the brand guidelines** — a placeholder value shipping to production is a blocking finding.

```css
:root {
  /* colour — semantic roles, not paint names */
  --paper: …;          /* page background */
  --surface: …;        /* cards, panels, inputs */
  --ink: …;            /* primary text */
  --ink-secondary: …;  /* secondary text */
  --ink-tertiary: …;   /* placeholders, disabled */
  --line: …;           /* borders, dividers */
  --accent: …;         /* primary accent */
  --accent-tint: …;    /* accent backgrounds */
  --accent-contrast: …;/* text on accent */
  --band: …;           /* the dark contrast band */

  /* functional — UI only, never brand surfaces */
  --error: …; --warning: …; --success: …;

  /* type */
  --font-sans: 'Instrument Sans', …;
  --font-mono: 'JetBrains Mono', …;
  --step--1 … --step-5: …;   /* the scale, not literal sizes at call sites */
  --leading-tight … --leading-loose: …;

  /* space, radius, motion */
  --space-1 … --space-12: …;
  --radius-sm/-md/-pill: …;
  --duration-fast/-base: …;  --ease-out: …;
}
```

Dark values are declared in a **single** `[data-theme="dark"]` block that redefines the same names. A token whose only definition lives inside a media query or a theme block is a defect — the light palette is the base, always.

## Rules that bind regardless of the palette

- **Light-first. Dark mode is a user toggle, never the default**, and the toggle must not flash on load.
- **Body text clears WCAG AA (4.5:1) in both themes.** Verified per pairing by an automated contrast test over the token matrix, not assumed from the guidelines.
- **The accent must not carry body text** unless the transcribed value clears AA at body size — verified, not asserted.
- **`--error` must be visibly distinct from `--accent`.** Never signal an error with the accent colour.
- **Prices, counts, codes and any figure that changes use the mono face with tabular figures.** A leaderboard whose numbers jitter between refreshes reads as unstable.
- Motion is short and eased; **no bounce, no parallax, no auto-advancing anything.** `prefers-reduced-motion` is respected everywhere, not just on decorative elements.
- **Nothing cramped.** Generous card padding and section rhythm; the visual signal of a legitimate company is space, and the audience is reading for exactly that signal.

## Type

**Instrument Sans and JetBrains Mono**, both OFL, both **self-hosted as WOFF2** (ADR-016).

- **Never the Google Fonts CDN.** The Munich ruling makes it a live liability in a named target market, and self-hosting is the correct default regardless.
- **Metric-matched fallbacks with `size-adjust` and `ascent-override` from the first commit.** Söhne is bought at store launch, and the swap should then be one `@font-face` change plus a QA pass — not a re-layout.
- Subset to the Latin ranges actually used, preloaded for the faces above the fold only.

## Port checklist

Kept current from the first commit, because it is what makes launch day a checklist rather than a discovery exercise:

| Artifact | Port target | Verified |
|---|---|---|
| `src/styles/tokens.css` | Storefront global stylesheet, **verbatim** | E11-07 |
| `src/content/legit.md`, `guarantee.md`, `about.md` | `/legit`, `/guarantee`, `/about` | E11-07 |
| `src/content/terms.md`, `privacy.md` | `/terms`, `/privacy` — ported and revised in place | E11-07 |
| Font files and `@font-face` declarations | Storefront font layer | E11-07 |
