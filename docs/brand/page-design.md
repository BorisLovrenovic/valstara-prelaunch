# Page design — E11.5 engineering reference

The [development plan](../plan/development-plan.md#epic-e115--frontend-design) governs each ticket. This page records the shared implementation rules for the redesign; it does not change behaviour or the locked palette and type scale.

## Grid and rhythm

Use the mobile-first container: `--container-max: 75rem`, `--gutter` below 40rem and `--gutter-wide` from 40rem. Content follows one container grid; use `data-design-container` on the container and `data-grid-align="start"` or `"end"` on items whose edge must line up. Sections sit on the page ground with `--section-gap` (64px) below 64rem and `--section-gap-wide` (80px) from 64rem. Long prose has `--measure: 68ch`; it sits within the wider composition rather than creating a narrow centred page.

The closed breakpoints are **40rem, 64rem and 80rem**. Test at 320, 360, 390, 768, 1024, 1280, 1440 and 1920 CSS pixels, in light and dark themes. The CI literal scan rejects other media-query lengths and values embedded in any `src/**/*.astro` style.

## Depth, type and icons

`--shadow-1` is for cards at rest; `--shadow-2` is for the raised hero visual, hovered interactive card and sticky bar; `--shadow-3` is for overlays. Use the dark versions on dark surfaces. `--on-midnight` colours all text and icons on `midnight`. `coral` on `midnight` is reserved for large text and accents. No new colour or type-size token is introduced.

Use the existing §6.1 type sizes with weight and tracking tokens. Headings and hero copy are left-aligned. `src/components/icon.astro` is a closed inline-SVG registry with token sizes, `currentColor` and decorative hiding by default. The four-point star is a decorative accent only; never arrange three as a rating row. No icon font or remote asset is loaded.

## Scan and copy budgets

At about three seconds, the wordmark, plain description and guarantee should answer whether the site is legitimate. At about 20 seconds, headings, visuals and actions should explain what Valstara is and what a visitor gets. FAQ, trust pages and rules carry the deeper read.

On marketing surfaces, headings have at most **7 words**, supporting lines **20**, card, step and badge text **15**, and FAQ answers **45**. Legal, rules and founder-approved trust content are exempt. All customer-visible strings live in `src/copy/` or `src/content/`.

The waitlist has no storefront search, category nav, currency selector, account, cart, prices, discounts, review score or Trustpilot rating. It uses a text wordmark only until the vector redraw. The §7.3 anti-patterns apply, including centred hero text and centred section headings. State-change motion uses the existing 150–200ms ease-out tokens and stops under `prefers-reduced-motion`.

## Layout evidence

`scripts/design/layout-checks.mjs` checks horizontal overflow, clipped text, 44×44px small-screen targets, focused elements obscured by sticky content, image dimensions and container-grid alignment. The enforced-pages list starts empty in E11.5-01. Each later page ticket adds its redesigned routes; E11.5-12 compares it with the rendered-page inventory.

`scripts/design/contact-sheet.mjs` captures the requested route/state manifest at all eight widths in both themes. For example: `node scripts/design/contact-sheet.mjs --origin http://127.0.0.1:4321 --route / --state landing-before`. The output is under `.design-contact-sheets/`, which is git-ignored. A JSON manifest can list `{ "route": "/path?state=…", "state": "label" }` entries; route URLs and their query tokens are never written to the index. Attach the relevant output to the PR without committing it.

For interactive states, a manifest entry may add ordered `actions`: `click`, `focus`, `fill`, `press`, `waitFor` (each with a selector), or `scroll` (with nonnegative `y`). For example, `{ "route": "/", "state": "signup-error", "actions": [{ "action": "click", "selector": "[data-submit]" }, { "action": "waitFor", "selector": "[role=alert]" }] }`. The script records no action values in its index.
