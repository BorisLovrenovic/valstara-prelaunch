# E11.7-15 — The partner-programme audit and founder sign-off

Date: 2026-11-25. Scope: every route E11.7 added and every surface it changed, read over the programme the local seed writes (§1), as the repository's own build serves it, and every email template E11.7 added or changed, rendered from the same seeded database through the dispatch path. The browser checks ran in the version-pinned Playwright Chromium container (`mcr.microsoft.com/playwright:v1.62.1-noble`) against disposable migrated PostgreSQL databases on the local Compose stack.

**Status: the audit has run and its gates pass. All three findings are fixed: E1 and E2, and C1 under the founder's decision (D-074, §9). The founder signed off the contact sheet on 2026-11-25 (D-074 Q2), and accepted the regenerated sheet's differences beyond the C1 lines (D-075 Q1), so the sign-off is recorded (§8, §11).**

## 1. The seed and the sample programme

`npm run seed:partners` (`scripts/seed-partner-programme.ts`) is for local use only: it refuses a database host other than this machine, `NODE_ENV=production` and a database it has already seeded (`docs/features/partner-programme.md#local-sample-data-e117-15`). Every row goes through the domain services the site uses, with their checks, audit records and queued, never dispatched, emails. It runs in about 8 seconds and writes about 170 sample people:

| What | Sample |
|---|---|
| Partner types | `standard`, `student_ambassador`, `creator`, each with an active partner |
| Partner statuses | All eight: `unconfirmed`, `applied`, `approved`, `contract_sent`, `active`, `paused`, `terminated`, `rejected` (with its email) |
| Member ladder stages | 0, 2, 3, 7 (and one pending), 10 (with marketing consent), 21 and 39 confirmed referrals: coupon 1 at 5%, 10%, 15% and 30%, coupon 2, coupon 3 |
| Voids | A member taken below wave 1 by three voids (coupon 1 void), a member restored by an un-void, voided partner referrals of the creator and the ambassador |
| Partner referrals | By `/r/{CODE}` link and by typed code, three retroactive (referred before approval), pending ones, and a signup through a paused partner's member code (a plain member referral) |
| Welcome discounts | 10% (count 0–20), 15% (21–38) and 20% (39 and over) for the creator's 41 friends, and the student ambassador's 15% floor below 21 |
| Wave 1 | For each reason: the first signups (the band narrowed to five for the sample), 3 or more referrals, an active partner, a partner-referred friend; and members outside it |
| Other | Survey answers on every confirmed friend, display names, the partner leaderboard snapshot, dashboard links |

**The seed in CI.** `test/partner-seed.test.ts` runs the command against a scratch database and asserts that every type and status is present, every edge kind (member and partner, link, code, retroactive, pending, voided) exists, every welcome discount equals the founder's rule from its signup count and only partner edges carry one, every member's coupons equal the ladder of their confirmed, non-voided count and none is `settled`, wave 1 holds for each reason and not without one, the programme's emails are queued and none is sent, and every printed link opens its own state. A second run is refused and changes nothing; a database on another host and a production environment are refused before any connection. **9 of 9 pass.**

## 2. The states audited

`test/helpers/partner-audit.mjs` lists every state, from the seed's manifest. The privacy crawl, the browser audit and the contact sheet all read it, so they audit the same states. A form POST's state is the page the app answers that POST with, served at its URL. **44 states:**

| Route | States |
|---|---|
| `/partners` (new) | The programme page |
| `/partners/apply` (new) | The form; the auto-invite's email prefill; a refused code with the values kept and the alternatives; the accepted answer; the emailed link's confirmation and an invalid link; the dashboard recovery form and its acknowledgement; `partners.enabled` off |
| `/partners/dashboard` (new) | The active creator (42 confirmed referrals, 2 pending, 2 voided; leaderboard name shown), the active student ambassador (initials only), the active standard partner, the paused creator; the terminated partner's link and an invalid link (the same response); the settings saved; `partners.enabled` off (503) |
| `/partners/dashboard/flyer` (new) | The creator's and the ambassador's flyers; an invalid link |
| `/r/{CODE}` (new) | An active code (302 to `/?ref=CODE`); a paused partner's code and any code with `partners.enabled` off (302 to `/`) |
| `/` (changed) | The landing page with the ladder card and the referral-code disclosure |
| `/verify` (changed) | Verification success for a partner-referred friend (the perk line) and a member-referred friend |
| `/me` (changed) | Each member stage above, a retroactively attributed friend, partner-referred friends at 10%, 15% and 20%, a voided partner referral, the ambassador's friend at the floor |
| `/privacy` (changed) | The policy with the partner rows |

