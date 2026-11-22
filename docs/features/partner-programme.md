# Feature: Pre-launch partner programme

Founder-authorised 2026-11-17. The founder's wider growth decisions are in `docs/prerequisites/valstara-prelaunch-growth-decisions.md`; where they disagree with the answers recorded here, the answers here are later and win. Built by Epic E11.7 (`docs/plan/development-plan.md`). **This spec is the in-repository record of the founder's brief and answers.** The brief has no other source. The brief (with superseded parts condensed), the founder's two sets of answers and the founder's amendments of 22 November 2026 are recorded verbatim at the end. **Where an answer and the brief conflict, the answer wins, and the 22 November amendments win over both.**

## Summary

A **lightweight, temporary** partner layer on top of the existing waitlist and referral system. It recruits marketers, creators, student ambassadors and community owners to promote the pre-launch campaign through their own link or code. It runs from now until early access (1 September 2027). Then the main platform's full affiliate system takes over, and this layer is retired.

**Only two of its outputs last:**

1. **clean attribution data**, exported to the main platform;
2. **partner links and codes that keep working** after the switch.

**What it never does:**

- commission, earnings, balances, ledgers;
- payouts, tax forms, invoices;
- order tracking;
- multi-level structures;
- deep links, sub-IDs, UTM builders, click analytics beyond counts;
- creative builders, a public API, webhooks;
- multi-currency, i18n, in-app contract signing;
- fingerprinting, VPN or proxy blocking, any CAPTCHA beyond Turnstile.

Commission is **shown in copy and never calculated here** (founder, 2026-11-22):
- 10% of order value, on all products, one level;
- only for customers a partner referred during the pre-launch campaign;
- on every order they place from early access (1 September 2027) until one year after public launch (1 October 2028);
- the founding rate lock lasts that one year, with no lifetime lock;
- customers referred after public launch fall under the post-launch rates, agreed separately.

**Positioning (founder, 2026-11-22):** "more than triple GameSeal's commission rate", then "double the rate of G2A and Eneba", each against the programme's standard rate, and only for the pre-launch terms.

**The epic also replaces the campaign's reward rules for every member** (founder, 2026-11-17). The current "3 confirmed referrals: move up a wave and 15% off" milestone is replaced by a wave-1 rule and a coupon ladder. See "Early access and rewards".

## How it fits this repository (founder answers, 2026-11-17)

