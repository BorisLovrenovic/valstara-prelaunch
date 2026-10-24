# Page design — E11.5 engineering reference

The [development plan](../plan/development-plan.md#epic-e115--frontend-design) governs each ticket. This page records the shared implementation rules for the redesign; it does not change behaviour or the locked palette and type scale.

## Grid and rhythm

Use the mobile-first container: `--container-max: 75rem`, `--gutter` below 40rem and `--gutter-wide` from 40rem. Content follows one container grid; use `data-design-container` on the container and `data-grid-align="start"` or `"end"` on items whose edge must line up. Sections sit on the page ground with `--section-gap` (64px) below 64rem and `--section-gap-wide` (80px) from 64rem. Long prose has `--measure: 68ch`; it sits within the wider composition rather than creating a narrow centred page.

The closed breakpoints are **40rem, 64rem and 80rem**. Test at 320, 360, 390, 768, 1024, 1280, 1440 and 1920 CSS pixels, in light and dark themes. The CI literal scan rejects other media-query lengths and values embedded in any `src/**/*.astro` style, including inline Astro style expressions.

## Depth, type and icons

`--shadow-1` is for cards at rest; `--shadow-2` is for the raised hero visual, hovered interactive card and sticky bar; `--shadow-3` is for overlays. Use the dark versions on dark surfaces. `--on-midnight` colours all text and icons on `midnight`. `coral` on `midnight` is reserved for large text and accents. No new colour or type-size token is introduced.

Use the existing §6.1 type sizes with weight and tracking tokens. Headings and hero copy are left-aligned. `src/components/icon.astro` is a closed inline-SVG registry with token sizes, `currentColor` and decorative hiding by default. The four-point star is a decorative accent only; never arrange three as a rating row. No icon font or remote asset is loaded.

## Shell and primitives (E11.5-03)

`src/layouts/BaseLayout.astro` is the one shell. Trust and legal pages render it through `src/layouts/trust-page.astro` with `themeToggle={false}`, because they ship no client JavaScript beyond the page-view emitter.

- **Header**, not sticky: the text wordmark on the left. From 40rem, the section links (How it works · What you get · Guarantee · FAQ) and a primary "Join the waitlist" link styled as a button. They point at `#how`, `#rewards`, `#guarantee`, `#faq` and `#join` on the landing page and at `/#…` elsewhere. Below 40rem the header shows the wordmark, Join and the theme toggle only. The section links are `display: none` there, so there is no menu, disclosure or script.
- **Footer**: a full-width `midnight` band with the wordmark, two link columns — Company (About, Legit, Guarantee) and Legal (Terms, Privacy, Storage inventory, Giveaway rules) — the `support@valstara.com` contact, and the §3.4 legal line. Text and links use `--on-midnight`.
- **Theme toggle**: a 44px icon button, a moon offering dark and a sun offering light. The label stays in the accessible name and the status is still announced; storage key, behaviour and the no-flash bootstrap are unchanged.

Primitives live in `src/components/` and are zero-JS:

| Primitive | Use |
|---|---|
| `container.astro` | A three-track grid that centres a content track capped at `--container-max`, with `--gutter` outer tracks (`--gutter-wide` from 40rem). The content element carries `data-design-container`. |
| `section.astro` | Section rhythm (`--section-gap`, `--section-gap-wide` from 64rem) around a Container, an optional `midnight` variant, and a left-aligned `heading` slot. |
| `button.astro` | `primary` (coral), `secondary` and `on-midnight`, with hover, active, focus-visible and disabled states, at least `--tap-min` each way. With `href` it renders a native link. |
| `input.astro`, `select.astro`, `field.astro` | A coral focus ring. Invalid controls get a heavier `--error` border, and the Field shows the error text with an alert icon, so an error never relies on colour. |
| `card.astro` | `--shadow-1` at rest; `interactive` cards rise to `--shadow-2` on hover and focus-within. |
| `pill.astro` | `pill` on `coral-tint`; `variant="badge"` on `coral` in mono. Both use tabular figures. |
| `accordion.astro` | Native `<details>` with a chevron icon that turns when open. |

The icon registry also holds a `clock`, used with `check` to tell held rewards from settled ones on `/me` (E11.5-08).

## Trust, legal and rules pages (E11.5-09)

`/legit`, `/guarantee`, `/about`, `/terms`, `/privacy`, `/privacy/storage`, `/giveaway/rules` and every `/giveaway/rules/<rules_version>` share `src/layouts/document-page.astro`, rendered inside `trust-page.astro` (trust and legal) or `giveaway-rules-page.astro` (rules). **No content file is edited, and the rules article stays byte-identical to its recorded hash.** Everything the layout adds sits outside the content article, and the styling is CSS only.

- **Header band** (founder decisions 2026-10-23). The band markup is an eyebrow from `src/copy/document-pages.ts` ("Trust", "Legal" or "Giveaway rules"), placed immediately before the content article, and the summary line, placed immediately after it. The content's own leading H1 is the page's only H1. The article is `display: contents` inside a single-column grid, so the eyebrow, the H1 and the summary take the first three rows over a `surface` band, and the rest of the content flows below in source order. Nothing in the content is hidden. The summary is the content file's frontmatter `description`, or the revision's `description` on rules pages. Legal pages use their existing `src/copy/legal.ts` description, because their content files have no description.
- **Columns.** Single column below 64rem, where the side card renders as a block after the prose, not sticky. From 64rem, the prose runs up to `--measure` beside a sticky side card, which takes the remaining width and never narrows below `--space-10 × 4`. On trust pages the card summarises the Triple Guarantee: the numerals and titles are the approved `landingCopy.trust.promises`, with a link to `/guarantee` (left out on `/guarantee` itself) and a Join button to `/#join`. On legal and rules pages it is a contents list of the `h2` anchors already in the rendered content (`src/server/content/contents.ts`). No list renders where there are none (`/terms`, `/privacy/storage`). A superseded rules revision keeps its archived notice above the band, outside the hashed article.
- **Join bar.** On the three trust pages only, below 40rem: a fixed link to `/#join`, with no form and no script. The page reserves its height with `padding-block-end` and `scroll-padding-block-end`, including `env(safe-area-inset-bottom)`, so it never covers a focused element.
- **Prose.** Headings, lists, blockquotes, code and links are styled on tokens. Below 40rem, prose and card links are at least `--tap-min` each way; from 40rem prose links are inline text again.
- **Tables.** Each table is its own horizontal scroll container (`display: block; overflow-x: auto`), so it can never widen the page. Cells still wrap long words (`overflow-wrap: anywhere`), so at every test width the tables fit rather than scroll. A scroll region with nothing focusable inside cannot be reached by keyboard (axe `scrollable-region-focusable`), and the content markup cannot be given a `tabindex`.

`test/document-pages-rendered.test.mjs` asserts the unchanged content and rules hashes, one H1, the band order, no hidden content element, zero JavaScript, the contents anchors, the table fit, the join bar, the layout checks and axe.

## Scan and copy budgets

At about three seconds, the wordmark, plain description and guarantee should answer whether the site is legitimate. At about 20 seconds, headings, visuals and actions should explain what Valstara is and what a visitor gets. FAQ, trust pages and rules carry the deeper read.

On marketing surfaces, headings have at most **7 words**, supporting lines **20**, card, step and badge text **15**, and FAQ answers **45**. Legal, rules and founder-approved trust content are exempt. All customer-visible strings live in `src/copy/` or `src/content/`.

The waitlist has no storefront search, category nav, currency selector, account, cart, prices, discounts, review score or Trustpilot rating. It uses a text wordmark only until the vector redraw. The §7.3 anti-patterns apply, including centred hero text and centred section headings. State-change motion uses the existing 150–200ms ease-out tokens and stops under `prefers-reduced-motion`.

## Layout evidence

`scripts/design/layout-checks.mjs` checks horizontal overflow, clipped or visibly overflowing text, 44×44px small-screen targets, focused elements obscured by sticky content, image dimensions and container-grid alignment. The enforced-pages list starts empty in E11.5-01. Each later page ticket adds its redesigned routes; E11.5-12 compares it with the rendered-page inventory.

The shell is enforced separately (E11.5-03, founder decision 2026-10-20). `checkShellLayout` applies the same rules to the `body > header` and `body > footer` regions only, and `assertShellLayout` runs it on every rendered page at all eight widths in both themes, in the accessibility suite. `enforcedPages` is unchanged by this.

The accessibility suite's reading-order check reads the controls inside one list (a footer column, the header links) as a single block at that list's position, top to bottom, so a column layout passes and a list whose visual order differs from its DOM order fails.

`scripts/design/contact-sheet.mjs` captures the requested route/state manifest at all eight widths in both themes. For example: `node scripts/design/contact-sheet.mjs --origin http://127.0.0.1:4321 --route / --state landing-before`. The output is under `.design-contact-sheets/`, which is git-ignored. A JSON manifest can list `{ "route": "/path?state=…", "state": "label" }` entries; route URLs and their query tokens are never written to the index. Attach the relevant output to the PR without committing it.

For interactive states, a manifest entry may add ordered `actions`: `click`, `focus`, `fill`, `press`, `waitFor` (each with a selector), or `scroll` (with nonnegative `y`). For example, `{ "route": "/", "state": "signup-error", "actions": [{ "action": "click", "selector": "[data-submit]" }, { "action": "waitFor", "selector": "[role=alert]" }] }`. The script records no action values in its index.
