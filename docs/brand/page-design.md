# Page design — E11.5 engineering reference

The [development plan](../plan/development-plan.md#epic-e115--frontend-design) governs each ticket. This page records the shared implementation rules for the redesign; it does not change behaviour or the locked palette and type scale.

## Grid and rhythm

Use the mobile-first container: `--container-max: 75rem`, `--gutter` below 48rem and `--gutter-wide` from 48rem. Content follows one container grid; use `data-design-container` on the container and `data-grid-align="start"` or `"end"` on items whose edge must line up. Sections sit on the page ground with `--section-gap` (64px) below 64rem and `--section-gap-wide` (80px) from 64rem. Long prose has `--measure: 68ch`; it sits within the wider composition rather than creating a narrow centred page.

The closed breakpoints are **22.5rem, 48rem, 64rem and 80rem** (E11.5-11a): small is below 48rem, medium is 48rem to below 64rem, large is 64rem and up, and wide is 80rem and up. `22.5rem` is used by the header's Join button and by the landing hero's tight logo strip, both drawn in the 320 frame (E11.5-11c, founder-authorised 2026-10-27). Test at 320, 360, 390, 768, 1024, 1280, 1440 and 1920 CSS pixels, in light and dark themes. The CI literal scan rejects other media-query lengths and values embedded in any `src/**/*.astro` style, including inline Astro style expressions.

## Depth, type and icons

`--shadow-1` is for cards at rest; `--shadow-2` is for the raised hero visual, hovered interactive card and sticky bar; `--shadow-3` is for overlays. Use the dark versions on dark surfaces. `--on-midnight` colours all text and icons on `midnight`. `coral` on `midnight` is reserved for large text and accents. No new colour or type-size token is introduced.

Use the existing §6.1 type sizes with weight and tracking tokens. Headings and hero copy are left-aligned. `src/components/icon.astro` is a closed inline-SVG registry with token sizes, `currentColor` and decorative hiding by default. The four-point star is a decorative accent only; never arrange three as a rating row. No icon font or remote asset is loaded.

## Shell and primitives (E11.5-03)

`src/layouts/BaseLayout.astro` is the one shell. Trust and legal pages render it through `src/layouts/trust-page.astro` with `themeToggle={false}`, because they ship no client JavaScript beyond the page-view emitter.

- **Skip link**: "Skip to content", the first focusable element, targeting `#main` (E11.5-11b). It is hidden above the viewport until focused, then shown at the gutter.
- **Header** (E11.5-11b, from `Main.dc.html`, `Tablet.dc.html` and `Phone.dc.html`), not sticky. Large: 80px tall, items centred with 40px gaps — the wordmark (20/28 600, `--tracking-tight`), the section links (How it works · What you get · Guarantee · FAQ; 14/20 500 `ink-600`, 12px padding, 4px apart), then on the right, 12px apart, the theme toggle and the `h44` primary "Join the waitlist". Medium: the same with 24px gaps and links padded 12px 10px with no gap between them. Small: 72px tall with 8px gaps — the wordmark, the toggle and Join, with no section links and no menu. Below `22.5rem` Join is the `xs` size, so the row fits at 320px. Join has a fixed width at each size, the frames' width within 1px: 160px for `h44` (`--space-10` × 2) and 130px for `xs` (`--space-2-5` × 6.5), so the right-aligned toggle and Join do not move when the font swaps (E2-02). The links point at `#how`, `#rewards`, `#guarantee`, `#faq` and `#join` on the landing page and at `/#…` elsewhere. `/legit`, `/guarantee` and `/about` render no toggle (E11.5-03).
- **Footer** (E11.5-11b): a full-width `midnight` band with `--on-midnight` text, 64px top and 48px bottom padding, the section gap above it, and `--edge` (a 1px line in dark). `main` has no bottom padding, so on every page the section gap is the only space between the content and the footer; the landing page offsets only main's top padding. Large, on the 12-column grid: the wordmark in columns 1–4, Company (About, Legit, Guarantee) in 5–6, Legal (Terms, Privacy, Storage inventory, Giveaway rules) in 7–8 and Contact (`support@valstara.com`, a `mailto:` link) in 9–12. Column headings are 14/20 600 with 8px below; links are 14/20 with 6px vertical padding. Medium: the wordmark on its own row, then three span-4 columns 32px below. Small: the wordmark, then the 4-column grid 32px below — Company and Legal span 2, Contact spans 4 — with 24px row gaps. At medium and small widths links are padded 12px, a 44px target. The Company and Legal columns share one `nav` laid out with `subgrid`. The footer wordmark keeps a 44px target; its box starts 8px above its text so the text sits on the padding. Below the columns, 48px down (40px medium, 32px small), the trademark line and the §3.4 legal line, 14/20, 8px apart, at most 760px wide (`--space-10` × 9.5), at 85% opacity; E11.5-11b adds no token. No payment logos, social links or cookie banner.
- **Theme toggle**: a 44px icon button, a moon offering dark and a sun offering light. The label stays in the accessible name and the status is still announced; storage key, behaviour and the no-flash bootstrap are unchanged.

Primitives live in `src/components/` and are zero-JS:

| Primitive | Use |
|---|---|
| `container.astro` | A three-track grid that centres a content track capped at `--container-max`, with `--gutter` outer tracks (`--gutter-wide` from 48rem). The content element carries `data-design-container`. |
| `section.astro` | Section rhythm (`--section-gap`, `--section-gap-wide` from 64rem) around a Container, an optional `midnight` variant, and a left-aligned `heading` slot. |
| `button.astro` | `primary` (coral, `--on-coral` label), `secondary` and `on-midnight`, with hover, active, focus-visible and disabled states (E11.5-11a values below). Sizes: 48px by default, `size="h44"` and `size="xs"` at 44px, and `full` for full width. Below 48rem the secondary button is 44px with 14/20 text. A button keeps its width and one-line height; its label wraps only when the button alone is wider than its container, so a long task-page label never widens the page at 320px. With `href` it renders a native link. |
| `text-link.astro` | Ink text at 500 weight with a 2px coral underline offset 3px; `variant="on-midnight"` uses `--on-midnight` text and a `coral-lift` underline. Below 48rem, 12px vertical padding gives a 44px hit area. |
| `input.astro`, `select.astro`, `field.astro` | The Input is 48px with a 1px `--field` border and an `ink-600` placeholder. Focus is a coral border and the `--ring-focus` ring, with a transparent 2px outline for forced-colours mode. The Field shows a 14/20 600 label, the hint 4px below it and the field 8px below that. An invalid Input has a 2px `--error` border, and the Field puts a 20px alert-circle icon and the `--error-text` message 8px below it, so an error never relies on colour. The Select keeps its E11.5-03 styling. |
| `checkbox.astro` | A 20 × 20 box with a 1.5px `--field` border and `--radius-check`; ticked is an `ink` fill with a `paper` check. A transparent `--tap-min` input is centred on the box, so the target is 44px. `optional` adds the "Optional" pill from `src/copy/primitives.ts`. It refuses a server-set tick: a consent box is never pre-ticked. |
| `card.astro`, `icon-tile.astro` | `--shadow-1` plus `--edge` at rest; `interactive` cards rise to `--shadow-2` plus `--edge` on hover and focus-within. The icon tile is 40 × 40 on `paper` with a 20px icon. |
| `pill.astro` | `pill`: the reward pill on `coral-tint`, ink 13/18 600 text and an optional 16px icon. `coral`: the coral pill with the `--on-coral` label, its figures wrapped in `.tabular-figure`. `badge`: the coral marker set wholly in mono, as on the access-wave badge. `step`: the 24px ink step badge in mono. |
| `accordion.astro` | The FAQ item: a native `<details>`, unboxed, with a 1px `line` divider between consecutive items. The summary is at least 64px with 20px vertical padding and 16/24 600 text, and the 20px `ink-600` chevron turns 180° when open, with no motion under reduced motion. The answer is 16/24 `ink-600`, at most `--measure` wide. |

The icon registry also holds a `clock`, used with `check` to tell held rewards from settled ones on `/me` (E11.5-08).

## The wireframes (E11.5-11a to E11.5-11h)

The founder's mid-fidelity wireframes are the canvas "Valstara waitlist wireframes" at `https://claude.ai/artifact/UpBYawiwLUpinVSYfBQneJ`, pinned to version `1792974724-d356` (founder-authorised 2026-10-26). They bind the landing page, its signup form and the mobile sticky bar. Where a wireframe and an earlier E11.5 ticket's layout differ, the wireframe wins; behaviour is unchanged. The development plan's wireframe rules govern each ticket. In short:

- The blue annotation layer is never built.
- The wireframe's CSS values are the specification. Every value goes through `tokens.css`.
- Copy is verbatim. Values marked `{dyn}` come from their source computation.
- Placeholders (the dashed logo square, the hard-coded provider list, the grey security-check box, placeholder links) are replaced with the real logos, `src/content/provider-showcase.json`, the Turnstile widget and the permanent routes.
- Fonts stay self-hosted.
- Breakpoints map as follows: the 390 frame is small (below 48rem), the 768 frame is medium (48rem to below 64rem), and the 1440 frame is large (64rem and up). Each layout is fluid between its breakpoints, and the container caps at 1200px (1264px with its 32px gutters).
- Geometry is asserted at 1440, 768 and 390 px, and at 320 where drawn, with a 1px tolerance, in both themes.

**Layout values.** Sections are 80px apart at large widths and 64px at medium and small. Gutters are 32px at medium and large and 16px at small. Medium and large use a 12-column grid with 24px gaps (`--grid-columns-wide`, `--grid-gap-wide`); small uses a 4-column grid with 16px gaps. The header is 80px tall at medium and large and 72px at small.

**Primary is reserved for "Join the waitlist" on the landing page** (founder-authorised 2026-10-26): the header, the hero, the final call to action and the sticky bar. Other pages keep their single primary action from E11.5-07 and E11.5-10, such as `/verify`'s confirm button, the task pages' actions and the 404 and 500 home links, and take the new primary styling.

**Recorded deviation from the component sheet:** the input placeholder is `ink-600`, not the drawn `ink-300`, because `ink-300` is 2.60:1 on surface in light and fails WCAG 1.4.3. Dark `ink-600` is the drawn `#A0A0A8`. No contrast exception is recorded.

**Icons.** `src/components/icon.astro` holds every icon the wireframes draw, transcribed as 24-unit stroke icons (stroke 1.75, round caps and joins): check, link, shield, shield-check, mail, check-circle, upload-share, building, office, people, person, gift, clock, arrow-right, arrow-up, chevron-down, search-check, moon, sun, info, alert-circle, refresh and pause. They render at `size="sm"` (16px), `"base"` (20px) or `"md"` (24px); `"lg"` (40px) remains. The four-point star is the wireframe's 16 × 24 path at `sm` (12 × 18) or `md` (16 × 24), coloured by its parent: coral at 12 × 18 and `coral-lift` at 16 × 24. The E11.5-03 triangle `alert` stays for the task pages.

## Trust, legal and rules pages (E11.5-09)

`/legit`, `/guarantee`, `/about`, `/terms`, `/privacy`, `/privacy/storage`, `/giveaway/rules` and every `/giveaway/rules/<rules_version>` share `src/layouts/document-page.astro`, rendered inside `trust-page.astro` (trust and legal) or `giveaway-rules-page.astro` (rules). **No content file is edited, and the rules article stays byte-identical to its recorded hash.** Everything the layout adds sits outside the content article, and the styling is CSS only.

- **Header band** (founder decisions 2026-10-23). The band markup is an eyebrow from `src/copy/document-pages.ts` ("Trust", "Legal" or "Giveaway rules"), placed immediately before the content article, and the summary line, placed immediately after it. The content's own leading H1 is the page's only H1. The article is `display: contents` inside a single-column grid, so the eyebrow, the H1 and the summary take the first three rows over a `surface` band, and the rest of the content flows below in source order. Some older Safari and Chromium releases drop the landmark role of a `display: contents` element; the founder accepted this on 2026-10-24, because the H1 cannot move and the article markup cannot change. Nothing in the content is hidden. The summary is the content file's frontmatter `description`, or the revision's `description` on rules pages. Legal pages use their existing `src/copy/legal.ts` description, because their content files have no description.
- **Columns.** Single column below 64rem, where the side card renders as a block after the prose, not sticky. From 64rem, the prose runs up to `--measure` beside a sticky side card, which takes the remaining width and never narrows below `--space-10 × 4`. On trust pages the card summarises the Triple Guarantee: the numerals and titles are the approved `landingCopy.trust.promises`, with a link to `/guarantee` (left out on `/guarantee` itself) and a Join button to `/#join`. On legal and rules pages it is a contents list of the `h2` anchors already in the rendered content (`src/server/content/contents.ts`). No list renders where there are none (`/terms`, `/privacy/storage`). A superseded rules revision keeps its archived notice above the band, outside the hashed article.
- **Join bar.** On the three trust pages only, below 48rem: a fixed link to `/#join`, with no form and no script. The page reserves its height with `padding-block-end` and `scroll-padding-block-end`, including `env(safe-area-inset-bottom)`, so it never covers a focused element.
- **Prose.** Headings, lists, blockquotes, code and links are styled on tokens. Below 48rem, prose and card links are at least `--tap-min` each way; from 48rem prose links are inline text again.
- **Tables.** Each table is its own horizontal scroll container (`display: block; overflow-x: auto`), so it can never widen the page. Cells still wrap long words (`overflow-wrap: anywhere`), so at every test width the tables fit rather than scroll. A scroll region with nothing focusable inside cannot be reached by keyboard (axe `scrollable-region-focusable`), and the content markup cannot be given a `tabindex`.

`test/document-pages-rendered.test.mjs` asserts the unchanged content and rules hashes, one H1, the band order, no hidden content element, zero JavaScript, the contents anchors, the table fit, the join bar, the layout checks and axe.

## Task pages and error pages (E11.5-10)

`/unsubscribe`, `/dsr` (request and confirmation) and `/giveaway/award` (every state) share `src/layouts/task-card.astro`. It is zero-JS: a Container holding a left-aligned Card capped at `--measure`, a state icon beside the page's only H1, then one line, any form and the actions. The card carries `data-task-state`, and its slot content gets these classes:

- `task-card__actions`: one primary Button first, then at most one secondary Button. On `/unsubscribe` the primary action unsubscribes from the message and leaving the waitlist is the secondary. On the substitution form the primary action chooses replacement goods and the cash decline is the secondary. Both are one click.
- `task-card__notice`: an outcome line with its icon, and an `--error` rule for errors, so it never relies on colour alone.
- `task-card__choice`: a checkbox whose native input is a transparent `--tap-min` target over a drawn box (`task-card__box`, `task-card__mark`), with a check icon when ticked.
- `task-card__link`: a plain secondary link at `--tap-min` height.

Icons: `shield` for a form to complete, `check` for done, `alert` for invalid, unavailable or ineligible, and `clock` for rate limits and deadlines. Turnstile renders compact on these pages so it fits at 320px. Form fields, actions, token use, Turnstile and responses are unchanged. On `/giveaway/award` the outcome-to-message mapping is the unchanged E7-06 copy, and `server/giveaway/award-presentation.ts` adds the icon.

`src/pages/404.astro` and `src/pages/500.astro` use the same card: a plain heading, one line, a primary link home and a secondary link to `/legit`. Both are prerendered and `noindex`, are absent from the sitemap, and send no page view. The Node adapter serves the built file for an unknown route (404) or a failed render (500), so neither page depends on the database, configuration or middleware, or renders anything from the failure. The 500 page has no URL of its own. `openRoute` in `scripts/design/layout-checks.mjs` serves the built file at `/500` for the layout checks and the accessibility suite.

`test/task-pages-redesign.test.mjs` renders every state, asserts the statuses and the 500 no-leak property, and runs the layout checks at every width and theme and axe in both themes.

## The email layout (E11.5-11)

Every template shares `src/server/email/template-layout.ts`: the seven transactional mails, the two data-rights mails and the weekly update. The layout is a 600px table that shrinks to the reading pane, with inline styles. From top to bottom it has the text wordmark, a `surface` card holding the paragraphs, the facts list in the mono face with tabular figures, one coral button for the message's main action (the document's first link), and the other links as underlined text. Below the card is a footer with the §3.4 legal line, `support@valstara.com` and the unsubscribe link. A hidden preheader from the copy layer opens the body. The plain text keeps the same order but has no wordmark and no preheader, so its first line is still the message's own first line.

