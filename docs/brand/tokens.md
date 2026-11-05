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

The portable file also carries `--shadow-1` through `--shadow-3` (with paired dark elevations), `--container-max`, `--gutter`, `--gutter-wide`, `--section-gap`, `--section-gap-wide`, `--measure`, four weight tokens, two tracking tokens, `--tap-min`, three icon sizes, and `--layer-dock`/`--layer-skip`. Their exact values are specified in E11.5-01 of the development plan and tested against the file.

**E11.5-11a wireframe tokens (founder-authorised 2026-10-26).** The founder's wireframes ([page-design reference](page-design.md#the-wireframes-e115-11a-to-e115-11h)) replace the light `--shadow-1` to `--shadow-3` and the dark `--shadow-1` and `--shadow-2`; the dark `--shadow-3` keeps its E11.5-01 value, because the wireframes draw no dark overlay. Every colour below is a LOCKED palette value, an alpha variant of one, or black inside a shadow. **No hue is added**, and a test asserts it.

| Group | Tokens | Light | Dark (both blocks) |
|---|---|---|---|
| Edge | `--edge`, added to every elevated surface's shadow | `0 0 0 0 transparent` | `0 0 0 1px rgba(240,240,238,.1)` |
| Dark redefinitions | `--line`, `--coral-tint` | unchanged | `rgba(240,240,238,.14)`, `rgba(255,138,102,.16)` |
| Roles | `--field` (input and checkbox border) · `--on-coral` (primary label) · `--error-text` | `var(--ink-600)` · `#101014` · `var(--error)` | `--field` and `--on-coral` unchanged · `--error-text: var(--ink)` (`#C0392B` on `#171733` is 3.2:1) |
| Component values | `--shadow-button` · `--overlay-hover`, `--overlay-active` · `--on-midnight-border`, `-hover`, `-active`, `-disabled`, `-disabled-border` · `--shadow-chip` · `--banner-tone-dark`, `-light`, `-ink` · `--shadow-sticky` | the ticket's values | unchanged |
| Banner constants (E11.5-11c, founder-authorised 2026-10-27) | `--banner-white` (the logo chip, and white text on a brand colour) · `--banner-ink` (the chip's name, and ink text on a light brand colour) | `#ffffff` (LOCKED `surface`) · `#101014` (LOCKED `ink`) | unchanged: the chip stays light and banner text keeps its contrast on the brand colour in both themes |
| Banner shapes (E11.5-11c, founder-authorised 2026-10-27; t4 to t6 E11.5-11d, 2026-10-28) | `--banner-shape-t1-top`, `-t1-right`, `-t2-right`, `-t2-bottom`, `-t3-top`, `-t3-left`, `-t4-top`, `-t4-right`, `-t5-top`, `-t5-right`, `-t6-top`, `-t6-left`: the wireframe's `.t1` to `.t6` tonal-shape offsets, one token per side each shape sets, in percentages of the banner | `-80%` · `-12%` · `-20%` · `-75%` · `-140%` · `-34%` · `-90%` · `16%` · `-64%` · `6%` · `38%` · `52%` | unchanged |
| Dark chip shadow (E11.5-11d, founder-authorised 2026-10-28) | `--shadow-chip-dark`: the shadow of the dark chip a white-only logo takes | the `--shadow-chip` value | `0 0 0 1px rgba(240,240,238,.18), 0 6px 14px rgba(0,0,0,.3)`, a light ring so the dark chip holds its edge on a dark page |
| Dark-only values | `--banner-edge`, `--banner-edge-hero`, `--banner-edge-hover`, `--shadow-band` | `0 0 0 0 transparent` (light base; `--shadow-band` is `none` from E11.5-11j) | the 1px light edges at .1, .12 and .14, and the guarantee-band shadow |
| Composites | `--ring-focus`, `--inset-line`, `--inset-strong`, `--ring-numeral` (E11.5-11f), `--inset-on-midnight`, `--inset-on-midnight-disabled` | a token colour with a fixed width | follow their colours |
| Layout | `--grid-columns` 4 / `--grid-columns-wide` 12, `--grid-gap` 16px / `--grid-gap-wide` 24px, `--header-height` 72px / `--header-height-wide` 80px | — | — |
| Lines and focus | `--radius-check` 4px, `--border-thin` 1px, `--border-check` 1.5px, `--border-strong` 2px, `--focus-width` 2px, `--focus-offset` 2px, `--underline-thickness` 2px, `--underline-offset` 3px | — | — |
| Spacing off the 8px ramp | `--space-0-5` 4px, `--space-0-75` 6px, `--space-1-5` 12px, `--space-1-75` 14px (E11.5-11c, the medium hero chip), `--space-2-5` 20px (named for their share of the 8px step) | — | — |
| Sizes | `--icon-base` 20px, `--star-sm` 12px and `--star-md` 16px wide (2:3), `--control-height` 48px, `--check-size` 20px, `--badge-size` 24px, `--tile-size` 40px, and the derived `--control-inset-strong` and `--check-target-offset` | — | — |

**The closed breakpoint set is `22.5rem`, `48rem`, `64rem` and `80rem`** (E11.5-11a amends E11.5 design rule 7). Small is below 48rem, medium is 48rem to below 64rem, large is 64rem and up, and wide is 80rem and up. `22.5rem` is used by the header's Join button and, as the 320 frame draws it, by the landing hero's tight logo strip (E11.5-11c, founder-authorised 2026-10-27). `40rem` is no longer in the set, because no query uses it. These are the only literal lengths permitted in an `@media` condition, because CSS custom properties cannot be used there.

E11.5-04 moved the provider showcase's presentation values into the portable file. `--space-0: 0` remains. E11.5-11d (founder-authorised 2026-10-28) removed the other four, `--provider-layer-decor`, `--provider-banner-tone`, `--provider-depth-brightness` and `--provider-rail-peek`, because the wireframe banner replaced the gradient tone, the depth circle and the peeking rail column, and nothing referenced them.

### Final-design tokens (E11.5-11j)

The token delta from the final design's change log, `docs/design/final-ui/project/ChangeLog.dc.html`. Each is an alpha of a LOCKED colour or a black-based shadow: **no hue and no type size is added**, and tests assert it. A dark value of "same" means the token has no dark redefinition and inherits its light value.

| Token | Light | Dark (both blocks) | Use |
|---|---|---|---|
| `--on-midnight-600` | `rgba(250,250,250,.74)` | `rgba(240,240,238,.74)` | Secondary text on midnight: band line, promise text, footer legal (9.52:1) |
| `--on-midnight-line` | `rgba(250,250,250,.12)` | same | Promise panel edges, the footer rule, and the disabled on-midnight button's edge |
| `--wash` | `rgba(16,16,20,.05)` | `rgba(240,240,238,.06)` | Nav hover, the FAQ disc, segmented track, neutral tiles, the info notice |
| `--wash-strong` | `rgba(16,16,20,.09)` | `rgba(240,240,238,.10)` | Pressed states, the FAQ disc on hover, empty meter segments, skeletons, inline code |
| `--success-tint` | `rgba(46,125,87,.12)` | `rgba(46,125,87,.28)` | Success tiles on `/verify`, `/unsubscribe`, `/giveaway/award` |
| `--error-tint` | `rgba(192,57,43,.10)` | `rgba(192,57,43,.24)` | The error tile (unsubscribe failed) |
| `--banner-ring-dark`, `--banner-ring-ink` | `rgba(255,255,255,.20)`, `rgba(16,16,20,.14)` | same | The ring layer inside provider banners (E11.5-11n) |
| `--banner-sheen` | `rgba(255,255,255,.14)` | same | The canvas's top-left light on hero stack banners. **No consumer yet:** final-design rule 4 leaves the hero stack as built |
| `--shadow-sticky` | unchanged | `0 -1px 0 rgba(240,240,238,.1), 0 -16px 40px rgba(0,0,0,.5)` | Both phone sticky bars |
| `--shadow-band` | `none` | unchanged | The guarantee band and the footer in dark |
| `--overlay-hover` | unchanged | `inset 0 0 0 100px rgba(16,16,20,.10)` | Primary button hover |

The delta's other entries were already built under the same name and value, and are reused: `--on-midnight-border`, `--on-midnight-hover`, `--on-midnight-active`, `--on-midnight-disabled`, `--shadow-chip`, `--shadow-chip-dark`, `--shadow-button`, `--overlay-active`, the dark `--shadow-3` and `--ease-out`. **Not built:** `--placeholder-block` and `--placeholder-text` (final-design rule 3, the `IMG-01` slot is not built) and the frames-only 6px radius, which is not part of the product. No delta entry adds a hue or a type size.

`--on-midnight-disabled-border` is now `var(--on-midnight-line)`, the canvas's disabled edge, where the wireframes had `.2`.

The primitives need these values beyond the delta, under final-design rule 6:

| Token | Value | Use |
|---|---|---|
| `--success-icon` | `var(--success)`, dark `var(--ink)` | A success icon on a card or notice. `#2E7D57` on the dark surface is below 3:1 |
| `--ring-focus-error` | `0 0 0 2px var(--surface), 0 0 0 4px var(--error)` | The focus ring of an invalid input |
| `--inset-error` | `inset 0 0 0 1.5px var(--error)` | An error notice's rule |
| `--radius-link` | `2px` | A text link's focus outline |
| `--stroke-heavy` | `2.25` | The heavier stroke of a glyph inside a control, such as the checkbox mark, in the icon's 24-unit grid |
| `--arrow-shift`, `--arrow-shift-card` | `0.125rem`, `0.1875rem` | The 2px link arrow move and the 3px interactive-card arrow move |
| `--error-rise` | `0.25rem` | How far a field error rises as it appears |
| `--spinner-opacity`, `--duration-spin` | `0.8`, `800ms` | The in-flight spinner's opacity and its turn |

The arrow, error and spinner values sit with the motion tokens on bare `:root`, with no dark redefinition.

### Motion tokens (E11.5-11i)

Founder-authorised 2026-10-30, with design rule 12 as amended. The motion tokens sit on bare `:root` only and have no dark redefinition, because motion does not change with the theme. They are starting values: the founder reviews them in motion at E11.5-12, and a change is a token edit. How they are used is in the [page-design motion section](page-design.md#motion-e115-11i).

| Token | Value | Use |
|---|---|---|
| `--duration-fast` | `150ms` | State transitions: buttons, links, inputs, chips, the sticky bar's slide (unchanged) |
| `--duration-base` | `200ms` | State transitions: cards, the switch, the disclosure chevron (unchanged) |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Every state transition (unchanged) |
| `--duration-enter` | `400ms` | One element's entrance or reveal |
| `--stagger` | `60ms` | The step between items that enter together (at most four, so 400 + 3 × 60 = 580ms) |
| `--duration-page` | `200ms` | The page and theme cross-fade |
| `--ease-enter` | `cubic-bezier(0.22, 1, 0.36, 1)` | Entrances and reveals. No overshoot: neither control point's y-value is above 1 |
| `--reveal-distance` | `1.5rem` | How far revealed content rises |
| `--enter-distance` | `0.75rem` | How far an entrance rises |
| `--lift` | `-0.125rem` | The 2px interactive-card lift |
| `--press-shift` | `0.0625rem` | The 1px button press |
| `--reveal-range` | `entry 0% entry min(100% - 1px, 20vh)` | The stretch of a revealed element's view timeline over which it reveals. It ends a pixel before the element is fully in view, or once it is 20% of the viewport in, whichever comes first, so it is at rest at the end of any page and by 70% of the viewport at any height |
| `--reveal-step` | `min(20%, 4vh)` | The start offset between indexed siblings in a revealed row: a fifth of the range, so `motion.css` caps `--reveal-index` at 4 |

The CI literal scan rejects a literal duration, delay, easing curve, animation range or movement distance in any component or global stylesheet, so each of these values is used through its token.

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
- Subset to the Latin ranges actually used. Only Instrument Sans WOFF2 is preloaded because it is the above-fold face; JetBrains Mono loads only when a changing figure needs it. On the landing page that is the step badges and the reward figures; it is never preloaded. `.tabular-figure` applies the mono family and `font-variant-numeric: tabular-nums` together.

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

**E11.5-11a port addition:** the file is still copied verbatim. It now also carries the wireframe elevations, `--edge` and the dark-only edge and band values, the `--field`, `--on-coral` and `--error-text` roles, the dark `--line` and `--coral-tint`, the button, on-midnight, chip, banner and sticky-bar component values, the grid and header tokens, the line and focus widths, the four off-ramp spacing steps and the control sizes. Re-run the no-new-hue, contrast-matrix and dark-name-set tests after the port. The storefront's media queries use the closed set `22.5rem`, `48rem`, `64rem` and `80rem`.

**E11.5-11c port addition:** the file also carries `--banner-white` and `--banner-ink`, declared once on `:root` with no dark redefinition, because a provider banner's chip and text do not change with the theme, plus `--space-1-75` and the six `--banner-shape-t*` offsets.

**E11.5-11d port change:** the file adds the six `--banner-shape-t4/t5/t6-*` offsets and `--shadow-chip-dark`, which has a dark value in both dark blocks. It drops `--provider-layer-decor`, `--provider-banner-tone`, `--provider-depth-brightness` and `--provider-rail-peek`. A storefront that copied an earlier version must remove those four. Re-run the dark-name-set and no-new-hue tests after the port.

**E11.5-11f port addition:** the file adds `--ring-numeral` (founder-authorised 2026-10-29), declared once on `:root`; its colour follows `--coral` in both themes.

**E11.5-11j port change:** the file adds the final-design tokens above. `--shadow-band` changes from `0 0 0 0 transparent` to `none` in light, so a storefront rule must use it alone, never in a shadow list. `--on-midnight-disabled-border` now resolves to `--on-midnight-line`. The dark blocks gain `--on-midnight-600`, `--wash`, `--wash-strong`, `--success-tint`, `--error-tint`, `--success-icon`, `--overlay-hover` and `--shadow-sticky`. Re-run the no-new-hue, contrast-matrix and dark-name-set tests after the port. The file is still copied verbatim.

**E11.5-11i port addition:** the file adds the motion tokens above, declared once on bare `:root` with no dark redefinition. They port with `tokens.css`. `src/styles/motion.css` (the entrance and reveal utilities, page transitions and smooth anchor scrolling) is waitlist presentation, not part of the portable file: the storefront adopts or drops it at port time. If adopted, it keeps every rule inside `prefers-reduced-motion: no-preference`.

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

`src/content/giveaway-award-catalog.json` is a pre-launch award configuration file with no published prose and no storefront port target. `src/content/landing-hero.json` and its validator `src/content/landing-hero.ts` (E11.5-11c) choose the waitlist hero's three providers from the showcase; they carry no prose and have no storefront port target. The rules articles above retain their recorded rendered-article SHA-256 values when ported; archived versions keep the E11-04 notice outside the hashed article, `noindex`, and sitemap exclusion. The runbook's named current version must equal `currentRules()`.

The font transfer set is all six files in `public/fonts/` (the Instrument Sans and JetBrains Mono WOFF2 and WOFF files and both OFL licence files). Their four `@font-face` declarations, including local metric-matched fallbacks and `/fonts/` URLs, live in `src/styles/tokens.css`; copy that stylesheet verbatim and place the font assets at the same URLs. Confirm the destination's reverse mapping lists only these sources for the font layer.
