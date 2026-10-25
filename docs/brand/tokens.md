# Design Tokens — the Portable Contract

Status: authoritative. Implements ADR-015. **These are engineering constraints, not styling preferences.**

## Why this file outranks its own contents

The pre-launch site and the storefront are separate repositories on different frameworks (ADR-002). The component library does not transfer; **the token file does.** It is the single highest-value thing to keep portable, and named risk 6 in the stack decisions is exactly what happens if it drifts: the storefront inherits a subtly different brand, and nobody notices until both are live side by side.

So the rule is stronger than "use tokens":

1. **One file — `src/styles/tokens.css` — declares every token as a CSS custom property.** No Tailwind config, no JS theme object, no framework coupling of any kind. It must be copyable into the Next.js storefront **verbatim**.
2. **No component contains a literal colour, font family, radius, spacing or duration value.** CI-scanned. A hex code in a component is a review blocker.
3. **The values come from `docs/brand/identity-guidelines.md` §5 (colour) and §6 (typography) — LOCKED.** This repository transcribes them; it does not invent them, and it does not "improve" them. Where the guidelines are silent, that is a founder question, not a developer decision.
4. **This file is canonical during pre-launch.** When the storefront starts, the token file is copied from here, and any subsequent change is made here first and re-ported.

## Token groups and their shape

**Names and values below are both LOCKED**, transcribed from `docs/brand/identity-guidelines.md` §5 and §6. E2-01 copies them into `src/styles/tokens.css` unchanged.

```css
:root {
  /* colour — LOCKED, identity-guidelines.md §5 */
  --paper: #FAFAFA;          /* page background — cool neutral, never cream or warm */
  --surface: #FFFFFF;        /* cards, panels, inputs */
  --ink: #101014;            /* primary text */
  --ink-600: #55555E;        /* secondary text, struck-through prices */
  --ink-300: #A0A0A8;        /* tertiary, placeholders, disabled */
  --line: #E5E5E5;           /* borders, dividers */
  --coral: #E8654A;          /* primary accent — buttons, links, badges, the mark */
  --coral-lift: #FF8A66;     /* gradient terminal; small marks needing brightness */
  --coral-tint: #FDEEE9;     /* accent backgrounds, subtle highlight fills */
  --midnight: #171733;       /* dark surfaces — guarantee band, footer */
  --midnight-deep: #0D0D1F;  /* optional gradient terminal */
  --on-midnight: #FAFAFA;    /* role: text and icons on midnight */

  /* functional — UI only, never brand surfaces */
  --error: #C0392B; --warning: #B7791F; --success: #2E7D57;

  /* type — LOCKED, §6. Söhne is the eventual primary; pre-launch ships Instrument Sans (ADR-016) */
  --font-sans: 'Instrument Sans', 'Instrument Sans Fallback', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'JetBrains Mono Fallback', ui-monospace, monospace;

  /* scale — §6.1: H1 32/40 · H2 24/32 · H3 20/28 · Body 16/24 · Small 14/20 · Label 13/18 */
  --step-5: 2rem;    --leading-5: 2.5rem;    /* H1 */
  --step-4: 1.5rem;  --leading-4: 2rem;      /* H2 */
  --step-3: 1.25rem; --leading-3: 1.75rem;   /* H3 */
  --step-2: 1rem;    --leading-2: 1.5rem;    /* Body */
  --step-1: 0.875rem;--leading-1: 1.25rem;   /* Small */
  --step-0: 0.8125rem;--leading-0: 1.125rem; /* Label */

  /* radius — §7 */
  --radius-card: 12px; --radius-control: 8px; --radius-pill: 999px;

  /* motion — §7: 150–200ms ease-out */
  --duration-fast: 150ms; --duration-base: 200ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}

[data-theme='dark'] {
  --paper: #0F0F1A; --surface: #171733; --ink: #F0F0EE; --coral: #FF8A66;
  --ink-600: #A0A0A8; /* dark secondary text — see note below */
  --on-midnight: #F0F0EE;
}
```

**Spacing** follows §7: 24px minimum card padding, 64–80px between sections. Declare a `--space-*` ramp on the same 8px base and reference it everywhere.