Mail clients ignore custom properties, so colours, font stacks, sizes, radii and the tap target are read from `tokens.css` at render time and inlined as literal values. The output contains no `var(`. The light `:root` block is inlined. A `prefers-color-scheme: dark` block carries the dark block's values for clients that honour it. The metric-matched fallback faces are site-only aliases, so the email stack names their `local()` fonts instead. An Outlook-only conditional block drops the web fonts, because Outlook on Windows would otherwise fall back to a serif. The button is a coloured table cell `--tap-min` tall. Its anchor fills the cell with padding around one line of body text. The card border is `thin solid` in the `line` colour, the same keyword the site's cards use, so it adds no width literal. No image, remote resource, tracking pixel or link wrapper appears in any template.

A few fixed values in the layout are mail-client mechanics, not design values, and have no token. The 600px content width is set by E11.5-11. Rem tokens convert to px against the CSS initial root font size of 16px, because several clients do not resolve rem. The preheader is hidden with `display:none`, `max-height:0`, `mso-hide:all`, a 1px font size and line height and `opacity:0`. It is followed by 40 `&zwnj;&nbsp;` pairs so the inbox preview does not run on into the body text. None of these values is visible in a rendered message.

The bare `<p>`, `<li>` and secondary `<a>` elements carry no attributes. The unchanged E8-03 suite matches them exactly, so they inherit type and colour from their inline-styled cells. Paragraph margins and the secondary-link colour come from the head `<style>`, and clients that drop it show their default margins and link colour.

