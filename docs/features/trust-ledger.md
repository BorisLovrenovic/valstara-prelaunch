# Feature: The Trust Ledger

Founder-defined 2026-11-22; placed in the plan as Epic E11.8 on 2026-11-24. Built by E11.8-01 (`docs/plan/development-plan.md`). **This spec is the in-repository record of the founder's definition and decisions.** The definition has no other source, and it is recorded verbatim at the end. Where this spec and the verbatim definition differ, the later founder decisions recorded here win.

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
| `trust_ledger.page` | **off** | `/trust-ledger` answers `404` and is left out of the sitemap, and no link to it renders on `/guarantee`, `/partners` or in the footer. The founder turns it on once the first entry is merged. **Once it is on, it stays on**: the page is a commitment, and switching it off is for an incident only, such as a wrong figure in a published entry |

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

## User flows

1. **The founder drafts a month.** A founder command asks the admin API for that month's waitlist figures and writes them into a new entry file. The founder then writes the other sections and the three closing sections by hand (about 1–2 hours a month).
2. **The entry is published** through the ordinary path: a pull request, CI, merge and deploy. The page is built from the committed entry files.
3. **A visitor reads it** at `/trust-ledger`: the newest month at the top, the full archive below, and the "How we count" section. It is linked from `/guarantee`, `/partners` and the footer while the flag is on.

## Edge cases and error states

- **An entry file fails its schema:** the build fails.
- **A published entry's file changes:** CI fails. Entries are append-only against the merge base.
- **A month is missed:** nothing is generated automatically. The next entry says the month was missed; a skipped month is stated, never hidden.
- **A wrong published figure:** a correction in the next entry. For a serious error, the flag can also be turned off until the correction ships.

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
