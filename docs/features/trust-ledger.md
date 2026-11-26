# Feature: The Trust Ledger

Founder-defined 2026-11-22; placed in the plan as Epic E11.8 on 2026-11-24. Built by E11.8-01 (`docs/plan/development-plan.md`), with the founder decisions of 2026-11-25 (D-076): the page and its sitemap follow the flag on every request, the links follow the committed entries, and the ticket commits no entry. **This spec is the in-repository record of the founder's definition and decisions.** The definition has no other source, and it is recorded verbatim at the end. Where this spec and the verbatim definition differ, the later founder decisions recorded here win.

## Summary

A public, monthly record of how Valstara is actually doing on the things buyers worry about: delivery, problems, refunds, suppliers and payouts. **Bad numbers are published alongside good ones**, with the same definitions every month, and **nothing is edited afterwards.** A mistake gets a dated correction note in the next entry. It is one page at the permanent URL `/trust-ledger`. A new entry is added each month, and every past month stays visible.

**Founder decisions (2026-11-22):**

1. The name is **"Trust Ledger"**.
2. **Operations numbers only, never revenue**, and never margins or profit.
3. **The first entry (Phase 1) is published in December 2026,** when the pre-launch website goes live.

**Founder decision (2026-11-24):** no supplier register is ever published. Valstara may use several suppliers for the same product and switches between them in the background. The Ledger carries counts of suppliers only (evaluated, verified, rejected), never names, prices or which supplier serves which product.

## Feature flag

| Flag | Default | Off means |
|---|---|---|
| `trust_ledger.page` | **off** | `/trust-ledger` answers `404`, and its child sitemap `/sitemaps/trust-ledger.xml` is an empty `<urlset>`. The founder turns it on once the first entry is merged. **Once it is on, it stays on**: the page is a commitment, and switching it off is for an incident only, such as a wrong figure in a published entry |