`npx tsx scripts/design/email-previews.ts` renders every registered template from fixture payloads into `.design-contact-sheets/email-html/`, together with a contact-sheet manifest. Serve that directory and run `contact-sheet.mjs --manifest .design-contact-sheets/email-html/manifest.json` against it to capture light and dark previews. The live check in real mail clients is E12-07's.

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

## Provider showcase (E11.5-04)

The provider list is `src/content/provider-showcase.json`, transcribed from P8 and checked at build time. `ProviderBanner` layers a tone and raised logo surface over the recorded provider colour; `ProviderRail` groups the confirmed entries in survey v2 order. At small widths each group scrolls and snaps without script; from 64rem it is a five-column grid. The landing composition belongs to E11.5-05. The footer carries the independent-seller trademark notice on every page. See ADR-032.

## Landing page (E11.5-05)

The landing page runs from the hero at `#join` through the provider catalogue, three-step explanation, reward cards, full-width midnight guarantee band, trust links, FAQ and final `#join` action. The hero places the form under the positioning line and H1; its provider banners become a compact same-origin logo strip below 48rem. The final action is a normal anchor, with the existing signup island moving focus to the hero email input when JavaScript is available.

The early-access visual labels the four configured waves without exposing band thresholds. Enabled referral tiers render their threshold and discount from `milestoneTiers`; the giveaway card reads its count and per-prize approximate value from the validated `currentRules()` revision. The card and the form's no-purchase disclosure share `giveaway.open`. The referral card and leaderboard link follow their own flags. The paused signup panel replaces the form when `signup.enabled` is off.