| The brief asked for | What is built instead, and why |
|---|---|
| Admin pages with magic-link login, sessions and CSRF | **Founder commands over the existing admin API** (secret key + authenticator code, E5-03a), like the flags command. There are no admin pages, logins or sessions, and every action is audited |
| A partner dashboard behind a magic link and a session cookie | **A private link emailed to the partner, as `/me` works.** No cookie, no session. "Send me a new link" **cancels the previous link**, so a forwarded link can be shut off. A link lasts 30 days, the same as `/me`'s |
| Country of residence from the existing selector | **A plain dropdown on the partner application only**, disclosed in the privacy policy, with ADR-026 amended. **No country breakdown on the dashboard**: members have no country |
| A live-validated code field, copy buttons | **No new interactive component** (ADR-001's three islands stay three). Codes are checked on submit, and a taken code returns the form with the error and alternatives. Links and codes appear as large, selectable text. QR codes are generated on the server |
| A typed "Referral code" field | **A collapsed "Have a referral code?" toggle in the hero form only**, with no JavaScript, handled server-side. ADR-008 is amended |
| Assets uploaded by the founder to a folder | **Images and PDFs are committed to the repository** and ship with each deploy. Videos are plain links |
| Auto-invite at 10 confirmed referrals | **Sent only to members who opted in to marketing** (ADR-027). `/partners` stays public |
| Brevo partner list sync | **Cut.** A partners CSV the founder imports into Brevo each quarter |
| Milestone emails 1 / 10 / 25 / 50 / 100 | **Cut to "first confirmed signup" only** |
| Partner leaderboard | **Kept** |

## Feature flag

| Flag | Default | Off means |
|---|---|---|
| `partners.enabled` | **on** | `/partners/apply` shows an honest "applications are paused" message. `/r/{CODE}` still redirects to `/`, without attributing. Partner dashboards say the programme is paused. Existing data is untouched. The incident lever |
| `partners.digest` | **off** | No partner digest is sent. It stays off until the founder turns it on |

The reward ladder and the wave-1 rule sit behind the existing `referral.enabled`.

## Partner lifecycle

`applied` → `approved` → `contract_sent` → **`active`** → `paused` | `terminated`, plus `rejected`. `reactivate` returns a `paused` partner to `active`.

- **An application counts only once its email is confirmed.** Submitting sends a confirmation link to the address. For someone not yet on the waitlist, confirming it is also their double opt-in, and creates or links their member record. An unconfirmed application expires with the verification token, and is never shown for review.
- **Contracts live outside this system.** The founder sends each one through signfree.io. This system stores only `contract_sent_at`, `contract_signed_at`, `contract_version`, an optional signfree reference and notes, set by founder command.
- **Recording a signed contract activates the partner.** At that moment:
  - the code and `/r/{CODE}` go live;
  - the welcome email is sent;
  - retroactive attribution runs.
- **A paused or terminated partner's** link and code stop attributing. Visitors land on `/` normally, with no referrer recorded. Existing attributions stay unless voided one by one.
- **States that wait on a person** (standing rule 14):
  - an unconfirmed application expires with its token;
  - `applied`, `approved` and `contract_sent` wait on the founder or on the signature. `partners list --stale` shows any that have been in one state for more than 14 days (configurable). Nothing changes automatically;
  - a dashboard link expires after 30 days, with one-click re-send.

## Links and codes

- **`https://valstara.com/r/{CODE}` is permanent.** It will be printed on flyers and QR codes, and the main platform must serve it with identical behaviour (the hand-over requirement). An active code redirects (302) to `/?ref={CODE}`, where the existing server-side signed capture (E4-02) takes over. An inactive, unknown or flag-off code redirects to `/` with no referrer.
- **The partner code** is chosen at application:
  - 4–16 characters, A–Z and 0–9, case-insensitive, stored in upper case;
  - **unique across every member and partner code**, enforced by the database through one shared code registry;
  - refused if it is on the blocklist (`config/partner-code-blocklist.json`: brand and provider names, reserved words, profanity).

  The founder can change it at approval.

  **As built (E11.7-01):**
  - The registry is the `referral_code` table (`docs/data/model.md#referral_code`). Every existing member code was backfilled into it, and member code generation writes to it in the same transaction.
  - Format, blocklist and availability are checked in that order. Each refuses with its own reason (`format`, `blocked`, `taken`), and a refusal offers up to three alternatives that passed every rule.
  - A blocklist term matches regardless of case. A brand or profanity term usually refuses any code that contains it, so `NETFLIXDEALS` is refused. Terms that occur inside ordinary names, such as `NOTION` (in `PROMOTION`), `FREE` (in `FREEDOM`) or `ADMIN` (in `BADMINTON`), refuse only the whole code. The full rules are in `docs/modules/referral.md`.
  - A code that passes only because its term is exact-match, for example `ADMIN1` or `NOTIONPRO`, is caught by the founder at approval (E11.7-06), per D-043.
- **The partner's existing member referral code keeps working** and resolves to the same identity once they are active.
- **One referrer per signup, fixed when the signup is created** (the existing write-once `referred_by_id`). Only a founder correction changes it. **A typed code beats the link's code.**
- **QR codes** of the partner's link, as PNG and SVG, generated on the server.

## Early access and rewards (founder, 2026-11-17)

These replace the brief's perks and the repository's current reward rules (ADR-025's tier 1, the wave upgrade, the 15% milestone discount).

### Waves

- **Wave 1 is early access, 1 September 2027** (founder, 2026-11-22; previously early July 2027). **The first 1,000 verified members are in wave 1 by signup order, whatever their referrals** (founder, 2026-11-17, D1). That place is never lost. After the first 1,000, the following go straight into wave 1:
  - any member with **3 or more confirmed, non-voided referrals**;
  - **every active partner**;
  - **everyone who signed up through an active partner's link or code**, including retroactive attribution.
- Everyone else keeps the existing signup-order logic for waves 2–4, unchanged, and does not get early access in September 2027.
- **Every member's `/me` page, and every partner's dashboard, says plainly whether they get early access in September 2027.** If not, it says how many more confirmed referrals earn it. The only scarcity wording allowed is the founder-approved line, used while it stays true: "Some high-demand products have limited supply. Early access members get first pick." There are no counts and no countdowns, and nothing implies the public launch will be empty.
- **Wave 1 is recalculated in the same way as the coupons, up to handoff.** A member who drops below 3 confirmed referrals leaves wave 1. A friend whose own referral is voided loses a wave-1 place they got through a partner.

### The referrer coupon ladder (members and partners)

The count is confirmed, non-voided referrals, including retroactive partner attribution.

| Coupon | Unlocks at | Steps (5% each, every 3 referrals) |
|---|---|---|
| 1 | 3 | 3 = 5% · 6 = 10% · 9 = 15% · 12 = 20% · 15 = 25% · 18 = 30% |
| 2 | 21 | 21 = 5% … 36 = 30% |
| 3 | 39 | 39 = 5% … 54 = 30% |

- **The ladder ends after coupon 3 reaches 30%.** Further referrals still count for attribution, the leaderboard and partner commission.
- **Each coupon is single-use.** Only one discount applies per order, with no stacking with each other or with any other discount. A coupon is usable on any order.
- **Coupons expire five years after public launch.** The launch date is configured (default 2027-10-01, so 2032-10-01; founder, 2026-11-22, previously 2027-09-01). The founder sets the real date at handoff, and the export carries the computed expiry.
- **Voids recalculate the ladder from the current count, up to handoff.**
- **The reward-gating invariant stands (ADR-012, `AGENTS.md` rule 3; founder, 2026-11-17).**
  - Every coupon is recorded here as **`held`**.
  - The main platform makes all of a member's coupons usable once **any one of that member's confirmed referred friends places a first order**.
  - The five-year expiry replaces ADR-012's 90-day qualification deadline.
  - Every surface says so plainly, e.g. "Coupon 1: 30%, usable once one of your friends places their first order."
  - **Nothing in this repository moves a coupon to `settled`.**
- **Coupons are entitlements only.** No checkout code is generated, because the main platform does that.
- **The configuration is data.** Thresholds, step, maximum and coupon count live in configuration, so the ladder changes without a migration.

**As built (E11.7-03):**
- The ladder is `couponLadder` in `src/server/referral/config.ts`, and each coupon is a `referral_coupon` row (`docs/data/model.md#referral_coupon`) in state `held` or `void`; the database refuses `settled`. One recompute rewrites a referrer's coupons and wave from the confirmed, non-voided count inside every confirmation, void and un-void, and in the daily repair. A coupon below its unlock is `void`, never deleted, and returns to `held` when the count recovers.
- Wave 1 is `access_window = 'wave-1'`. The first-1,000 place is the separately recorded `verification_order_window`, written once at verification, so a void never removes it; the referral reason is recalculated with the coupons. Partner reasons are added by E11.7-07.
- Every existing milestone award was voided with `ladder_replaced` and audited, none deleted. No milestone email is sent any more, because the tier it announced no longer exists.
- The handoff export carries every export-set owner's held coupons as `held_coupon` records with their percent and `expires_at`, computed from the configured public-launch date.

### The friend's welcome discount (partner referrals only)

**Only friends referred by an active partner get it.** A member referral that is not through the partner programme carries no welcome discount (founder, 2026-11-17). Its rules:

- First order only, and single-use.
- **It is set by the partner's ladder stage at the moment the friend signs up, and fixed from then on:**

  | The partner's confirmed referrals at the friend's signup | Welcome discount |
  |---|---|
  | Fewer than 21 (coupon 2 not unlocked) | **10%** |
  | 21–38 (coupon 2 unlocked) | **15%** |
  | 39 or more (coupon 3 unlocked) | **20%** |

- **Friends of a student ambassador get the higher of 15% and the ladder value.**
- **A retroactively attributed friend's discount** is set from the partner's confirmed count at that friend's original signup, with the ambassador floor applied.
- Friends referred earlier keep what they got. **A friend whose own referral is voided loses it.**
- It expires five years after public launch.
- No stacking: someone who holds several discounts chooses one per order.
- It is the friend's own first-order discount, so it can only ever be redeemed by an order, and it creates no reward for the partner.

### The $5 store credit (normal members only; main platform)

**A member who is not a partner earns $5 store credit for each referred friend who completes a purchase after launch** (founder, 2026-11-17). No credit is earned for a signup alone. Partners never get it: they earn 10% cash commission on the orders of the customers they referred during the pre-launch campaign, from early access until one year after public launch (founder, 2026-11-22). **Both are paid only by the main platform.** This repository records neither. It exports each referral edge marked as a member or partner edge, and the hand-over document (E11.7-14) states the rule.

### Where progress shows

Progress shows on `/me`, on the partner dashboard and in the relevant emails. **As built (E11.7-04)** for members: `/me`, `/verify`, the landing card, the welcome and milestone emails and the privacy policy state the ladder from configuration, and `/me` says whether the member gets early access and why, or what earns it (`docs/features/member-status.md`). The partner dashboard's line is E11.7-09's. For example: "Coupon 1: 30% · Coupon 2: 10% · 2 more confirmed referrals to 15%. Friends you refer now get 15% off their first order." The friend's line appears only for partners. **All ladder state and every welcome discount go into the attribution export and the hand-over document.**

## Pages and surfaces

| Route | What |
|---|---|
| `/partners` | The public programme page, with copy from a content file |
| `/partners/apply` | The application form: Turnstile, rate limit, the fields in the brief's §3.2, the country dropdown, the code check on submit |
| `/partners/dashboard?t=` | The partner's private page. It shows: link and code; QR downloads; counts (confirmed, pending, voided, signups per week); a breakdown by survey category; the ladder and welcome discount; the terms summary; the leaderboard; the asset kit; settings. `noindex`, `no-store`, no page-view emitter, excluded from the sitemap and `robots.txt` |
| `/partners/dashboard/flyer?t=` | A print-ready flyer for A4 and US Letter |
| `/r/{CODE}` | The permanent short link |

**Privacy.** Partners never see who they referred; they see aggregate counts only. The partner leaderboard is visible to partners only. It shows the top 20 and the viewer's own rank. Every other partner appears by initials unless they opted in to their display name, which is off by default.

## Edge cases and error states

- A code that is taken, blocklisted or malformed returns the form with the reason and up to three available alternatives.
- If the link's code and a typed code differ, the typed code wins. An unknown typed code is ignored with a neutral note, and the signup still completes.
- Self-referral (the same normalised email) is blocked by the existing rule. Fraud flags still apply, and flagged signups count until voided.
- A voided referral is kept for audit with its reason. Voiding removes it from counts, the leaderboard, the ladder, wave 1 and the export's active set. Un-voiding restores it.
- Pausing a partner does not touch past attributions or the welcome discounts already fixed.
- Requesting a new dashboard link cancels every earlier link.

## Acceptance criteria

- [ ] Nothing counts an unconfirmed signup, anywhere.
- [ ] No cookie, session, password or new interactive component is added, and the cookie inventory still lists two entries.
- [ ] `/r/{CODE}` behaves as documented and is part of the hand-over contract.
- [ ] Codes are unique across members and partners, enforced by the database.
- [ ] No coupon reaches `settled` in this repository. The reward-gating test enumerates the new paths.
- [ ] The welcome discount exists only for partner-referred friends, and is fixed at signup.
- [ ] Every founder command is audited with before and after.
- [ ] The DSR export and erasure cover every new table, reconciled against `docs/data/model.md`.
- [ ] `export:attribution` is idempotent and matches its documented schema.

## Telemetry

Applications by type and status, activations, partner-attributed confirmations by attribution method, and ladder-stage distribution. All of it comes from server-side counts, with no personal data in any analytics event.

## Open questions for the founder

None. **D1 was answered on 2026-11-17:** the first 1,000 verified members stay in wave 1 (recorded on E11.7-03), and `/me` shows every member's early-access status (recorded on E11.7-04).

## Planning defaults

These were chosen while planning, to satisfy the standing rules where the brief and answers are silent. The founder may change any of them on its ticket.

| Default | Ticket |
|---|---|
| A partner dashboard link lasts 30 days, the same as `/me`'s | E11.7-09 |
| `partners list --stale` shows partners more than 14 days in `applied`, `approved` or `contract_sent`. Nothing changes automatically | E11.7-06 |
| Rejected and unconfirmed applications have their personal fields purged after 90 days | E11.7-05 |
| A void before the draw snapshot is committed also voids that referral's giveaway entry. After commitment, nothing in the draw changes | E11.7-02 |
| A paused or terminated partner's member code keeps working as a plain member referral, without partner perks | E11.7-07 |
| An active partner is in wave 1 only while active; friends keep the wave 1 they got through a partner unless their own referral is voided | E11.7-07 |
| A typed code that is unknown or inactive is ignored with a neutral note, and the signup completes | E11.7-08 |
| An erased partner's code is deactivated and never reissued | E11.7-05 |

## Founder brief, 17 November 2026 (verbatim)

**Everything in this spec that differs from the brief was changed by the answers that follow it.**

> # Build brief: Valstara pre-launch partner programme (simple, temporary)
>
> ## 0. The most important constraint: keep it simple
>
> This is **not** a full affiliate platform. It's a lightweight partner layer on top of the existing pre-launch waitlist and referral system. It runs only during the pre-launch campaign (now → July 2027).
>
> When Valstara's main platform launches, a **separate, full-scale affiliate system** will be built there. It handles orders, commissions, payouts and everything advanced. This pre-launch system is then retired. Its only lasting outputs are:
> 1. **Clean attribution data**, exported to the main platform.
> 2. **Partner links and codes that keep working** after the switch.
>
> **Target effort: about 40–60 hours in total.** Reuse what exists. Prefer server-rendered pages, plain forms and SQL over new frameworks, SPAs or third-party services. If a feature looks like it needs a lot of work, propose a simpler version or flag it rather than building it.
>
> **Never build any of the following:** commission calculation, earnings, balances or ledgers; payouts, payout details, tax forms or invoices; order tracking of any kind (no orders exist before July 2027); multi-level or tiered structures; deep links, sub-IDs, UTM builders or click analytics beyond simple counts; a creative/banner builder, a public API or webhooks; multi-currency, i18n, or in-app contract signing; device fingerprinting, VPN/proxy blocking or CAPTCHA beyond the Turnstile already on the site.
>
> ## 1. Business context
>
> - **Valstara** is a direct seller of digital goods: AI, streaming, music and productivity subscriptions at 50–80% below list price. It sells under its own name with a guarantee. The company is 3NITY Digital Limited (Hong Kong).
> - **Timeline:** now → July 2027: pre-launch (waitlist, referrals, partner programme). Early July 2027: early access opens on the main platform for qualifying members; the first real orders arrive. Early September 2027: public launch.
> - **Brand:** trust-first, in a category buyers assume is full of scams. Everything partners see has to be clear, accurate and honest. No hype, no manufactured urgency.
> - **What the partner programme is for:** recruiting marketers, creators, student ambassadors and community owners who promote the pre-launch campaign through their own link or code. Once real orders start (July 2027), they earn commission on what their referred customers buy. **That commission is handled entirely by the main platform**, not by this system.
> - **Partner terms** (show them in the copy; never calculate them here): **10%** of order value on all products; on every order a referred customer places for **12 months** from that customer's first order; **one level only**: no commission for recruiting other partners; **founding rate lock**: partners who join before public launch keep these terms for the life of the programme; every partner signs a short, plain-English contract.
> - **Partner types:** `standard`, `student_ambassador`, `creator`. The type only affects the welcome perk (section 3.6) and reporting.
>
> ## 2. Existing environment (locked; reuse, don't replace)
>
> Astro with the Node adapter and API routes, Docker Compose on a VPS behind Cloudflare. Postgres 17, database `valstara_waitlist`, separate from the future Medusa database. The waitlist's signup form with Turnstile, a country selector and double opt-in; a unique referral code per member with `?ref=` captured server-side as a signed hidden field; referral confirmation and milestones (early access earned at 3 confirmed referrals); the preference survey; the fraud layer (normalisation, disposable-domain blocklist and MX check, self-referral flags, /24 velocity flags), which raises flags and never auto-bans. Don't block VPNs or proxies. Resend for transactional email, Brevo for broadcasts. Cookieless Umami plus Cloudflare Web Analytics. Builds in GitHub Actions only. The portable design-token file; light-first, coral `#E8654A` on `#FAFAFA`, midnight `#171733` for dark bands; codes and numbers in JetBrains Mono; copy in content files. English only, TypeScript, Zod or the project's existing validation library. If the repo differs from this description, report what you find and adapt the plan to it.
>
> ## 3. Functional requirements
>
> ### 3.1 Entry routes
> 1. **Public application:** anyone can apply at `/partners/apply`. The founder **reviews every application by hand**.
> 2. **Auto-invite:** when a member reaches **10 confirmed referrals**, send them a one-time email inviting them to apply. The link pre-fills their name, email and country. They still go through the same application and review.
>
> ### 3.2 Application form (ask only what's needed)
> **Required:** full name; email, verified through the existing double opt-in or magic link (if the applicant isn't yet a waitlist member, applying creates or links a member record for the same email); country of residence; partner type: standard / student ambassador / creator; main promotion channels: multi-select (TikTok, YouTube, Instagram, X, Discord, Telegram/WhatsApp groups, newsletter/blog, campus/offline, other), plus at least one handle or URL; approximate audience size (ranges: <1k, 1–10k, 10–50k, 50–150k, 150k+); "How will you promote Valstara?" (short text, max 500 characters); preferred code (validated; see 3.4); confirmation they are 18 or older; agreement to the programme summary and the privacy policy.
>
> **Conditional or optional:** student ambassadors: name of university or college (required) and student email (optional); applying as a business: company name (optional).
>
> **Don't ask for** payout details, tax IDs, an address, a phone number, or anything else not listed here. Protect the form with Turnstile and rate-limit it. Send a confirmation email on submission.
>
> ### 3.3 Partner lifecycle (statuses)
> `applied` → `approved` (contract to be sent) → `contract_sent` → **`active`** → `paused` | `terminated`, plus `rejected`. Contracts are handled outside this system: the founder creates each contract and sends it through **signfree.io**, and the partner signs from the email link. The system only stores `contract_sent_at`, `contract_signed_at`, `contract_version`, and an optional signfree reference or URL plus notes. **Marking the contract signed activates the partner**: their code and link go live, the welcome email is sent, and retroactive attribution runs (3.5). **Paused or terminated:** the link and code stop attributing new signups. Visitors still land on the site normally, with no referrer recorded and a neutral message. Existing attributions are kept unless the founder voids them one by one.
>
> ### 3.4 Links and codes
> - Each partner gets a short link: `https://valstara.com/r/{CODE}`. It redirects to the landing page with the referral captured through the existing server-side mechanism. **This URL format is permanent.** Flyers and QR codes will be printed with it, so it must keep working after the switch to the main platform. Document it as a hand-over requirement.
> - Custom code, chosen by the partner at application: 4–16 characters, A–Z and 0–9, case-insensitive, stored in uppercase; unique across all member referral codes and partner codes; checked against a blocklist covering brand and provider names (VALSTARA, NETFLIX, SPOTIFY, CHATGPT, etc.), reserved words (ADMIN, FREE, SUPPORT, etc.) and profanity; the founder can edit the code at approval.
> - The partner's existing member referral link keeps working and points to the same partner identity once they're active.
> - Typed code entry: an optional "Referral code" field on the signup form, pre-filled from the link. If the link and the typed code differ, the **typed code wins**.
> - **One referrer per signup.** It's fixed when the signup is created. Only an admin correction can change it.
> - QR code: each partner can download a QR code (PNG and SVG) of their link from the dashboard.
>
> ### 3.5 Attribution rules
> Only **confirmed** signups count anywhere: dashboard, leaderboard, milestones, export. **Self-referral is blocked** (same normalised email); existing fraud flags still apply, and flagged signups count until the founder voids them. **Retroactive attribution:** when a member becomes an active partner, every confirmed signup they referred before approval is attributed to them as a partner, with `attribution_method = retroactive`; those signups also receive the partner welcome perk from that point. Store `attribution_method` as `link` | `code` | `retroactive`. **Void:** the founder can void any single referral with a reason. Voided referrals are excluded from counts, the leaderboard and the export's active set, and they're kept for audit.
>
> ### 3.6 Perks for people who sign up through a partner
> *(Replaced by the founder answers, point 4.)*
>
> ### 3.7 Partner dashboard (`/partners/dashboard`)
> Shows: their link and code, plus the QR download; **stats, counts only**: confirmed signups, pending confirmation, voided, and signups per week (a simple table or sparkline); breakdowns by survey category; the **leaderboard** with their own rank; **a terms summary**: 10% / 12 months / one level / founding rate lock, contract signed date and version, and the timeline, including "Earnings start with early access in July 2027." **No earnings figures**; **an asset kit**: downloadable files, copy-paste message templates (stored as content files) with the partner's code and link filled in automatically, and a **print-ready flyer page** (HTML print stylesheet, A4 and US Letter) showing their QR code, code and the welcome perk; **settings:** leaderboard display name, a toggle to show their name publicly on the leaderboard (off by default), and email preferences for non-essential emails. **Privacy:** partners never see the emails or identities of the people they referred. They see aggregate counts only.
>
> ### 3.8 Leaderboard
> Partners only, never public. Ranked by confirmed, non-voided signups. Show the top 20 plus the viewer's own rank. Other partners appear as initials or a nickname unless they've chosen to show their display name. Recompute on a schedule (hourly is fine) and cache it.
>
> ### 3.9 Admin (founder only)
> *(Replaced by the founder answers, point 1.)* Actions: approve (with code edit), reject (optional template email); mark contract sent, mark contract signed (date, version, reference); pause, terminate, reactivate; change partner type; void or un-void a referral, with a reason; an internal notes field. Partner overview: counts, flagged referrals per partner, last activity. CSV export of partners and referrals at any time. **Audit log:** record every admin action (who, what, when, before/after).
>
> ### 3.10 Emails
> **Transactional (Resend):** application received; approved ("Your contract will arrive by email from signfree.io shortly"); rejected (polite, brief); **activated/welcome**: link, code, dashboard access, asset kit, and a 3-step getting-started checklist: get your code → share once → see your first confirmed signup; dashboard link; auto-invite at 10 referrals; **milestones**: first confirmed signup *(the others are cut by the founder answers, point 9)*.
>
> **Monthly partner digest:** automated, sent on the 1st of each month to active partners. Contents: their confirmed signups this month and in total, rank, category breakdown, total waitlist growth, plus one founder note pulled from a content file. **The cadence is configurable**, so it can switch to weekly from April 2027.
>
> **Brevo sync:** *(cut by the founder answers, point 9: a CSV export instead.)*
>
> **Referred-user confirmation email:** extend the existing email to mention the partner perks when they apply.
>
> **Copy rules for all partner-facing text:** sentence case, plain and precise, no exclamation marks; **never use** "passive income", "unlimited", "financial freedom", "team" or "downline"; no countdowns or fake scarcity. All copy lives in content files the founder can edit.
>
> ### 3.11 Public programme page (`/partners`)
> A plain explanation of the programme, with an "Apply" call to action. Content to cover: "You recommend. Your audience saves. You earn 10% of what they buy for 12 months."; one level only; the people you send are covered by Valstara's guarantee; founding partners keep the founding terms; earnings start with early access in July 2027; the positioning line: about double what the large marketplaces pay. Copy lives in a content file.
>
> ## 4. Data model (in `valstara_waitlist`; propose the exact schema)
> Suggested shape, to adapt to the existing referral tables: `partners` (id, member_id, legal_name, email, country, partner_type, status, timestamps per status, contract fields, display_name, show_name_publicly, notes); `partner_applications` (the submitted form data; can be merged into `partners`); `referral_codes` (code unique uppercase, owner member or partner, active flag, created_at — one namespace); referral edges extended with referrer_type, partner_id, attribution_method, voided_at, void_reason, early-access eligibility and the welcome discount; tokens, the admin audit log and an email log. Use the migration tooling already in the repo.
>
> ## 5. Hand-over to the main platform (critical)
> Build `export:attribution`, an **idempotent, documented export** in both JSON and CSV that the main platform's affiliate system will import before early access in July 2027:
> - **Partners:** id, legal name, email, country, partner_type, status, code(s), approved_at, contract_signed_at, contract_version, `founding_partner = true`, display name.
> - **Referrals:** referred member id and email, referrer id and type, partner id, partner code, attribution_method, signup_at, confirmed_at, voided flag and reason, early-access eligibility, the welcome discount.
> - **Member referral edges** (non-partner) in the same format, so the main platform gets one complete attribution graph.
>
> Also a short **hand-over document** covering the `/r/{CODE}` URL contract, which the main platform must serve with identical behaviour; code format rules; field definitions; and the recommended cutover steps: freeze writes → export → import → switch `/r/` routing → keep this database read-only for 90 days.
>
> ## 6. Testing
> Unit tests: code validation (format, uniqueness, blocklist, case-insensitivity); attribution precedence (typed code beats link; one referrer per signup); self-referral blocking; retroactive attribution; void handling; perk assignment; paused/terminated behaviour. Integration tests: the lifecycle from application to activation; dashboard link access (expiry, cancellation); admin actions writing to the audit log; export output matching the documented schema. Email rendering checks for every template. A seed script with sample partners and referrals for local development.
>
> ## 8. Defaults
> Auto-invite threshold: 10 confirmed referrals. Leaderboard: top 20, recomputed hourly. Digest: monthly on the 1st; configurable to weekly.

**Note on this record:** the brief's sections 2, 3.9 and 4 are condensed. Sections 3.6, 3.9 and the Brevo sync point to the founder answers that replaced them. Section 7 (the agent's deliverables) is omitted. Every requirement still in force is quoted.

## Founder answers, 17 November 2026 (verbatim)

> FOUNDER ANSWERS — PARTNER PROGRAMME QUESTIONS (17 Nov 2026)
>
> 1. ADMIN INTERFACE: Option (a).
> Reuse the existing secure admin API (secret key + authenticator code). Founder commands:
>   - approve (with code edit), reject
>   - contract-sent, contract-signed (date, version, signfree reference)
>   - pause, terminate, reactivate
>   - set-type
>   - void / unvoid a referral (with a reason)
>   - CSV export
> Every action goes to the audit log. No admin pages, logins or sessions.
>
> 2. PARTNER DASHBOARD ACCESS: Option (a).
> A private link emailed to the partner, the same approach as /me. No cookie, no session.
> Add a "send me a new link" action. Sending a new link MUST cancel the previous one, so a forwarded link can be shut off.
>
> 3. COUNTRY: Option (a).
> Collect country of residence only on the partner application, from a plain dropdown. Update the privacy policy and ADR-026. Remove the country breakdown from the dashboard.
>
> 4. EARLY ACCESS AND REWARDS: this replaces the brief and the repo's current reward rules.
>
> 4.1 Early-access waves
>   - Wave 1 = early access, early July 2027.
>   - Straight into wave 1:
>       * any member with 3 or more confirmed, non-voided referrals;
>       * all active partners;
>       * everyone who signed up through an active partner's link or code (including retroactive attribution).
>     This replaces "3 referrals moves you up one wave".
>   - Everyone else: the existing signup-order logic for waves 2–4 is unchanged.
>
> 4.2 Remove the current "15% off the first order at 3 confirmed referrals" reward. The ladder below replaces it.
>
> 4.3 Referrer reward ladder (members AND partners; for partners this comes on top of their commission)
>   - Count = confirmed, non-voided referrals (retroactive partner attribution included).
>   - Coupon 1: unlocks at 3 referrals at 5%, +5% per 3 more referrals, maximum 30%.
>       3 = 5%, 6 = 10%, 9 = 15%, 12 = 20%, 15 = 25%, 18 = 30%.
>   - Coupon 2: unlocks 3 referrals after coupon 1 reaches 30%. Same steps.
>       21 = 5% ... 36 = 30%.
>   - Coupon 3: the same again.
>       39 = 5% ... 54 = 30%.
>   - After coupon 3 reaches 30% the ladder ends. Further referrals still count for attribution, the leaderboard and partner commission, but earn no more coupons.
>   - Coupon rules:
>       * each coupon is single-use (one order);
>       * only one discount per order: coupons never stack with each other or with any other discount;
>       * usable on any order (first, tenth, any);
>       * expire 5 years after public launch (early September 2032).
>   - If referrals are voided, recalculate the ladder from the current count up to handoff.
>
> 4.4 Referred friend's welcome discount (first order only, single-use)
>   - Set by the referrer's ladder stage AT THE MOMENT THE FRIEND SIGNS UP, and fixed from then on:
>       * 10% while the referrer has not unlocked coupon 2 (fewer than 21 referrals);
>       * 15% once coupon 2 is unlocked (21–38 referrals);
>       * 20% once coupon 3 is unlocked (39 or more referrals).
>   - Friends referred earlier keep the discount they got.
>   - Friends referred by a student ambassador get the higher of 15% and the ladder value.
>   - Expires 5 years after public launch.
>   - No stacking: if a person holds several discounts (their welcome discount plus their own coupons), they choose one per order.
>
> 4.5 Scope in this system
>   - Store these as entitlements only. Don't generate checkout codes; the main platform does that at launch.
>   - Show progress on /me and on the partner dashboard, e.g. "Coupon 1: 30% · Coupon 2: 10% · 2 more confirmed referrals to 15%. Friends you refer now get 15% off their first order."
>   - Include all ladder state and every friend's welcome discount in the attribution export and the handoff document.
>
> 5. TYPED REFERRAL CODE FIELD: Option (a).
> A collapsed "Have a referral code?" toggle in the hero form only. No JavaScript, handled server-side. Write the ADR-008 amendment.
>
> 6. NO NEW INTERACTIVE COMPONENTS: Accept the recommendation.
>   - Codes are checked when the application is submitted; if a code is taken, the form returns with the error and alternatives.
>   - Link and code are shown as large, selectable text, with no copy buttons.
>   - QR codes are generated on the server.
>
> 7. ASSET KIT: Option (a).
> Images and PDFs are committed to the repo and ship with each deploy. Videos are plain links.
>
> 8. AUTO-INVITE AT 10 REFERRALS: Accept the recommendation.
> Send it only to members who opted in to marketing. /partners stays publicly reachable.
>
> 9. EFFORT CUTS:
>   - APPLY: cut the Brevo partner sync. Provide a CSV export the founder imports each quarter.
>   - APPLY: cut milestone emails except "first confirmed signup".
>   - DO NOT APPLY: keep the partner leaderboard.
> The reward ladder in point 4 is new scope. Give it its own hour estimate and update the total.

**Follow-up answers (founder, 2026-11-17, verbatim):**

> 1. (a) Recommended: keep the rule.
> 2. It should only apply to PARTNERS that are part of the partner (affiliate) programme. The 10/15/20% ladder with discounts doesn't apply to normal members that aren't part of the partner programme.
> 3. Recommended: wave 1 is recalculated the same way as the coupons, up to handoff. So:
>    * a member who drops below 3 confirmed referrals leaves wave 1;
>    * a friend whose own referral is voided loses their welcome discount;
>    * that friend also loses the wave-1 place they got through a partner.
> 4. Recommended: a configured launch date, defaulting to 1 September 2027, so coupons expire 1 September 2032. You set the real date at handoff, and the export carries the computed expiry.

The questions they answer, in brief:

1. Keep ADR-012: coupons stay held until one of the holder's friends places a first order.
2. Who gets the friend's welcome discount.
3. What voids do to wave 1.
4. The exact expiry date.

**How answer 2 is read:** the 10/15/20% *welcome discount* applies only to friends referred by an active partner. The 5–30% *coupon ladder* of 4.3 still applies to members and partners alike.

## Founder amendments, 22 November 2026 (verbatim)

These amend the brief, both sets of answers above and `docs/prerequisites/valstara-prelaunch-growth-decisions.md`, wherever they differ. They are recorded on the epic in `docs/plan/development-plan.md` (Epic E11.7, founder decisions 2026-11-22).

From the founder's message of 21 November 2026:

> Instead of comparing to Kinguin, we will compare to G2A, Eneba, and Game Seal. Those are the only three marketplaces or websites that we need to compare ourselves to. For Game Seal, they pay 2 to 3% for subscriptions. So in that case, our offer at 10% is more than triple. So I think we should always lead with that. More than triple in affiliate earnings. Then compared to Game Sale, but only during the pre-launch campaign. This is very important. Once we launch, the affiliate earnings will be different. So only affiliates that get accepted into our partner program during the pre-launch campaign will receive the 10% affiliate earnings only during the pre-launch campaign and the users they get in for that. If, for example, an affiliate then wants to become an affiliate once we launch the real website, then the new rates will be discussed from that. And any new users they refer to us after the public launch will be for that new different rate. [...] So all orders placed from 1st September all the way around 1 year until 1st October 2028 will count towards the 10% of the affiliate, only for those users referred during the pre-launch campaign. Once that year has passed, they are, removed as a referred user to that affiliate. They would then have to, get that user or get that customer referred or updated again afterwards. But then for the new affiliate rates that we actually have once we have launched, of course.

From the founder's message of 22 November 2026, which authorises the change:

> Okay, so first and foremost, regarding the commission, that the founding rate lock for the life of the program. I give you founders authorizations to change this. [...] Regarding the founding rate lock, it will be for 1 year. So no lifetime lock. Make sure that you update this decision everywhere in all documents that are relevant or that are referencing the old terms. Regarding the dates of early access in July 2027, change this to, I've already mentioned it, I'll say it again. The most updated early access date will be 1st September 2027 and the public launch will be on 1st October 2027. And regarding the positioning line, the recorded line is about double the marketplaces and not more than triple game sale. I understand that. And again, I give you founder authorization to update it. We should start with our best position here, which is more than triple than game sale, because that's actually true. And for the second, it will be double than G2A and Eneba. So it will not be about to double the marketplaces. It will state clearly double the rate than G2A and Eneba. And it will also state more than triple than GameZone. Update it.

**How these are read:**

1. "Game Seal", "Game Sale", "game sale" and "GameZone" all mean **GameSeal**.
2. The 22 November message first gives the public launch as "1st October 2028", then restates it as **1 October 2027**; the restatement is the decision.
3. **The one-year founding rate lock is the commission window:** orders from early access (1 September 2027) to one year after public launch (1 October 2028).
4. "More than triple in affiliate earnings" is written in copy as a commission rate ("more than triple GameSeal's commission rate"), because what a partner earns depends on their audience's purchases and only the rate can be compared truthfully (`docs/brand/copy-rules.md#claims-that-must-stay-true`).