The page and the sitemap are rendered on request and read the flag on every request (through the flag service's five-second cache; a lookup failure reads as off). **They also answer as if off while no entry is committed**, so an empty Ledger is never shown, whatever the flag.

**The links follow the committed entries, not the flag** (D-076 Q1). The line beside `/guarantee`'s content, the line on `/partners` and the footer link are rendered at build, and only once an entry is committed: the pages that carry them are prerendered (flags are runtime values, ADR-023), and no page changes its rendering mode. With no entry committed, no link renders anywhere. **If the flag is switched off in an incident, the links stay and lead to `404` until the next deploy removes them**, or until the flag is back on.

## What it contains

### Phase 1: pre-launch (December 2026 → September 2027)

| Section | What it shows |
|---|---|
| Waitlist | Confirmed members (total and new this month), and the share that came through referrals |
| Build progress | What shipped this month and what's next, as plain checklist items |
| Supply readiness | Suppliers evaluated, verified and rejected, and how many launch products have verified supply. Counts only |
| Partner programme | Applications received, partners approved and active |
| Policy changes | Anything published or changed (guarantee terms, partner terms), with a date |
| Corrections | Mistakes made and fixed, e.g. a wrong price on a price-index page |
| Launch status | "On track for early access in September 2027", or an honest note if it moves and why. A status, never a countdown |

### Phase 2: from early access (1 September 2027 →)

Delivery, guarantee claims (resolved, replaced or refunded, in the guarantee's order), time to resolve, refunds, out-of-stock events, supplier incidents, reviews, partner payouts and support response, each with a fixed definition. Phase 2 figures come from the storefront, which does not exist yet. Before Phase 2 starts, the storefront's data source for each metric is defined.

**Every entry ends with three short sections:** *What went wrong*, *What we changed*, and *Focus for next month*.

### What it never includes

Customer personal data (totals only); supplier names, supplier prices or any supplier register; individual partners' earnings unless the partner agrees; revenue, margins or profit; numbers without context.

## Rules

- **The same definitions every month**, in a fixed "How we count" section. A changed definition is announced in that month's entry.
- **An entry is never edited once published.** Corrections go in the next entry, dated.
- **Exact numbers.** A rounded figure is labelled as one (`docs/brand/copy-rules.md#claims-that-must-stay-true`).
- **Plain brand voice:** sentence case, no exclamation marks, no spin. The forbidden-copy scan covers the entries.

## The entries

One data file per month, `src/content/trust-ledger/YYYY-MM.json`, validated at build against the entry schema (`src/server/trust-ledger/entry-schema.ts`). The file's name is its month. Every object in it is closed, so a field the schema does not name is refused, and it has **no field for a supplier's name, a price, revenue, a margin, profit, earnings or any person**; every figure is a non-negative integer count. Each piece of text is one paragraph or list item of the founder's plain words, rendered as text, never as Markdown or HTML: an email, IP or web address, markup, a line break or an exclamation mark is refused.

| Field | Section | What it holds |
|---|---|---|
| `month` | — | `YYYY-MM`, the file's own name |
| `introduction` | Introduction | Paragraphs |
| `waitlist` | Waitlist | `countedOn` (the day the counts were read), `total`, `newThisMonth`, `joinedThroughReferral`. **Written by `trust-ledger draft`, never typed by hand.** Shown as "Counted on …", "Total: …", "New this month: …" and "Joined through a referral: X of Y" |
| `buildProgress` | Build progress | Items, each `{ item, status }`, status `done`, `in progress` or `next`; shown as "item: status" |
| `supplyReadiness` | Supply readiness | `note` (paragraphs, may be empty), `total` and `thisMonth` (`{ evaluated, verified, rejected }`, with verified + rejected = evaluated; `thisMonth` may be `null` only for a month before `2027-01`, and is required from `2027-01`, when P11 says each entry starts giving the month's figures (D-077 Q3); the schema refuses a `2027-01` or later entry with `thisMonth: null`, so a 2027 draft fails until the founder completes it), `launchProducts`, `launchProductsWithVerifiedSupply` (shown as "X of Y") |
| `partnerProgramme` | Partner programme | `applicationsReceived`, `approved`, `active` (active ≤ approved ≤ applications) |
| `policyChanges`, `corrections` | Policy changes, Corrections | Either `{ items: [{ date, text }] }`, shown as "1 December 2026: text", or `{ none: "<one paragraph>" }` |
| `howWeCountChanges` (optional) | Changes to how we count | Paragraphs: what changed in "How we count" and why. Required, by CI, in the entry that ships a changed "How we count" |
| `launchStatus`, `whatWentWrong`, `whatWeChanged` | Launch status and the closing sections | Paragraphs |
| `focusForNextMonth` | Focus for next month | Items |

**A published entry never changes.** CI's append-only check (`scripts/ci/trust-ledger-append-only.mjs`, in `npm run security`) fails a pull request that edits or deletes an entry present at its merge base, byte for byte, as the giveaway rules revisions and partner announcements are guarded. **"How we count"** is the content file `src/content/trust-ledger-how-we-count.md`, P11 Part 1 as written; the same check fails a change to it unless the branch also adds an entry whose `howWeCountChanges` announces it. An entry that breaks its schema, its file name or the copy rules fails the build: `scripts/ci/trust-ledger-check.ts` runs before every build, and the site's bundled ledger (`src/server/trust-ledger/bundled.ts`) validates every entry again when the prerendered pages render.

**This ticket committed no entry** (D-076 Q2): December's waitlist figures exist only on the production database in December, and a committed entry never changes. P11 Part 2 is a test fixture (`test/fixtures/trust-ledger/2026-12.json`) that proves the schema holds it word for word and the page renders it. The tests follow the repository's committed entries: the no-entry case is proven on the repository's own build while it commits none, and on a fixture build with no entry once it commits one, so the December entry needs no test edit.

## The waitlist figures

`GET /api/admin/trust-ledger/waitlist?month=YYYY-MM` (behind the E5-03a admin boundary: the secret key and an authenticator code) returns, for one calendar month in UTC, exact counts only:

- **`verified_total`**: subscribers whose status is `verified` when the request runs (the entry's "Total", on its "Counted on" day). Unverified, expired, unsubscribed, bounced, disqualified and erased rows are never counted (standing rule 2).
- **`verified_in_month`**: of those, the ones verified during the month ("New this month").
- **`verified_in_month_through_referral`**: of those, the ones whose referral edge is `confirmed` and not voided, the definition every consumer of the confirmed count uses ("Joined through a referral"). **A partner's link or code makes such an edge too, so partner referrals are counted**, as P11 Part 1 defines. A rejected, voided or unconfirmed edge is not.

It is one aggregate query (`src/server/db/trust-ledger.ts`), and it refuses a malformed month and a month that has not begun. Every read is audited as `trust_ledger.waitlist_counted` with the actor, the month and the three counts, in the transaction that reads them.

## The monthly entry

1. **Draft.** In the month after the one reported: `npm run trust-ledger -- draft --month 2026-12` (`src/server/trust-ledger/cli.ts`). It uses the admin command line's key, code and origin rules to call the route above, and writes `src/content/trust-ledger/2026-12.json` with the waitlist counts and every other section empty. It refuses a month that already has an entry before asking for anything or sending a request, and never overwrites a file. An empty section fails the schema, so a draft cannot be built until it is complete.
2. **Complete.** Write the other sections and the three closing sections (about 1–2 hours a month).
3. **Publish.** A pull request, CI, merge and deploy. The page is built from the committed entry files.

**December 2026, the first entry (D-076 Q2):** run `npm run trust-ledger -- draft --month 2026-12`; paste in P11 Part 2 (`docs/prerequisites/p11-trust-ledger-text.md`) into the sections above, word for word, as the test fixture `test/fixtures/trust-ledger/2026-12.json` shows (each build-progress line as `{ "item", "status" }`, each policy change as `{ "date": "2026-12-01", "text": "we published …" }`, Corrections as `{ "none": "None. This is our first entry." }`); confirm P11's three checks (the go-live date in the policy changes, the partner counts against `partners list`, and the giveaway line in build progress); merge; then turn `trust_ledger.page` on. The links appear with that entry's deploy; the page and its sitemap follow the flag. The same steps are in `docs/ops/launch-cutover.md` and `docs/ops/runbook.md`.

## User flows

1. **The founder drafts a month** with `trust-ledger draft`, completes it and publishes it, as above.
2. **A visitor reads it** at `/trust-ledger` (rendered on request, the trust document layout of E11.5-11s, the typed `trust` social card, no script beyond the page-view emitter): the page's H1, the newest month at the top, the full archive below, each month's sections in the fixed order, and the "How we count" section. It is linked from `/guarantee` (P11 Part 3's line, in the side card beside the content, never in `src/content/guarantee.md`), from `/partners` (the same line, in its side card) and from the footer, once an entry is committed. The page title, "The Trust Ledger", and its meta description, "We publish our real numbers every month, the bad ones included.", sit in the "How we count" content file's frontmatter; they and the `/partners` line (P11 Part 3's sentence, as written, with no partner-specific line) are founder-accepted (D-077 Q1 and Q2).

## Edge cases and error states

- **An entry file fails its schema, is misnamed, or breaks the copy rules:** the build fails.
- **A published entry's file changes or is deleted:** CI fails. Entries are append-only against the merge base.
- **"How we count" changes without a new entry that announces it:** CI fails.
- **No entry is committed** (before December 2026): `/trust-ledger` answers `404` even with the flag on, its sitemap lists nothing, and no link renders.
- **An existing month is drafted again:** the command refuses before asking for anything, and writes nothing.
- **A month is missed:** nothing is generated automatically. The next entry says the month was missed; a skipped month is stated, never hidden.
- **A wrong published figure:** a correction in the next entry. For a serious error, the flag can also be turned off until the correction ships; the links stay and lead to `404` until a deploy, because they follow the committed entries.

## Acceptance criteria

- [ ] Entries are data files validated at build. **A published entry can never change**, enforced by CI
- [ ] The waitlist figures come from the database through an authenticated, audited admin route, as exact aggregate counts with no personal data
- [ ] No supplier name, revenue, margin or individual's data can be represented by the entry schema
- [ ] No third-party request, no new island, no script beyond the page-view emitter
- [ ] The flag-off path is tested, and `/trust-ledger` is a permanent URL on the port checklist

## Telemetry

Page views (an estimate, like every view count) and trust-page-to-signup rate. No new event.

## Founder definition, 22 November 2026 (verbatim)

**Reading note:** the definition was written before the 22 November date change. Its "early access in July 2027" now reads September 2027 (Epic E11.7 founder decision 1), and its "Supplier Register" mention is superseded by the 2026-11-24 decision above.

> **What it is**
>
> The Trust Ledger is a public, monthly record of how Valstara is actually doing on the things buyers worry about. That means delivery, problems, refunds, suppliers and payouts. Bad numbers are published alongside good ones, with the same definitions every month, and nothing is quietly edited afterwards.
>
> It's a single page on the site. A new entry is added each month, and all past months stay visible.
>
> **Why it fits Valstara**
>
> It's the trust promise, shown with proof. Your whole positioning is "we're the accountable ones in a category full of scams." Anyone can say that. Publishing your refund count every month shows it, and a marketplace can't easily copy it.
> It answers the exact things this category is criticised for. The research found the category's reputation was damaged by secrecy, slow dispute handling and undisclosed paid promotion (the G2A scandals of 2016 and 2019). The Ledger is the opposite of each.
> It gives partners something to point to. A partner asks their audience to trust you, which puts their own reputation on the line. "Here are Valstara's real numbers, refunds included" is their best answer to "is this legit?"
> It's ready-made content every month. One entry feeds your member email, the partner digest and a building-in-public post.
> It matches your brand rules. Your guidelines already name programmes in plain English ("the Triple Guarantee", "the Supplier Register"), and the Ledger is the place where both are shown working.
>
> **What it contains, by phase**
>
> **Phase 1: pre-launch (now → September 2027)**
>
> There are no orders yet, so it reports progress and readiness:
>
> | Section | What it shows |
> |---|---|
> | Waitlist | Confirmed members (total and new this month), and the share that came through referrals |
> | Build progress | What shipped this month and what's next. Plain checklist items, e.g. "Order vault: done" |
> | Supply readiness | Suppliers evaluated / verified / rejected, and how many launch products have verified supply |
> | Partner programme | Applications received, partners approved and active |
> | Policy changes | Anything published or changed (guarantee terms, partner terms), with a date |
> | Corrections | Mistakes you made and fixed, e.g. a wrong price on a price-index page |
> | Launch status | "On track for early access in July 2027", or an honest note if it moves and why. It's a status, never a countdown. |
>
> **Phase 2: from early access (September 2027 →)**
>
> Here it starts reporting real operations:
>
> | Metric | Definition (fixed; never changed silently) |
> |---|---|
> | Orders delivered | Orders completed in the month |
> | Delivery time | Median delivery time, plus % delivered within 24 business hours (Mon–Fri). Also the slowest delivery of the month. |
> | Guarantee claims | Claims opened, then how they ended: resolved / replaced / refunded, matching the guarantee's order |
> | Time to resolve | Median time from claim to fix |
> | Refunds | Number and % of orders |
> | Out-of-stock events | Which products ran out and for how long. This backs up your honest scarcity wording. |
> | Supplier incidents | E.g. "a batch of 14 accounts stopped working; all replaced within X hours; supplier paused" |
> | Reviews | Trustpilot rating and review count, including how many negative reviews you replied to |
> | Partner payouts | Total commission paid, number of partners paid, and whether every payout was on time |
> | Support response | Median first-response time |
>
> Every entry ends with three short sections: What went wrong, What we changed, and Focus for next month.
>
> **What it never includes**
>
> Customer personal data. Only totals.
> Supplier names or supplier prices. That's commercially sensitive and would expose your sources.
> Individual partners' earnings, unless the partner agrees.
> Margins or profit. Whether to publish revenue is your choice (see decisions below). Most trust value comes from the operations numbers, not revenue.
> Vanity numbers without context. "10,000 signups" means little without "of which 7,800 confirmed".
>
> **Rules that make it credible**
>
> Same definitions every month. They live in a fixed "How we count" section. If one ever changes, the change is announced in that month's entry.
> Publish bad months. A month with refunds and a supplier failure, explained honestly, builds more trust than a perfect record that looks too good to be true.
> Never edit past entries. Mistakes get a dated correction note in the next entry.
> Small numbers are fine. "We delivered 212 orders and refunded 2" sounds real. Present early numbers as "we're new; here's every order", not as scale.
> Plain brand voice. Sentence case, no exclamation marks, no spin.
>
> **Format and where it shows up**
>
> The page: one URL (e.g. /trust-ledger) with the newest month at the top, a full archive below, and the "How we count" section.
> Data: one small data file per month. The site builds the page from those files. The waitlist count can be read from the database automatically. That's the code item: a small static page, a few hours of work.
> Your monthly work: about 1–2 hours to fill in the numbers and write the three short sections.
> Distribution:
> linked from the guarantee page, /partners and the site footer;
> a summary in the monthly member email and in the partner digest;
> one building-in-public post per month.
>
> **Risks**
>
> A bad month is public. That's the point, and the commitment is real. If you're not willing to publish bad numbers, don't start the Ledger.
> Competitors can read it. Keep supplier details and margins out and there's little they can use.
> It only works if it keeps going. Skipping months looks worse than never starting. If time is tight, a shorter entry beats a missing one.
>
> **Decisions:**
> 1. Keep the name "Trust Ledger".
> 2. Published numbers: Publish operation numbers only. Not revenue numbers.
> 3. Start date: Begin with a Phase 1 entry now in December 2026, when we launch the prelaunch website).