"every new partner programme route and changed surface is covered by an audited state" asserts that each new route and changed surface has a state, and that every page file under `/partners` is one of the programme's routes.

## 3. The privacy gates

**The crawl.** `test/e11-05-page-inventory.test.mjs`, "E11.7-15 crawls every partner programme state of the seeded programme". It is the E11-05 `crawl()` itself, run over a database the seed command filled and the repository's own build. It covers every GET state of §2 (34 paths, four at a time) and the two replayed verification links:

- no cookie is set or read;
- no storage beyond the theme preference and, where a protected form renders, Cloudflare's `cf.turnstile.u` in its own origin;
- no host but Turnstile's, which loads exactly where a protected form renders (the application, recovery and `/me` forms, and the landing page `/r/{CODE}` lands on), and each protected form gets its real Turnstile token.

The dashboard and flyer keep E11.7-09's page hygiene: `no-referrer`, `private, no-store`, `noindex`, no page-view emitter, and only the theme shell's two scripts. `/r/{CODE}` is a response, not a page, so it is checked as one: 302 to `/?ref={CODE}` for a live code and to `/` for a paused partner's code, `no-store`, and no `Set-Cookie`. The terminated partner's link is left to the crawl's own invalid-link path, because it answers exactly as a cancelled link (E11.7-09, D-063 Q2). **Pass**, 1 of 1, in 54 s on 2026-11-25. The privacy allowlist is still exactly `challenges.cloudflare.com`, and no page requested `static.cloudflareinsights.com`.

The crawl's E11.7-11 check expected the asset kit on every authenticated dashboard. The seeded paused partner's dashboard is the first the crawl reads where that does not hold: the kit shows only while the partner's link credits signups (`docs/features/partner-programme.md#the-asset-kit`). `crawl()` takes the expectation as an option, `partnerKit`, defaulting to the old one, so every existing call is unchanged, and the paused state sets it to false. The crawl asserts that a paused dashboard is among the paths.

**The cookie inventory has two entries, and the islands are three.** `test/e11-7-15-partner-audit.test.ts`, "the cookie inventory has two entries, and the islands are three": the published inventory (`src/content/privacy-storage.md`, which `/privacy` and `/privacy/storage` render) lists exactly `valstara-theme` and `cf.turnstile.u`; `src/islands/` holds exactly `Leaderboard.astro`, `SignupForm.astro` and `ThemeToggle.astro`; and no file under `src/pages/partners/` or `src/pages/r/` imports an island or hydrates a component. `test/storage-inventory.test.mjs` still reconciles the inventory with the one source write and the Turnstile contract (3 of 3). In the browser, "islands: no partner programme state defines a fourth island, and the programme's own pages mount only the theme toggle" records every custom element each of the 44 states defines before its scripts run. None defines an element beyond the three islands' (`valstara-signup-form`, `valstara-theme-toggle`, `valstara-leaderboard`). No framework island hydrates. The programme's own pages define only the theme toggle. No page loads a script from another host but Turnstile's, and that only with a protected form. **Pass.** The red path plants a fourth custom element and an off-origin script in the served `/partners`, and both are reported.

## 4. Accessibility