**These are the LOCKED names.** Earlier drafts of this file used invented role names (`--accent`, `--band`, `--ink-secondary`); they are gone. The brand document's vocabulary is what the storefront inherits, and ADR-015 requires this file to transfer verbatim.

**The light palette is the base, always** — every token is defined on bare `:root`. A token whose *only* definition lives inside a media query or a theme block is a defect, because a viewer whose theme resolves neither way then gets nothing.

Dark values redefine those same names in **two** places, and both are required:

```css
:root { /* light — every token defined here */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) { /* dark — for a visitor who has expressed no preference */ }
}
:root[data-theme="dark"] { /* dark — for a visitor who has toggled */ }
```

The media block exists because **the site must render the system-preferred theme with JavaScript disabled**, and nothing can set `data-theme` without JavaScript. The attribute block exists because an explicit choice must beat the system preference. The `:not([data-theme])` guard is what keeps them from fighting: once a visitor has chosen, the media query stops applying.

**The two dark blocks must declare the identical set of token names** — a token redefined in one and not the other is a defect, and E2-01 asserts it rather than leaving it to review.

**E11.5-01 foundation (founder-authorised 2026-10-19).** `--on-midnight` is the foreground role for all text and icons on a `midnight` surface. Its light value is locked `paper` (`#FAFAFA`); its dark value is locked dark `ink` (`#F0F0EE`) in both dark blocks. The role adds no palette colour. The contrast gate checks this pairing at body-text AA in each theme, and `coral` on `midnight` at large-text/graphic AA for accents only.

The portable file also carries `--shadow-1` through `--shadow-3` (with paired dark elevations), `--container-max`, `--gutter`, `--gutter-wide`, `--section-gap`, `--section-gap-wide`, `--measure`, four weight tokens, two tracking tokens, `--tap-min`, three icon sizes, and `--layer-dock`/`--layer-skip`. Their exact values are specified in E11.5-01 of the development plan and tested against the file. The only media-query length literals allowed are **40rem, 64rem and 80rem**: small is below 40rem, medium begins at 40rem, large at 64rem and wide at 80rem. CSS custom properties cannot be used inside media conditions.

E11.5-04 moves the provider showcase's existing presentation values into the portable file: `--space-0: 0`, `--provider-layer-decor: -1`, `--provider-banner-tone: linear-gradient(to bottom right, color-mix(in srgb, currentColor, var(--surface) 45%), transparent 60%)`, `--provider-depth-brightness: 0.7`, and `--provider-rail-peek: 82%`. The gradient uses each banner's provider colour through `currentColor`; it adds no palette colour. The exact-token test includes these five values.

The [page-design engineering reference](page-design.md) defines how pages use the grid, elevations and layout checks.

**`--ink-600` carries a dark override (`#A0A0A8`) beyond the four brand-defined swaps** (founder-authorised 2026-09-05). At its base `#55555E` it renders secondary text at 2.58:1 on the dark `--paper` and 2.36:1 on `--surface`, below AA; `#A0A0A8` — the LOCKED light `--ink-300` value, reused rather than a new colour — clears 7.33:1 and 6.70:1, mirroring its 7.07:1 in light so the muted hierarchy reads identically in both themes. E2-01's contrast test covers the muted pairings in dark so this cannot regress.

## Rules that bind regardless of the palette

- **Light-first. Dark mode is a user toggle, never the default**, and the toggle must not flash on load.
- **Body text clears WCAG AA (4.5:1) in both themes.** Verified per pairing by an automated contrast test over the token matrix, not assumed from the guidelines.
- **The accent must not carry body text** unless the transcribed value clears AA at body size — verified, not asserted.
- **`--error` must be visibly distinct from `--coral`.** Never signal an error with the accent colour.
- **Prices, counts, codes and any figure that changes use the mono face with tabular figures.** A leaderboard whose numbers jitter between refreshes reads as unstable.
- Motion is short and eased; **no bounce, no parallax, no auto-advancing anything.** `prefers-reduced-motion` is respected everywhere, not just on decorative elements.
- **Nothing cramped.** Generous card padding and section rhythm; the visual signal of a legitimate company is space, and the audience is reading for exactly that signal.

## Type