The landing route is in `enforcedPages`. Its page-specific browser checks cover the 390×844 and 1440×900 first view, every design width and both themes, and axe in both themes. The guarantee band's short lines are exact excerpts of the approved guarantee prose; no trust or rules content article is changed.

### The hero (E11.5-11c)

The `#join` hero follows `Main.dc.html`, `Tablet.dc.html`, `Phone.dc.html` and `Fold.dc.html`. Every value is a token or a `calc()` of tokens.

- **Text column.** From 48rem it spans columns 1–7 of the 12-column grid and the banner stack spans 8–12, with the rows centred. Top padding is 24px small, 40px medium and 48px large. The coral star (12 × 18) sits 8px before the positioning line, which is 14/20 500 `ink-600` (16/24 at large). The H1 is 12px below it. The supporting line follows 12px below at small widths and 16px below from 48rem; it is 16/24 `ink-600` and at most 600px wide. The form starts 24px below (32px from 48rem) and is at most 560px wide. The section gap above the catalogue is the only space below the hero.
- **The form** (`SignupForm`, layout only). The label, then the hint 4px below, then the field 8px below. Small: a full-width button 12px under the field. From 48rem: the field and the button share one row, 8px apart, with the button padded 20px at medium and 24px at large. Below it: the microline 12px down (14/20 `ink-600`: "Open to people aged 18 and over." and, with `giveaway.open`, "No purchase necessary. See the giveaway rules.", where the last sentence links to `/giveaway/rules`); the Turnstile widget 12px under the microline, but only while it holds the widget; the trust facts 20px down (16px small) in a wrapping row with 8px × 24px gaps (8 × 20 below 64rem), with 20px `ink-600` icons; and the optional marketing `Checkbox` 24px down (20px small). The form is a named-area grid, and the Field's wrapper is `display: contents`, so the DOM order (field, button, microline, Turnstile, facts, checkbox) is the visual and tab order. With `signup.enabled` off, the paused panel replaces the whole form, trust facts included, and the header Join and the final call to action scroll to it.
- **Banners.** `src/content/landing-hero.json` names the three providers: `stack`, back to front, and `strip`, left to right. The prebuild check (`scripts/ci/provider-showcase-check.ts`) fails the build if a name is not in the showcase. `src/components/hero-banner.astro` draws each one on its data brand colour, with one tonal shape (the wireframe's `.t3`, `.t1` and `.t2`, by stack position, clipped by its own box) and a chip on `--banner-white` with the name in `--banner-ink`. Text on the banner is `--banner-white` or `--banner-ink`, whichever contrasts more with the brand colour. The tone is white at 13% below a relative luminance of 0.03, else white at 16% under white text, else ink at 10%. Both are computed in `src/content/landing-hero.ts`. The stack and the strip are `aria-hidden`.
- **The stack** (48rem up): 290px tall at medium, with 136px banners (16px padding, a 40px chip padded 14px) at 84.5% of the column, offset 76px down and 8% and 15.5% of the column in. At large it is 400px tall, with 184px banners (24px padding, a 48px chip padded 16px) at 70% of the column, offset 104px down and 15% and 30% in. Width plus the last offset is exactly the column, so the stack never crosses into column 7. Chips show the 16px logo at its declared aspect ratio, read from the SVG at build time, so no image shifts.
- **The strip** (below 48rem): three 56px banners, 24px below the form and 8px apart, flexing 1 : 1 : 1.35 with names only in 32px chips (13/18, padded 8px). Below 22.5rem the banners are padded 4px and the chips 6px, as the 320 frame draws them.

`test/landing-hero-rendered.test.mjs` asserts the fold at 1440 × 900, 390 × 844 and 320 with the giveaway off and on (the drawn microline), the geometry at 1440, 768 and 390 in both themes, stack containment from 768 to 1920, the real logos and the `aria-hidden` visuals, the microline variants, the paused variant and axe. `test/landing-hero.test.ts` covers the list validation, the build failure and the colour rule.