`test/e11-7-15-partner-browser.test.mjs`, "accessibility: every partner programme state has zero WCAG 2.2 AA violations at every design width in both themes". It is the same axe-core run as `test/accessibility.test.mjs` (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`), on the page at rest under reduced motion. It covers all 44 states (§2) at all eight design widths (320, 360, 390, 768, 1024, 1280, 1440 and 1920) in both themes: **704 axe runs, zero violations**, in 130 s on 2026-11-25. "each check fails on a defect planted in a real partner programme page" proves the runner: an image without alternative text, planted in the served `/partners`, is reported as `image-alt`.

A POST state's page is served at its URL, and every other request to the app goes through `route.fetch()`. The first run served only the document, and every POST state failed `target-size` on its header and footer links at every width: Chromium's Private Network Access check had blocked the served page's stylesheet from the private host, as the full contact sheet had found before. That was the harness, not the site. Once every request goes through `route.fetch()`, the stylesheet loads and those states pass.

## 5. The copy rules and the brief's banned words

The forbidden-copy gate scans the source copy layer. This audit scans what a person reads: the copy layer filled with the seeded programme's data. `test/helpers/partner-copy-audit.mjs` holds the checks, and both the page and the email audit use it:

- **Never-use terms.** Every term of `scripts/forbidden-copy.json`, the brief's banned words "passive income", "unlimited", "financial freedom", "team" and "downline" among them, word-bounded and case-insensitive, as the gate matches.
- **No exclamation mark** (copy rules: voice; the brief's partner copy rules).
- **No unfilled placeholder**: `undefined`, `NaN`, `null`, `[object …]`, `{link}`, `{code}` and the like, `TODO`, `Invalid Date`.
- **No urgency or scarcity wording**: "hurry", "last chance", "act now", "limited time", "spots left", "only N left", "ends in", "countdown".
- **Sentence case** in every heading, button, label, legend, summary, table header and the title. Names, months, acronyms, codes, numbered labels ("Coupon 1"), list markers ("I.") and the brand's named programmes keep their capitals.

`test/e11-7-15-partner-browser.test.mjs`, "copy: every partner programme state reads under the copy rules, the brief's banned words included", reads each of the 44 states' text at 1440px. **Pass, no issue**, on 2026-11-25. The email half is §6. "the copy check catches each planted problem, and passes the site's own forms" (`test/e11-7-15-partner-audit.test.ts`) pins each rule with a planted case, and the browser red path plants "unlimited", "team", an exclamation mark, a `{code}` placeholder, "only 3 spots left" and a title-case heading in a real served page, and each is reported.

The first run reported the guarantee section's "The Triple Guarantee" and "I. Delivered within 24 hours.", and `/me`'s "3 more confirmed referrals to Coupon 1 at 5%.". These were the check's own errors: a named programme, a list marker and the founder's numbered label (§9, not findings). The check was corrected, and its unit cases pin all three.

## 6. Email rendering

`test/e11-7-15-partner-audit.test.ts`, "every new and changed email renders from the seeded programme through the dispatch path, under the copy rules", with `test/helpers/partner-emails.ts`. The audited templates are the programme's nine (`partner_application_confirm`, `partner_application_received`, `partner_approved`, `partner_rejected`, `partner_dashboard_link`, `partner_welcome`, `partner_first_signup`, `partner_invite`, `partner_digest`) and the two member emails E11.7 changed: `welcome` (the ladder, the held condition, and E11.7-08's perk line) and `milestone_reached` (the ladder).

- **Rendered as dispatch renders them.** Every queued row of those templates in the seeded database (202 from the seed, all 169 welcomes among them, then the four below: 206 messages) goes through `prepareDispatchMessage`, the dispatch path's own renderer call, with the renderers `createResendDispatcher` registers and the database's own data. The templates the seed leaves to switches it never sets are queued by their own jobs and services in the test: the auto-invite by its job with `email.broadcast` on, a dashboard link by the recovery service, and the milestone email by its producer (its renderer is registered and changed by E11.7-04, though nothing has queued it since E11.7-03). The digest is rendered from the job's payload shape with a founder note supplied, because the shipped note file is empty and a run skips its period until the founder writes one (D-071 Q2).
- **Checks on every message.** An HTML and a text part; the copy rules (§5) on the subject, the text and the HTML's visible text; sentence case in the subject; every link on the site's own origins (the emailed base, and `https://valstara.com` for a member's shareable referral link); no `src` loading anything; and no address but the recipient's own (the auto-invite's prefill link carries it, D-070), so no message names another person.
- **The perk line.** Every partner-referred friend's welcome names the partner's code and the friend's fixed discount, and no other welcome carries a perk line (41 and more partner-referred welcomes).
- **The review sheet's preview set covers every audited template** (finding E1, §9).

Result: **pass**, no problem in any rendered message. The contact sheet's layout checks then found the partner welcome too wide for a narrow screen, which the text checks cannot see (finding E2, fixed; §9). The layout checks of the shared email layout (`test/email-layout.test.ts`: width, the 44px button and links, the preheader, tokens, the footer) now include the digest, and pass, 11 of 11.

## 7. The reward-gating enumeration, re-run

**The enumerations, re-run.** `test/coupon-ladder.test.ts` (the transition enumeration, the founder's table cases, the seeded property test, void-driven decrease and restore, wave 1, the daily repair, retired awards and configuration without migration) and `test/reward-gating.test.ts` (every transition into `settled` needs a cheap confirmation; confirmation holds every coupon; the seeded referral-graph property) pass, 12 of 12, on 2026-11-25. Neither changed: E11.7-03 built the coupon enumeration and nothing after it added a reward path.

**Over the seeded programme** (`test/e11-7-15-partner-audit.test.ts`, "reward gating over the seeded programme"):

- the coupon and pre-launch reward enumerations are still exactly `none→held`, `held→held`, `held→void`, `void→held`, and `cheap:confirmation` is the only way into `settled`;
- every `referral_coupon` row is `held` or `void`, never `settled`; only confirmed edges carry the settled cheap reward; no `milestone_award` is settled;
- the attribution export of the seeded programme (`exportAttribution`) carries every held coupon, each `held` with its expiry, flags voided edges rather than dropping them, puts a welcome discount on no member edge and no voided edge, and exports exactly the contracted partners (`active`, `paused`, `terminated`).

Result: **pass.** No coupon is settled anywhere in the programme, and the export a main platform imports agrees.

## 8. The contact sheet

`node --import tsx scripts/design/partner-contact-sheet.mjs` generates it through E11.5-01's `captureContactSheet`, and the layout checks run on every capture. It covers the 44 states of §2 at all eight design widths in both themes (704 page captures), and one email of each audited template rendered from the same seeded database through the dispatch path (12 messages: the welcome both for a partner-referred and for a member-referred friend; 192 captures). Every capture is at rest under reduced motion. A POST state is the page its form's POST answers with, served at its URL. The `partners.enabled`-off states are captured after the flag is turned off. It is not committed: the images are in `.design-contact-sheets/e11-7-15/` (`pages/`, `programme-paused/` and `emails/`, each with an `index.html`), with `summary.json`.

| Run | Captures | Layout issues |
|---|---|---|
| First, 2026-11-25 | 896 (704 pages, 192 emails), in 288 s | 6: "horizontal overflow" on `email-partner_welcome` at 320, 360 and 390px in both themes (finding E2). No page capture had an issue |
| After E2's fix, 2026-11-25, at f408f5b: the sheet the founder reviewed | 896 (704 pages, 192 emails), in 267 s | **0** |
| **After C1's change (D-074), 2026-11-25: the regenerated sheet** | 896 (704 pages, 192 emails) | **0** |

The sheet the founder reviewed showed finding C1 as it stood: the dashboard's leaderboard read "As of 2026-11-25T10:14:16.668Z". The founder signed it off on condition that the sheet regenerated after C1's change differs from it only in the C1 lines and still reports 0 layout issues and 0 axe violations (D-074 Q2).

**The comparison (2026-11-25).** The two sheets' `summary.json` files match apart from the wall time: the same 44 states, widths, themes and 12 emails, 896 captures, 0 layout issues. Axe: "accessibility: every partner programme state has zero WCAG 2.2 AA violations at every design width in both themes" passes on the changed code (§10). Every PNG was compared pixel for pixel, and every rendered email's HTML and text line by line:

- **The C1 lines.** The five dashboard states with a leaderboard (`partners-dashboard-active-ambassador`, `-active-creator`, `-active-standard`, `-paused-creator`, `-settings-saved`; 80 captures) differ in one band only, the "As of" line, which now reads "As of Nov 25, 2026, 10:49 AM UTC". The digest (16 captures) differs only in its rank line, "Your partner leaderboard rank: 1 (as of Nov 25, 2026, 10:49 AM UTC)". At 390px the formatted line wraps once more, so that capture is 20px taller. The seeded counts are all under 1,000, so grouping changes no capture.
- **Values each run draws afresh, not C1.** Each run seeds new member referral codes, signed tokens and server ports. So the 16 `/me` states and the 2 `verify-success` states (288 captures) differ in their `?ref=` code alone, a single line, and every email's links differ in their token and port.
- **A different partner's welcome, not C1.** The emails are read `ORDER BY template, created_at, id`, and the seed writes every partner's welcome in one transaction, so a random id picks which partner's welcome is captured. The reviewed sheet captured LENAPLAYS's welcome and the regenerated one KAICAMPUS's (16 captures): the same template, a different code and link.
- **A capture the reviewed sheet missed, not C1.** On `r-code-programme-paused` at 1024px, light, about 20 provider logo chips below the fold were blank white in the reviewed sheet. The banner's logos load lazily (`src/components/provider-banner.astro`), and that one capture was taken before they arrived. The regenerated capture shows every logo. The other 15 captures of that state are identical.

The founder accepted these differences beyond the C1 lines as not being changes to what was reviewed (D-075 Q1, 2026-11-25), so the condition of D-074 Q2 is met and the sign-off is recorded (§11). The sheet is not regenerated again.

## 9. Findings

| # | Finding | Status |
|---|---|---|
| **E1** | **The partner digest had no email preview.** E11.7-13 registered `partner_digest` with the dispatcher, but not in `scripts/design/email-previews.ts`. So the shared layout checks in `test/email-layout.test.ts` (600px width, the 44px button and links, the preheader, tokens only, the footer) never rendered it, and the E11.5-12 full contact sheet captured no digest. "E11.5-11 previews cover every template the dispatcher registers" passed regardless, because it reads its notion of "registered" from the preview script itself | **Fixed.** The previews include the digest, rendered by its own renderer from fixture counts and a sample note. `test/email-layout.test.ts` gains its preheader and main action (the dashboard replacement request), and its distinct-preheader count rises from 18 to 19. Every layout check passes on it. The email audit (§6) asserts that every audited template is in the preview set, so a new template that skips the previews fails there |
| **E2** | **The partner welcome email overflowed narrow screens.** Its facts list holds "Link: {origin}/r/{CODE}" in the mono face with no break opportunity, and the layout's table widened the whole card to fit it. The first contact sheet flagged "horizontal overflow" on `email-partner_welcome` at 320, 360 and 390px in both themes, and every page capture was clean. Measured in the pinned browser: the seeded mail is 400px wide; on the public origin with a 9-character code it is 375px, and with a code at the 16-character maximum 434px, so every partner with a long code would receive it. The fixture preview (13-character code) had not been captured narrow enough to show it | **Fixed.** The layout's facts cell (`src/server/email/template-layout.ts`) takes `overflow-wrap: anywhere` and `word-break: break-word`. An unbroken link or code now breaks only where it cannot otherwise fit, and every other fact still wraps between words. No token, colour, size or other template changes. "emails: every new and changed email fits every narrow design width, a 16-character partner code on the public origin included" (`test/e11-7-15-partner-browser.test.mjs`) renders one message of each audited template from the seeded programme, plus a welcome with a 16-character code on `https://valstara.com`, at every design width under 600px in both themes. It failed before the fix (400 and 434px at 320–390px) and passes after. `test/email-layout.test.ts` and `test/transactional-templates.test.ts` still pass (18 of 18). Recorded in `docs/brand/page-design.md#the-email-layout-e115-11` |
| **C1** | **Two partner surfaces print machine formats.** The partner dashboard's leaderboard says "As of 2026-11-25T10:03:18.946Z", and the digest's rank line says "Your partner leaderboard rank: 3 (as of 2026-11-01T09:00:00.000Z)": the raw ISO-8601 snapshot time, with milliseconds. The digest's waitlist totals print without grouping ("People with a confirmed place on the waitlist: 1830") where `/me` writes "1,000". The copy rules ask for plain, precise copy, and the public leaderboard formats the same kind of timestamp for people (`formatSnapshotTimestamp`: "Nov 25, 2026, 10:03 AM UTC"). Neither is a gate failure, and the weekly update email (E8-07, outside this audit) prints its snapshot time the same raw way | **Fixed under D-074 Q1 (founder, 2026-11-25); the regenerated sheet's comparison is settled by D-075 Q1 (§8, §11).** The dashboard's "As of" text and the digest's rank and unranked lines show the snapshot time through the public leaderboard's `formatSnapshotTimestamp` ("Nov 24, 2026, 08:00 AM UTC"): the dashboard calls it through `presentSnapshotTime` (`src/server/partner/dashboard-presentation.ts`), because the audit's islands check keeps every partner page free of `src/islands/` imports, and its `<time datetime>` keeps the ISO-8601 value. Every count the dashboard shows is grouped through `partnerDashboardCopy.count`, and every count the digest prints is grouped in `partnersCopy.email.digest`, as `/me` groups figures (`toLocaleString('en-US')`, "1,830"). The two founder-named rewrites are made (`test/partner-digest.test.ts`, the rank line; `test/partner-pages-rendered.test.mjs`, the "As of" text and the `datetime` assertion), and `test/partner-figures.test.ts` pins the time and grouping on the dashboard and on both digest rank lines. The weekly update email (E8-07) is unchanged, as the decision says |

**Observed outside this audit's gates, not changed.** `ReferralService.status()` (`src/server/referral/service.ts`, about line 403) runs its three reads with `Promise.all` on one connection. Inside the verification transaction that connection is a single PostgreSQL client, so `pg` 8 queues the three queries and prints "Calling client.query() when the client is already executing a query is deprecated". It is correct today. The behaviour goes in `pg` 9, which would turn this into a failure on dependency upgrade. E6-05 introduced the pattern with two reads and E11.7-07 added the third. It is no privacy, accessibility, copy, email or reward-gating finding, so it is recorded here for a later ticket, not fixed.

**Not findings.**
- "The Triple Guarantee" is a named programme, which the brand capitalises as a name (`docs/brand/identity-guidelines.md`: "Programmes take plain English names: the Triple Guarantee, the Trust Ledger"), and "Coupon 1" is the founder's numbered label (E11.7-04: "Coupon 1: 30% · Coupon 2: 10% · …"). The sentence-case check treats both as names, and its unit cases pin that.
- No milestone email is queued since E11.7-03, as `docs/modules/email.md` records; its renderer is still registered, so the audit renders it (§6).
- The paused dashboard and flyer answer 503 with the paused card, as the price pages' paused state does.

## 10. Commands run

All on branch `feat/E11.7-15-seed-data-the-partner-programme-audit-and-founder`, with the local Compose stack up.

| Command | Date | Result |
|---|---|---|
| `npm run seed:partners`, against a scratch database | 2026-11-25 | About 8 s; 174 people, 10 partners, the links printed (§1) |
| `npm test -- test/partner-seed.test.ts` | 2026-11-25 | First run 8 of 9: the terminated partner's link was not its current link, because termination clears it. The seed now issues that link while the partner is active (§1). Then 9 of 9 pass |
| `npm test -- test/e11-7-15-partner-audit.test.ts` | 2026-11-25 | First run 2 of 3: the welcome's shareable referral link is on `https://valstara.com`, the site's public origin, which the link check had not allowed. Then 3 of 3, and 4 of 4 with the copy check's unit cases |
| `npm test -- test/email-layout.test.ts` | 2026-11-25 | 11 of 11 pass with the digest in the previews (E1) |
| `npm test -- test/reward-gating.test.ts test/coupon-ladder.test.ts test/storage-inventory.test.mjs` | 2026-11-25 | 15 of 15 pass (§3, §7) |
| `npm test -- --test-name-pattern="^emails" test/e11-7-15-partner-browser.test.mjs` | 2026-11-25 | Before E2's fix: fails, the welcome 400px wide (seeded) and 434px (16-character code) at 320–390px. After: passes |
| `npm test -- test/e11-7-15-partner-browser.test.mjs` | 2026-11-25 | First full run: every flag-on state passed axe, copy and islands, then the paused dashboard's 503 stopped the run. With the 503 expected, the POST states failed axe (the stylesheet blocked, §4), the copy check reported a named programme, a list marker and a numbered label (§5), and the islands check saw the application form's rate-limited second POST (each POST is now made once per server). After those harness fixes, **5 of 5 pass**, in 185 s |
| `npm test -- --test-name-pattern="E11.7-15" test/e11-05-page-inventory.test.mjs` | 2026-11-25 | First run failed on the asset-kit expectation for the paused dashboard (§3). With `partnerKit`, **1 of 1 passes**, 34 paths, in 54 s |
| `node --import tsx scripts/design/partner-contact-sheet.mjs` | 2026-11-25 | First run: 896 captures, 6 with layout issues (finding E2). After E2's fix: 896 captures, **0 layout issues**, in 267 s (§8) |
| `npm run check` | 2026-11-25 | Passes: price-index validate, lint, format, typecheck, the security and privacy gates (with the new files tracked), the build |
| `npm run test:changed -- test/partner-seed.test.ts test/e11-7-15-partner-audit.test.ts test/e11-7-15-partner-browser.test.mjs test/e11-05-page-inventory.test.mjs test/email-layout.test.ts` | 2026-11-25 | The five named files plus the branch's new helpers `test/helpers/partner-audit.mjs`, `test/helpers/partner-copy-audit.mjs` and `test/helpers/partner-emails.ts`: **38 tests, all pass**, in 540 s |
| C1 (D-074): `npm run check`, then `npm run test:changed --` the five files above plus `test/partner-digest.test.ts`, `test/partner-pages-rendered.test.mjs` and `test/partner-dashboard.test.ts` | 2026-11-25 | Check passes. 72 of 73: "the cookie inventory has two entries, and the islands are three" refused the dashboard's import of `formatSnapshotTimestamp` from `src/islands/leaderboard.ts`. The page now calls it through `presentSnapshotTime` |
| C1: `node --import tsx scripts/design/partner-contact-sheet.mjs` | 2026-11-25 | 896 captures, **0 layout issues**. Compared with the reviewed sheet (§8) |
| C1: `npm run check`, then the same `test:changed` run plus `test/partner-figures.test.ts` | 2026-11-25 | Check passes. **76 of 76 pass**, in 602 s, among them "accessibility: every partner programme state has zero WCAG 2.2 AA violations at every design width in both themes" and the two named rewrites |
| D-075: `npm run check`, then `npm run test:changed -- test/e11-7-15-partner-audit.test.ts test/e11-7-15-partner-browser.test.mjs` (the sign-off recorded; the sheet not regenerated) | 2026-11-25 | Check passes. The two named files plus the branch's changed test files: **63 of 63 pass**, in 525 s |

## 11. Founder sign-off

**Signed off by the founder, 2026-11-25.** The founder reviewed the sheet generated at f408f5b and signed it off on condition that the sheet regenerated after C1's change differs from it only in the C1 lines and still reports 0 layout issues and 0 axe violations (D-074 Q2). The regenerated sheet reports 0 layout issues and 0 axe violations, and its C1 lines are as decided. Beyond them it differs only in (a) the values each run draws afresh: member `?ref=` codes, signed tokens and server ports; (b) which partner's welcome is captured (KAICAMPUS instead of LENAPLAYS: the same template, a different code); and (c) `r-code-programme-paused` at 1024px light, whose lazily loaded provider logos were blank in the reviewed capture and now render (§8). No source outside C1 changed between the two sheets. On 2026-11-25 the founder accepted these differences as not being changes to what was reviewed (D-075 Q1), so the condition is met and the sign-off stands.

| Item | Status |
|---|---|
| Finding E1 | Fixed in this ticket |
| Finding E2 | Fixed in this ticket |
| Finding C1 | Fixed in this ticket (D-074 Q1) |
| Contact-sheet review and sign-off | Signed off by the founder, 2026-11-25 (D-074 Q2; differences beyond C1 accepted under D-075 Q1, §8) |