**Instrument Sans and JetBrains Mono**, both OFL, both self-hosted as Latin-subset variable **WOFF2 with WOFF fallback** (ADR-016). The OFL files ship beside the binaries. Instrument Sans uses a metric-adjusted local Arial fallback (`size-adjust`, ascent, descent and line-gap overrides); JetBrains Mono does the same against Courier New.

- **Never the Google Fonts CDN.** The Munich ruling makes it a live liability in a named target market, and self-hosting is the correct default regardless.
- **Metric-matched fallbacks with `size-adjust` and `ascent-override` from the first commit.** Söhne is bought at store launch, and the swap should then be one `@font-face` change plus a QA pass — not a re-layout.
- Subset to the Latin ranges actually used. Only Instrument Sans WOFF2 is preloaded because it is the above-fold face; JetBrains Mono loads only when a changing figure needs it. `.tabular-figure` applies the mono family and `font-variant-numeric: tabular-nums` together.

## Port checklist

Kept current from the first commit, because it is what makes launch day a checklist rather than a discovery exercise:

| Artifact | Port target | Verified |
|---|---|---|
| `src/styles/tokens.css` | Storefront global stylesheet, **verbatim** | E11-07 |
| `src/content/legit.md`, `guarantee.md`, `about.md` | `/legit`, `/guarantee`, `/about` | E11-07 |
| `src/content/terms.md`, `privacy.md` | `/terms`, `/privacy` — ported and revised in place | E11-07 |
| `src/content/privacy-storage.md` | `/privacy/storage` — ported with the privacy notice | E11-07 |
| `src/content/giveaway-rules/*.md` | `/giveaway/rules` and each immutable `/giveaway/rules/<rules_version>` | E11-07 |
| Font files and `@font-face` declarations | Storefront font layer | E11-07 |

**E11.5-01 port addition:** copy the expanded `tokens.css` verbatim, including `--on-midnight`, the three shadow pairs, layout, type-weight, tracking, sizing and layering tokens. Re-run the contrast and dark-name-set tests after the port. The breakpoint literals above travel with page CSS; they are documented here because media conditions cannot reference custom properties.

E11-07 source-to-target reconciliation (targets are the storefront routes to build and verify before the DNS swap):

| Source file | Storefront target | Port disposition |
|---|---|---|
| `src/content/legit.md` | `/legit` | Port at the same URL |
| `src/content/guarantee.md` | `/guarantee` | Port at the same URL |
| `src/content/about.md` | `/about` | Port at the same URL |
| `src/content/terms.md` | `/terms` | Port and revise for storefront processing |
| `src/content/privacy.md` | `/privacy` | Port and revise for storefront processing |
| `src/content/privacy-storage.md` | `/privacy/storage` | Port with the privacy notice |
| `src/content/giveaway-rules/VAL-GW-LAUNCH-20260925-r1.md` | `/giveaway/rules/VAL-GW-LAUNCH-20260925-r1` | Retain as an archived, hash-preserved revision |
| `src/content/giveaway-rules/VAL-GW-LAUNCH-20261001-r1.md` | `/giveaway/rules/VAL-GW-LAUNCH-20261001-r1` | Retain as an archived, hash-preserved revision |
| `src/content/giveaway-rules/VAL-GW-LAUNCH-20261009-r1.md` | `/giveaway/rules/VAL-GW-LAUNCH-20261009-r1` and `/giveaway/rules` | Retain as the current, hash-preserved revision |

`src/content/giveaway-award-catalog.json` is a pre-launch award configuration file with no published prose and no storefront port target. The rules articles above retain their recorded rendered-article SHA-256 values when ported; archived versions keep the E11-04 notice outside the hashed article, `noindex`, and sitemap exclusion. The runbook's named current version must equal `currentRules()`.

The font transfer set is all six files in `public/fonts/` (the Instrument Sans and JetBrains Mono WOFF2 and WOFF files and both OFL licence files). Their four `@font-face` declarations, including local metric-matched fallbacks and `/fonts/` URLs, live in `src/styles/tokens.css`; copy that stylesheet verbatim and place the font assets at the same URLs. Confirm the destination's reverse mapping lists only these sources for the font layer.
