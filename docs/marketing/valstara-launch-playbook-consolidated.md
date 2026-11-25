# Valstara Launch Playbook — Consolidated Brief

**Version:** 2.6 · **Updated:** 25 November 2026 (2.1 applied the founder's answers of 21 Nov; 2.2 the founder's authorisations of 22 Nov; 2.3 a full review against everything merged through E11.7-08; 2.4 the founder's answers to that review; 2.5 the founder's acceptance of the four remaining recommendations; 2.6 Umami only, the widened lawyer's review and partner announcements, all logged in Part 11) · **Owner:** founder

This playbook began as a synthesis of three independent go-to-market reports (August 2026). Since then the founder has made decisions and the pre-launch site has been built. **Version 2 brings the playbook into line with both.** Where the reports and the project disagree, the project wins.

**Order of authority, highest first:**

1. `docs/plan/development-plan.md` and the ticket entries' founder decisions.
2. `docs/features/partner-programme.md`, the founder's answers of 17 November 2026.
3. `docs/prerequisites/valstara-prelaunch-growth-decisions.md`, 17 November 2026.
4. The accepted ADRs (`docs/architecture/adr/`), `docs/brand/identity-guidelines.md` and `docs/brand/copy-rules.md`.
5. This playbook.

Where this playbook adds something the project has not decided, it says so: **[Recommendation]** means a judgement not yet decided, and **[Open]** means a decision is still needed from the founder.

**How to read it.** Part 0 is the set of facts every marketing action must respect. Parts 1–8 are the playbook, by channel. Part 9 is what was kept from the original three reports, marked by whether it still applies. Part 10 lists what version 2 removed or changed, and why. Part 11 logs the founder's decisions of 21–24 November 2026, where they were recorded in the project, the tasks that stay open after their first decision, and **the questions still open before the marketing to-do list is complete (11.4)**.

---

# PART 0 — THE FACTS THE PLAYBOOK STANDS ON

These are decided or built. A marketing action that contradicts one of them is wrong, however well it might perform.

## 0.1 Company, brand and positioning

- **Valstara** is the trading brand of **3NITY Digital Limited**, Hong Kong (Business Registration No. 79886556). Founder named publicly: **Boris Lovrenovic**. Single contact address: **support@valstara.com**.
- **What we sell:** digital goods (AI tools, streaming and subscriptions, software and in-game currency at launch) **below list price**, sold directly by Valstara under its own name and guarantee. The founder's internal brief puts prices at 50–80% below list. **No public surface states a percentage saving** unless it can be proven per product and market (copy rules, price-page rules).
- **Tagline (locked):** *Premium for less.* **Positioning (locked):** *Digital goods you know are real.*
- **The live hero** pairs the two: the eyebrow *"Digital goods you know are real."*, the heading *"Premium digital goods, for less."*, and the CTA **"Join the waitlist"**. Trust leads and price follows. No discount figure appears in the hero or on the provider banners (ADR-032).
- **The Triple Guarantee (locked), always numbered I, II, III:**
  - **I — Delivered within 24 hours.** Every order is fulfilled by hand, Monday to Friday, within 24 hours of purchase.
  - **II — Protected, start to finish.** 256-bit encryption throughout, PCI-compliant payment handling, and your data is never sold.
  - **III — Resolved, replaced, or refunded.** In that order, without argument.
- **Never say:** instant delivery, immediate access, cheapest, unbeatable, insane deal, dirt cheap, grey market, black market, cracked, leaked, shared account, bypass, no refunds, "digital products" (say *digital goods*), or "we never share your data". Partner-facing copy also never uses **passive income, unlimited, financial freedom, team or downline**. The site's CI scans for these words. **Treat social posts, DMs, flyers and scripts as if the same scan ran on them.**
- **Voice:** plain, precise, unhurried. Sentence case. No exclamation marks. No manufactured urgency.
- **Launch providers shown on the site:** 34 confirmed providers (P8, `docs/prerequisites/p8-provider-list.md`), grouped as AI tools, Streaming and subscriptions, Software, and In-game currency. **Only these may be shown as "what you'll find".** The site footer states that the marks belong to their owners and that Valstara is an independent seller, not affiliated with or endorsed by them. **Every piece of marketing that shows a provider's name or logo carries the same independence.**

## 0.2 Timeline

**Decided (founder, 22 Nov 2026):** **early access on 1 September 2027** and **public launch on 1 October 2027**. These replace the earlier early-July and early-September dates in the plan, the partner-programme spec, the growth decisions and the site configuration. Wave 1's early-access month is September 2027, and coupons expire on 1 October 2032.

| Date | Event |
|---|---|
| Now → 1 Sep 2027 | Pre-launch campaign: waitlist, referrals, giveaway, partner programme |
| **December 2026 (planned)** | The pre-launch website goes live. First Trust Ledger entry (3.6) |
| **1 Oct 2026, or the day the waitlist goes live if later** | Giveaway entries open (in practice, at go-live) |
| April–June 2027 | Most active partner recruiting. Partner email ramps up from about April |
| July–August 2027 | Latest useful window for creator content (it must land before early access) |
| **31 Aug 2027, 23:59:59 UTC** | Giveaway entries close (decided 24 Nov 2026; the current rules still say 1 Mar 2027 until E11.8-05 publishes the new revision) |
| **1 Sep 2027** | Giveaway draw. **Early access** opens on the main platform for wave 1. First real orders. Pre-launch partner commission starts, and the post-launch partner competition opens |
| **1 Oct 2027** | **Public launch.** Main student-ambassador push in the first weeks of the academic year |
| 31 Dec 2027 | Post-launch partner competition closes |
| **1 Oct 2028** | The pre-launch 10% commission window ends (0.4) |

**Where the build stands today (25 Nov 2026):** the site is built and audited locally. The partner programme (Epic E11.7) is almost done: tickets 01–15 are merged (the `/partners` page and application, founder review, `/r/{CODE}`, retroactive attribution, the typed code, the dashboard, the leaderboard, the asset kit and welcome email, the auto-invite, the digest, the export, and the audit with founder sign-off), and 16 (partner announcements) is to do. Epic E11.8 follows, then GATE-8. **Production bring-up (Epic E12) has not started, so the site is not live yet.** Going live in December 2026 needs, in order: the production server (P6), Epic E12 through E12-07, and the four seed mailboxes (P7). Marketing that sends people to valstara.com must not start before E12-07 passes. The giveaway cannot open until the paid Resend and Brevo plans are bought (P5); Brevo's paid plan is not yet purchased.

**Public timing copy:** the site's FAQ says *"we won't promise a date we can't hold."* Say "early access in September 2027" and "public launch in October 2027". Use an exact day only where the plan can hold it, and never as a countdown.

## 0.3 What a member gets (decided 17 Nov 2026; on the site since E11.7-04)

- **Joining:** email only, with a separate, **unticked** marketing opt-in. **No country is asked.** The site says "Open to people aged 18 and over." **The founder decided on 24 Nov 2026 to open the waitlist to people aged 13 and over, with the giveaway for people aged 18 and over only**: the marketing box becomes 16 or over, a separate unticked 18+ box is needed to enter the giveaway, and a lawyer reviews the wording first (P12). It is ticket E11.8-06, not built yet. Double opt-in: **nothing counts until the address is verified.**
- **Early access (wave 1, 1 Sep 2027):**
  - the **first 1,000 verified members**, by signup order, whatever their referrals; that place is never lost;
  - after them, **any member with 3 or more confirmed, non-voided referrals**;
  - **every active partner**;
  - **everyone who signed up through an active partner's link or code.**

  Everyone else falls into waves 2–4 by verification order (≤ 5,000 → wave 2, ≤ 15,000 → wave 3, after that wave 4) and **does not get early access**. Each member's page says plainly whether they are in wave 1, and if not, how many more confirmed referrals they need.
- **The coupon ladder (members and partners):**

  | Coupon | Unlocks at | Steps (5% every 3 confirmed referrals) |
  |---|---|---|
  | 1 | 3 | 3 = 5% · 6 = 10% · 9 = 15% · 12 = 20% · 15 = 25% · 18 = 30% |
  | 2 | 21 | 21 = 5% … 36 = 30% |
  | 3 | 39 | 39 = 5% … 54 = 30% |

  - Each coupon is single-use, usable on any order, and never stacks with another discount.
  - Coupons expire **five years after public launch** (configured as 1 Oct 2032).
  - **Every coupon is held** until **one of the member's referred friends places a first order** (the anti-fraud rule, ADR-012).
  - **Every mention of a coupon must carry that condition**, for example: *"Coupon 1: 30%, usable once one of your friends places their first order."*
- **$5 store credit (non-partner members only, main platform):** $5 for each referred friend who completes a purchase after launch. Nothing for a signup alone.
- **The giveaway:** one global draw under Hong Kong law. The prize is **5 Valstara product bundles at €300 each** (€1,500). One entry on verification, plus one per confirmed referral. **No purchase, referral or marketing consent is needed.** 18+, one prize per person, and equal weight per entry. The rules live at `/giveaway/rules`.
- **What does not exist, and must never be implied:** a visible queue position, countdowns, stock counts, "spots left", founding vouchers, prepaid sales, pending credit per signup, a cash reward for members, or multi-level rewards.
- **The only scarcity line allowed**, and only while it stays true: *"Some high-demand products have limited supply. Early access members get first pick."* **Never imply the public launch will be empty.**

## 0.4 The partner programme (decided 17 Nov 2026, amended 21–22 Nov; built by Epic E11.7)

**One programme, three partner types:** `standard`, `student_ambassador` and `creator`. They share the system, the contract terms and the commission. **The type changes only the friend's welcome discount (the ambassador floor), the application fields, and reporting.**

| | All partners |
|---|---|
| **Commission: pre-launch terms** (founder, 21 Nov 2026) | **10% of order value, on all products**, for customers referred **during the pre-launch campaign** only. It counts every order those customers place **from early access (1 Sep 2027) until one year after public launch (1 Oct 2028)**. After that window, the customer is no longer attributed to the partner under these terms. Paid by the main platform. **Nothing is earned before real orders exist** |
| **After public launch** (founder, 24 Nov 2026) | This pre-launch partner programme ends, and two separate things replace it on the main platform. **Partners** (creators, influencers and community owners) get terms **agreed case by case**, by their size and what they ask for. **Affiliates** join a separate, more comprehensive **affiliate system** with the same rates for every affiliate, possibly on a ladder they climb. Customers a pre-launch partner refers after public launch fall under whichever of these the partner then has. A customer whose pre-launch window has ended can be referred again only under those terms. Neither is decided in this repository |
| **Levels** | **One only.** No commission for recruiting other partners |
| **Founding terms** | The 10% applies only to partners accepted during the pre-launch campaign, and only to the customers they referred in it. **It is not a lifetime rate lock.** **The founding rate lock lasts one year** (founder, 22 Nov 2026): orders until 1 Oct 2028. This replaced "the life of the programme" in the plan, the spec and the growth decisions |
| **Contract** | Every partner signs a short, plain-English contract, sent by the founder through **signfree.io**. Recording the signature (`contract-signed`) activates the partner: the code and `/r/{CODE}` go live and retroactive attribution runs. While `partners.enabled` is off, the signature is recorded and activation waits until it is on |
| **Own perks** | Wave 1 early access while active, and the same coupon ladder as members. **No $5 credit** (they earn commission instead) |
| **Link and code** | A code they choose (4–16 letters and digits, e.g. MAYA), checked for uniqueness and against a blocklist of brand, provider and reserved words. A **permanent** link `valstara.com/r/{CODE}` that keeps working after the main platform launches, plus server-generated QR codes (PNG and SVG) |
| **Friend's welcome discount** | First order only, single-use. **10%** while the partner has fewer than 21 confirmed referrals, **15%** from 21, **20%** from 39, fixed at the friend's signup. **Friends of a student ambassador get at least 15%.** Friends also get wave 1 early access. It expires five years after public launch |
| **Retroactive attribution** | When a member becomes a partner, everyone they already referred is attributed to them as a partner, and those friends gain the perks |
| **Dashboard** | A private emailed link (30 days; asking for a new one cancels the old). It shows **counts only**: confirmed, pending, voided, signups per week, a breakdown by survey category, the ladder, the welcome discount, the terms summary, a partners-only leaderboard (top 20 plus own rank, anonymous unless they opt in) and the asset kit. **Partners never see who they referred** |
| **Asset kit** | Message templates pre-filled with their code and link, **a print-ready flyer (A4 and US Letter) with their QR code, code and the welcome perk**, and downloadable images and PDFs (P10). Videos are plain links. **E11.7-11 ships without the files** (founder, 24 Nov 2026); the downloads section stays hidden until the founder adds them as a content change |
| **Emails** | A confirmation link on applying (confirming it also joins the waitlist and enters the giveaway, E11.7-05); application received; approved; rejected (only when the founder chooses to send it); **welcome** with the dashboard link, code, link, asset kit and a 3-step checklist (get your code → share once → see your first confirmed signup); first confirmed signup; and a monthly digest with one founder note (off until the founder turns it on; it can switch to weekly from April 2027). **The welcome is sent once the dashboard (E11.7-09) and the asset kit (E11.7-11) are live**, without waiting for the P10 files; partners activated earlier get it then, by catch-up (D-057). **There is no partner broadcast list:** the quarterly CSV import into Brevo was retired and the dedicated Brevo partner sync deferred (E11.7-06, D-056), so the digest's founder note is today the only channel to every partner at once. **Partner announcements** to every partner at once are ticket E11.7-16 (founder, 25 Nov 2026), on the digest's audience and opt-out |
| **Auto-invite** | A member who reaches **10 confirmed referrals** gets one invitation to apply, **only if they opted in to marketing** |
| **Who decides** | **The founder reviews every application by hand**, approves (and may edit the code), rejects, pauses, terminates and voids any single referral with a reason. Every action is audited |

**What the programme deliberately does not do before launch:** calculate commission or earnings, pay out, take payout or tax details, track orders, offer sub-IDs, deep links, UTM builders or click analytics, or run pre-launch partner competitions (dropped: signups are too easy to fake).

**A post-launch partner competition** runs on the main platform from **1 September 2027 (early access) to 31 December 2027** (founder, 21 Nov 2026). It is ranked on real referred order value after refunds, with prizes for the top 3 and a bonus for everyone who passes a set amount. **Announce it before launch so it motivates partners now.** Its prizes, bonus threshold, written rules and announcement date are a to-do item, settled when that task is worked on (founder, 24 Nov 2026).

**Positioning lines (founder, 21–22 Nov 2026; recorded in the plan for E11.7-05).** Compare only with **GameSeal, G2A and Eneba**:

- **Lead line:** *"More than triple GameSeal's commission rate."*
- **Second line:** *"Double the rate of G2A and Eneba."*

They replace "about double what the big marketplaces pay". Use them **only during the pre-launch campaign**, because post-launch terms will be different. Every use is scoped, dated and sourced.

| Competitor | Rate found (checked 21 Nov 2026) | Valstara's 10% is | Evidence |
|---|---|---|---|
| **GameSeal** | 2.4% on sales (FlexOffers) · 3% base, "top publishers are eligible for bonus deals" (Webgains). The founder's figure is 2–3% for subscriptions | **More than triple** the base rate (10 ÷ 3 = 3.3×) | Affiliate-network listings, not GameSeal's own terms page |
| **G2A Goldmine** | 5% per sale (several listings; an older Awin US figure says 4%) | **Double** (not "more than double") | Third-party listings; no 2026-dated official page found |
| **Eneba** | 2–5% revenue share for standard affiliates (Eneba's own affiliate page) | **Double to five times** | Eneba's affiliate page |

Rules for using the line:

1. **Say "commission rate", not "earnings".** Ten percent is a rate. What a partner earns depends on what their audience buys, and "triple the earnings" is not provable.
2. **Compare with the base or standard rate, and say so.** GameSeal offers bonus deals to top publishers, so an unqualified "more than triple" could be false for some of its affiliates.
3. **State our window beside the comparison.** Ours is 10% for a fixed window (until 1 Oct 2028); competitors' rates run on with no end date. Leaving that out would mislead.
4. **Capture dated evidence before first use, and re-check it each quarter.** Screenshots of each programme's current terms (ideally the official pages, not network listings), with the date.

## 0.5 Student ambassadors and creators (locked 17 Nov 2026)

**Student ambassadors** are `student_ambassador` partners on the standard partner terms. They promote on campus and in student WhatsApp, Discord, Telegram and Facebook groups, with their own code, link and QR flyers. Their friends get **at least 15%** off a first order, a little extra because they are students. The application requires the name of their university or college, and a student email is optional.

- **There are no other ambassador-specific rules** (founder, 21 Nov 2026). The 15% floor and the university field are the only differences from other partners.
- **Ambassadors choose their own methods** (founder, 21 Nov 2026). Valstara provides the kit, guidance, tips and methods. **Valstara does not run, pay for or staff stalls, printing or events.** If an ambassador wants a stall or 10,000 flyers, that is their choice and their cost, within the law, campus rules and our partner rules.
- **Lead with products that have no student plan or a weak one** (AI tools, Netflix and similar). Spotify Student and similar plans are often cheaper than Valstara's price.
- **Timing:** recruit now. The main push is the public launch, in the first weeks of the academic year.

**Creators** are `creator` partners. They are recruited directly and signed now.

- **Target small and mid-size creators.** No upfront fee.
- **The offer:** a free subscription (3, 6 or 12 months, depending on the product) to review honestly. For example, YouTube Premium for 12 months costs Valstara about $50–60, while the creator sees about $160–180 of retail value.
- **The contract:** the creator posts an honest review video. Valstara may reuse it on its own Instagram and TikTok for **12 months**. The creator becomes a partner as soon as the contract is signed, with their own link and code.
- **Content should land before early access (1 Sep 2027);** July–August is the latest useful window.

## 0.6 SubSlush

**SubSlush is completely separate from Valstara** (founder, 1 Oct and 17 Nov 2026). No SubSlush name, address, lineage or "formerly" story appears on the site or in any public Valstara content. There is no SubSlush email track. The SubSlush list is never imported into Resend or Brevo. The only shared thing is the company, 3NITY Digital Limited.

- **The one SubSlush announcement (founder, 21 Nov 2026).** The founder sends it by hand **from SubSlush's own marketing email**, as a normal SubSlush announcement. It says:
  - SubSlush is rebranding and will become Valstara;
  - readers can pre-register for Valstara (and its rewards) at valstara.com;
  - SubSlush stays online and active until Valstara launches.

  Nothing about it is connected to Valstara's systems. **The SubSlush list stays at SubSlush and is never copied** to Valstara. A recipient joins Valstara's list only by signing up through the normal double opt-in. This satisfies ADR-028 and the 17 Nov "no shared emails" decision. **[Recommendation]** Describe Valstara's rewards only in the site's own words (wave 1, the coupon condition) and link to the site rather than restating them, so the email can never contradict the site.
- **Private credentials in 1:1 negotiation (founder, 21 Nov 2026; accepted):** when a creator or partner doubts that Valstara will pay or deliver, the founder may say privately that the same company has run a similar store before, and show that store's Trustpilot reviews. **Only in 1:1 conversation**, never in a template, post or flyer. Write it so you would be comfortable seeing it screenshotted, because a private message can become public. Trustpilot reviews do not transfer between domains, so Valstara's own profile starts empty.

## 0.7 Privacy and measurement constraints (built, CI-enforced)

- **The site has no consent banner because it sets nothing that needs one.** No GA4, no Meta or TikTok pixel, no advertising cookie, no fingerprinting and no third-party script except Cloudflare Turnstile on forms. **These are permanently out of scope for the pre-launch site.** GA4 and a consent platform return at store launch.
  - **Consequence: there is no retargeting audience built from site visitors before launch.** Warm audiences can only be the platforms' own engagement audiences (video viewers, profile engagers) or email.
- **Analytics:** self-hosted, cookieless Umami page views (estimates: ad blockers lose some) and server-side funnel events. **No Cloudflare Web Analytics** (founder, 25 Nov 2026: its beacon is a third-party request) (`signup_submitted`, `verified`, `referral_confirmed`, `survey_completed`, `giveaway_entered`, `unsubscribed`).
  - UTM parameters are captured server-side and stored per subscriber.
  - **Events carry only a source bucket** (direct, referral, email, social, paid, organic, other), never the raw `utm_source`. **No built report breaks signups down by platform or campaign today.** The analytics can say "120 signups came from social", but not "80 from TikTok and 40 from Instagram". Per-platform comparison comes from platform link clicks plus Umami's referrer origins (page views, not signups).
  - **Decided (founder, 22 Nov 2026): a per-platform signup report, as detailed as possible.** TikTok, Instagram, YouTube, X, Reddit, Telegram, Discord, LinkedIn, Facebook, Threads, email and each campaign are shown separately, never grouped as "social".
  - **What it would show:** founder-only aggregate counts per source, medium and campaign, of signups, verifications, confirmed referrals and survey completions. It reads the UTM values already stored on each subscriber (kept 12 months, analytics-only). No analytics event changes, nothing new is collected, and nothing changes on the page.
  - **In the plan (founder-authorised 2026-11-24): ticket E11.8-02**, with the convention list as `config/utm-convention.json`.
  - **What it can and cannot see:**
    - It sees every visit that arrived on a link carrying our UTMs, so every link we control must follow the UTM convention in 3.1.
    - Someone who watches a TikTok and then types valstara.com shows as `direct`.
    - A partner's or member's link is attributed by its code, and reported per partner, not per platform.
- **Referral attribution** is server-side and signed. There is no referral cookie, **one referrer per signup is fixed at signup**, and a typed code beats the link. A partner's link or code is their attribution, so partners need no UTMs.
- **Fraud controls flag; humans decide.** They are email normalisation, the disposable-domain blocklist and MX check, self-referral and duplicate-identity flags, and velocity flags on truncated, hashed IP prefixes. VPNs are not blocked and nothing auto-bans.
- **Email:**
  - Transactional mail goes through Resend on `send.valstara.com`; broadcasts go through Brevo on `mail.valstara.com`. SPF, DKIM and DMARC are live.
  - **Marketing goes only to verified members who opted in**, re-checked at dispatch. The weekly update goes out on Tuesday at 09:00 UTC and includes the top-10 leaderboard. The single launch-access notification goes to every verified member, as a service message with no promotion in it.
  - Open and click tracking are **disabled**. There are no pixels and no rewritten links.
- **Legal posture:**
  - The founder waived lawyer review of the draft `/privacy` and `/terms` and of the Turnstile storage basis (ADR-030). **On 25 Nov 2026 the founder widened the lawyer's review (P12) to read the whole of both pages with the age change.** It gates switching 13+ on (E11.8-07, after E12), never development or launch.
  - The giveaway runs under Hong Kong law, and the residual foreign promotion-law risk is accepted (ADR-026). Belgium prohibits free chance draws; Portugal, Italy, Spain and Poland require authorisation or charge taxes.
  - **Advertising-disclosure law (FTC, ASA/CAP, EU UCPD) is not waived by anything above and binds every partner and creator.**

## 0.8 Pages the marketing can point at (built)

- `/` — the waitlist. `/#join` — the form.
- `/legit`, `/guarantee`, `/about` — the trust pages, at their permanent URLs.
- `/giveaway/rules` — the giveaway rules.
- `/leaderboard` — public top 10, anonymous handles, exact counts. It can be switched off without a deploy.
- **`/prices`, `/prices/{service}/{country}`, the service and market hubs, `/price-index` and `/price-index/{YYYY-MM}`** — official list prices for **19 tracked services across 20 markets** (UK, DE, ES, FR, IT, PL, RO, SE, NO, DK, FI, CH, NL, HR, IE, AT, PT, CA, US, AU), in local currency, refreshed by hand monthly. The first run was November 2026. Valstara's own price is **not** shown until the founder turns it on, after a phone layout for the comparison is built.
- `/partners` (the programme page, with the 22 Nov terms and the GameSeal, G2A and Eneba lines word for word) and `/partners/apply` (E11.7-05), `/r/{CODE}` (E11.7-07) and the "Have a referral code?" toggle in the hero form (E11.7-08) are **built and merged**. The partner dashboard (E11.7-09), the partner leaderboard (E11.7-10) and the asset kit with the print flyer (E11.7-11) are **not built yet**.
- Per-page social cards (1200×630) and `llms.txt` exist.

## 0.9 Budget

**$5,000 in total. The founder sets the split** (founder, 21 Nov 2026). The principles in Part 8.1 are accepted. **No new paid service on the site without founder approval.**

---

# PART 1 — STRATEGY

1. **Trust is the wedge; price is the reason to care.** The site leads with *"Digital goods you know are real"* and follows with *"Premium digital goods, for less."* Keep that order everywhere. **Never lead with "up to 80% off".** In this category a deep discount raises perceived risk until the buyer has a reason to trust it. That is the reports' unanimous finding, and the site has been designed around it.
2. **The competitive message is direct-seller accountability.** One seller, one checkout, one support team, one guarantee, and no anonymous marketplace seller to chase. **Attack uncertainty, not competitors.** *"You should know who is responsible before you pay. Every order on Valstara is sold and guaranteed by Valstara."*
3. **Valstara is a new brand, publicly.** No SubSlush story (0.6).
4. **The pre-launch campaign has one job: verified, category-qualified members who will buy at early access (1 Sep 2027) and public launch (1 Oct 2027).** Its engines are:
   - the referral loop (wave 1 and the coupon ladder);
   - partners, meaning creators, student ambassadors and community owners;
   - the price index, its pages and its monthly report;
   - organic content.

   **The giveaway is a referral accelerator with a fixed end** (entries close 31 Aug 2027, once E11.8-05 publishes the new rules revision), not the proposition.
5. **The growth engine (locked):** the Trust Ledger and building in public, the monthly price index, the programmatic price pages, and the overpay calculator. The *Trust Ledger* was defined by the founder on 22 Nov 2026 (Part 3.6). The overpay calculator is later scope, outside this repository, and reads the same price data.
6. **Honesty is the marketing.** Real counts, held coupons said to be held, no countdowns, no scarcity beyond the one approved line, no fake testimonials and no astroturfing. For a suspicious buyer, each of these is a tell that sends them away, and one discovered lie undoes the brand.
7. **A two-person team owns few channels deeply.** Secure every handle, run two or three channels properly, and let the rest carry repurposed content (Part 3).

---

# PART 2 — THE REFERRAL LOOP AND THE MEMBER JOURNEY

## 2.1 What the journey is (built)

1. **Land** — from social, search, a partner's `/r/{CODE}`, or a member's `?ref=` link.
2. **Join** — email only, the unticked marketing box, a collapsed "Have a referral code?" field (a typed code beats the link's), "No purchase necessary" beside the CTA while the giveaway is open, and an invisible Turnstile check.
3. **Verify** — one link, then reminders at +1h, +24h and +72h. An unverified signup expires.
4. **Success page** — the access wave, a partner-referred person's perks ("You joined through MAYA: early access from September 2027 and 15% off your first order"), the referral link with copy and share, and a two-question survey: categories (multi-select: AI tools, Streaming and subscriptions, Software, Gift cards, Game keys, Game top-ups, In-game currency) and buying frequency. Skipping is fine and never nagged.
5. **Welcome email** — referral link, status link and trust-page link.
6. **`/me`** — status, wave, own rank, confirmed referrals, ladder progress, giveaway entries, the marketing switch, the survey re-answer and data rights.
7. **Weekly update** — only for those who opted in to marketing.

## 2.2 How to market the loop

- **Say what each referral is worth, in the site's own words.** Lead with early access: *"3 confirmed referrals and you get early access."* Then mention the coupon ladder, always with its first-order condition. **Never quote a coupon without saying it is held until a referred friend's first order.**
- **For the first 1,000 the pitch is simply "join early"** (founder, 21 Nov 2026). It is an honest, real advantage, and the count is real. For example: *"Pre-register free, no card needed. The first 1,000 verified members get early access before everyone else."* **There is never a running count of places left.** That reads as a countdown and conflicts with ADR-024. "The first 1,000 verified members get early access" is a rule; "312 places left" is a scarcity device.
  - **"No card needed" is accurate:** the signup asks for an email only.
  - **Say "a month before everyone else" or "before public launch", not "2 months before everyone else".** Early access on 1 Sep 2027 and public launch on 1 Oct 2027 are one month apart.
- **Referral reminders work** (founder, 21 Nov 2026: adopted). Field research (Journal of Marketing Research, 2025) found that merely reminding referred customers they had joined through a referral raised their own referral likelihood. Tell referred members that a friend brought them in.
  - **Where it can go today:** the verification success page already names the partner for a partner-referred person. **The weekly update cannot carry it:** E11.7-04's founder decision (D-048) keeps the weekly free of per-recipient lines (its payload is only the snapshot and a status token), and "a friend brought you here" is true only for some recipients. **Decided (founder, 24 Nov 2026):** both. A line in the welcome email for every member referred by another member, naming no one (ticket E11.8-04), and the storefront's day-7 email after launch (9.2, step 3).
- **Survey completion is the leading quality signal.** Target 35%+ of verified members (a report benchmark, not our data). The category answers decide which products and stories lead each launch email.

## 2.3 Benchmarks to beat (report benchmarks; replace them with our own medians after 4–6 weeks)

| Metric | Starting target |
|---|---|
| Visitor → verified member | 20–35% of landing visitors (an **estimate**, because the view count loses ad-blocked visits) |
| Signup → verified | Watch per mailbox provider (built monitoring) |
| Survey completion | 35%+ of verified members |
| Members who share | 15–25% of verified members |
| Confirmed referrals per active referrer | Track as a ratio |
| % of members choosing a launch category | The waitlist-quality indicator |
| Cost per verified, category-qualified member | The only acquisition cost that matters pre-launch |

---

# PART 3 — OWNED SOCIAL CHANNELS AND CONTENT

## 3.1 Channels

**Decided (founder, 21 Nov 2026):** secure the handle **"valstara"** everywhere now: Instagram, TikTok, YouTube, X, Reddit, Discord, Telegram, Facebook, LinkedIn, Threads and Trustpilot (Trustpilot is already claimed and linked). Then run them at three depths:

| Depth | Channels | Why |
|---|---|---|
| **Primary: daily** | **TikTok, Instagram (Reels and carousels), YouTube Shorts.** One vertical video, cut once, posted natively to each | Short-form discovery for the 18–35 subscription buyer. One production unit serves three platforms |
| **Secondary: several times a week** | **X** (price changes, building in public, founder voice), **Reddit** (two disclosed accounts, Part 6), and **LinkedIn** (founder account: building in public, partner recruiting, the monthly price report for journalists) | Text, trust and press reach |
| **Owned community: start small** | A **Telegram channel** and a **Discord server** | See 3.5 |
| **Long-form YouTube** | Monthly at most until there is capacity | Comparisons and the "Red flags" series age well and earn search traffic |

**The UTM convention** (needed for the per-platform report, 0.7). Every link we control (bios, posts, Telegram, Discord, emails, PR) carries:

- `utm_source`: the platform, from a fixed list, lowercase: `tiktok`, `instagram`, `youtube`, `x`, `reddit`, `telegram`, `discord`, `linkedin`, `facebook`, `threads`, `newsletter`, `press`;
- `utm_medium`: `social`, `email`, `referral` or `paid`, matching the site's source buckets;
- `utm_campaign`: a short, dated name, e.g. `bio`, `price-index-2026-12`, `trust-ledger-2026-12`.

Keep the list in one shared sheet, and never improvise a spelling: "TikTok" and "tiktok" would count separately. Partner links (`/r/{CODE}`) need no UTMs.

**Platform risk insurance (from the reports):** naming brands such as Netflix or ChatGPT is generally tolerated as nominative use, but **never imply affiliation**. Discount-led promotional content can trigger reach limits. **Decided (founder, 21 Nov 2026):** keep a compliant backup account warm on TikTok and on Instagram, each on its own device. Do not rapid-switch accounts in the app. A backup account is never used to comment on, like or praise the main account; that is a sockpuppet.

## 3.2 What to post: value first, the campaign second

Nobody follows an account that advertises a waitlist ten times a day.

**The starting ratio (founder, 21 Nov 2026): four useful posts, then one campaign post.** The useful posts are worth watching whether or not the viewer ever joins. **This is a starting hypothesis, not a finding.**

**The task stays partly done until real data replaces the hypothesis.** Review the ratio against our own retention and signup numbers after 20 posts per format (Part 8.3), then again at about 30 and 50. Keep reviewing for as long as the campaign runs. Each review records the data and the ratio it chose, in Part 11.3.

**The content pillars** (all three reports converge on them):

1. **Price intelligence**, fed by our own price index: what a service costs in each of our 20 markets, what changed this month, and annualised subscription maths. Every figure is sourced, dated and in local currency.
2. **Trust education:** how to tell a real digital-goods seller from a scam. The **"Cheap subscription red flags"** series is the strongest franchise. Each episode ends *"Whatever store you use, check this before paying."*
3. **Comparison and decisions:** which plan or tool is right for whom, including "Same task, different AI". **Never rig a result towards what Valstara will stock.**
4. **Building in public and operational proof:** the founder, the build, the guarantee, what happens after an order (from early access), and later the Trust Ledger.
5. **Campaign posts:** the giveaway (with the rules link and the platform disclaimer, 3.4), early access and wave 1, the partner programme, and real milestones. Use real counts only, labelled if rounded.

**Recurring formats:**

- **Price Map:** product, official plan, monthly equivalent, who it suits. Inherently saveable.
- **What Changed This Month:** from the monthly price report.
- **What Changed Today:** a product or price change, **published only after confirming it on the provider's official page**.
- **Subscription Math.**
- **Same Task, Different AI.**
- **Red Flags.**

**Sourcing routine:**

- TikTok Creative Center and Google Trends;
- Reddit questions (take the *language* people use, not the posts);
- provider pricing and release-notes pages;
- our own monthly price report;
- the survey answers;
- the support inbox.

**Verify every price and product-news claim against the provider's official source before publishing.**

**Do not publish:**

- watermarked reposts;
- savings screenshots without a date, source, country, term and eligibility;
- "guaranteed cheapest";
- "lifetime" for anything that is not;
- fake testimonials, fake urgency or fake scarcity;
- anything implying a provider endorses us;
- any product not on the P8 list presented as "coming to Valstara".

**Algorithm notes (reports, to re-verify each quarter):**

- Hook in the first 1–3 seconds.
- Optimise for retention and completion, not likes.
- Recommendation-eligible Instagram Reels run 3 minutes or less. **Our cap is 3 minutes** (founder, 21 Nov 2026); most Reels will be far shorter.
- Put keywords in the profile and captions.
- Reposted or watermarked material loses reach.

## 3.3 Campaign posts: what they may say

| Allowed | Not allowed |
|---|---|
| "Join the waitlist" and "Join free" | "Spots are filling up", "Only X left", countdowns |
| "The first 1,000 verified members get early access before public launch" | A live "places left" counter |
| "3 confirmed referrals and you get early access" | "Refer 3 and get 15% off" (retired reward) |
| "Coupons up to 30%, usable once one of your friends places their first order" | A coupon figure without the condition |
| "Delivered within 24 hours, Monday to Friday" | "Instant", "immediate" |
| "Below list price" | "Up to 80% off", "cheapest", "unbeatable" |
| "Win one of 5 Valstara bundles worth €300 each. No purchase necessary. 18+. Rules: valstara.com/giveaway/rules" | A giveaway claim that differs from the rules page |
| "Some high-demand products have limited supply. Early access members get first pick." | Any implication that public launch will be empty |

## 3.4 Social giveaways

The prize draw runs **on the site, under its published rules**.

**Decided (founder, 21 Nov 2026):** no separate tag-to-enter or follow-to-enter giveaways on Instagram or TikTok during the campaign. Each would need its own rules, would carry the per-country promotion-law exposure the global draw was designed to limit, and attracts sweepstakes hunters who never buy. When a social post promotes the site's giveaway, it states that **the promotion is not sponsored, endorsed or administered by Instagram, Meta or TikTok**, and links to the rules.

**Task: research each platform's own rules before the first giveaway post** (founder, 21 Nov 2026). A disclaimer is not the whole answer. Each platform has its own rules for posts that promote or mention a giveaway, **even one run off-platform on our own site**: what must be stated, whether linking out is allowed, how branded content must be labelled, and whether a promotion needs the platform's approval or a paid-partnership label. Before any post or partner template mentions the giveaway, check and record for each platform:

- Instagram and Facebook (Meta's promotion guidelines);
- TikTok;
- YouTube;
- X;
- Reddit, per subreddit;
- Discord;
- Telegram.

Record the date and the source for each. The partner kit's giveaway wording must follow the strictest of them.

## 3.5 Telegram and Discord

- **Telegram: a broadcast-only channel** (founder, 21 Nov 2026). Only Valstara posts; there is no member discussion. It suits price-change alerts, the monthly report and building-in-public notes, and it costs nothing.
- **Discord: open it small, with a narrow purpose** (founder, 21 Nov 2026: accepted). For example: announcements, price changes, a feedback channel, and a separate partners channel for active partners (useful for kit updates and questions). **Open general chat only once the posting cadence is steady and someone can moderate daily.** A small, high-trust server beats a large, dead or spam-filled one. The reports' post-launch structure (`#deals-alerts`, `#price-drops`, `#support`, `#vault-help`, roles by purchase tier, member-exclusive drops) applies from early access.
- **Brand rules (guidelines §8.2):** a named support presence with stated response times, no hype posting, no spam drops, and no @everyone for promotions.
- **Support response time and moderation (founder, 24 Nov 2026).** The founder moderates Discord. The stated response time, for Discord and every other channel, is: *"We aim to answer every message within 24–48 hours. It can take up to 7 days when a question needs investigation or we're handling a high volume."* Keep the wording identical everywhere it appears.
- **Privacy:** these are third-party platforms. The site never embeds them, and joining one is never a condition of anything.

## 3.6 The Trust Ledger (defined by the founder, 22 Nov 2026)

**What it is.** A public, monthly record of how Valstara is actually doing on the things buyers worry about: delivery, problems, refunds, suppliers and payouts.

- **Bad numbers are published alongside good ones,** with the same definitions every month.
- **Nothing is quietly edited afterwards.** A mistake gets a dated correction note in the next entry.
- **It is a single page on the site** (for example `/trust-ledger`). A new entry is added each month, and every past month stays visible.

**Founder decisions:**

1. The name is **"Trust Ledger"**. It follows the brand's plain-English programme names, like the Triple Guarantee (identity guidelines §3.3).
4. **No supplier register is published** (founder, 24 Nov 2026). Valstara may use several suppliers for the same product and switches between them in the background. The Ledger shows supplier counts only. "The Supplier Register" has been removed from the brand guidelines.
2. **Operations numbers only. No revenue figures.**
3. **The first entry (Phase 1) is published in December 2026,** when the pre-launch website goes live.

**Why it fits Valstara:**

- **It is the trust promise, shown with proof.** Anyone can say "we're the accountable ones". Publishing the refund count every month shows it, and a marketplace cannot easily copy it.
- **It answers what this category is criticised for.** The founder's research found the category's reputation was damaged by secrecy, slow dispute handling and undisclosed paid promotion (the G2A controversies of 2016 and 2019). The Ledger is the opposite of each.
- **It gives partners something to point to.** A partner puts their own reputation on the line. *"Here are Valstara's real numbers, refunds included"* is their best answer to "is this legit?"
- **It is ready-made content every month.** One entry feeds the partner digest's founder note, a building-in-public post and the founder note in the weekly update (E11.8-03).

### Phase 1: pre-launch (December 2026 → September 2027)

There are no orders yet, so it reports progress and readiness:

| Section | What it shows |
|---|---|
| Waitlist | Confirmed members (total and new this month), and the share that came through referrals |
| Build progress | What shipped this month and what's next, as plain checklist items, e.g. "Order vault: done" |
| Supply readiness | Suppliers evaluated, verified and rejected, and how many launch products have verified supply |
| Partner programme | Applications received, partners approved and active |
| Policy changes | Anything published or changed (guarantee terms, partner terms), with a date |
| Corrections | Mistakes made and fixed, e.g. a wrong price on a price-index page |
| Launch status | "On track for early access in September 2027", or an honest note if it moves and why. A status, never a countdown |

### Phase 2: from early access (1 September 2027 →)

It starts reporting real operations, with **fixed definitions that are never changed silently**:

| Metric | Definition |
|---|---|
| Orders delivered | Orders completed in the month |
| Delivery time | Median delivery time, the % delivered within 24 hours (Monday to Friday, as the guarantee states it), and the slowest delivery of the month |
| Guarantee claims | Claims opened, then how they ended: resolved, replaced or refunded, in the guarantee's order |
| Time to resolve | Median time from claim to fix |
| Refunds | Number, and % of orders |
| Out-of-stock events | Which products ran out and for how long. This backs up the honest scarcity wording |
| Supplier incidents | E.g. "a batch of 14 accounts stopped working; all replaced within X hours; supplier paused" |
| Reviews | Trustpilot rating and review count, including how many negative reviews were replied to |
| Partner payouts | Total commission paid, number of partners paid, and whether every payout was on time |
| Support response | Median first-response time |

**Every entry ends with three short sections:** *What went wrong*, *What we changed*, and *Focus for next month*.

**What it never includes:**

- customer personal data (totals only);
- supplier names or supplier prices, which are commercially sensitive and would expose our sources;
- individual partners' earnings, unless the partner agrees;
- margins, profit or revenue (decision 2);
- vanity numbers without context: "10,000 signups" means little without "of which 7,800 confirmed".

**Rules that make it credible:**

- **The same definitions every month,** kept in a fixed "How we count" section. A changed definition is announced in that month's entry.
- **Publish bad months.** A month with refunds and a supplier failure, explained honestly, builds more trust than a record that looks too good to be true.
- **Never edit past entries.** Corrections go in the next entry, dated.
- **Small numbers are fine.** "We delivered 212 orders and refunded 2" sounds real. Present early numbers as "we're new; here's every order", not as scale.
- **Plain brand voice:** sentence case, no exclamation marks, no spin. The copy rules and the forbidden-copy scan apply.

**Format.** One URL, with the newest month at the top, a full archive below, and the "How we count" section. Each month is one small data file, and the site builds the page from those files. The waitlist count can be read from the database automatically. On the code side, it is a small static page, a few hours of work.

**In the plan (founder-authorised 2026-11-24): ticket E11.8-01**, in the new Epic E11.8, after E11.7-15 and before GATE-8 and E12, so it is live before the December go-live. The spec is `docs/features/trust-ledger.md`. In short:

- one validated data file per month; a published entry can never change (CI-enforced);
- a founder command drafts the month's waitlist figures from the database;
- the flag `trust_ledger.page` is off until the first entry is merged;
- links from `/guarantee`, `/partners` and the footer;
- `/trust-ledger` is a permanent URL the storefront keeps.

**It waits on P11:** the "How we count" text, the first entry's founder sections (with the definitions of an evaluated, verified and rejected supplier) and the `/guarantee` link line.

**The founder's monthly work:** about 1–2 hours to fill in the numbers and write the three short sections.

**Distribution:**

- links from the guarantee page, `/partners` and the site footer;
- a summary in the partner digest's founder note, and as the founder note in the weekly update to consented members (E11.8-03, decided 24 Nov 2026; until it ships, the weekly update carries no editorial content);
- one building-in-public post per month.

**Risks:**

- **A bad month is public.** That is the point, and the commitment is real.
- **Competitors can read it.** With supplier details and margins kept out, there is little they can use.
- **It only works if it keeps going.** Skipping months looks worse than never starting; a shorter entry beats a missing one.

---

# PART 4 — CREATORS

## 4.1 The offer (locked)

- Small and mid-size creators, **no upfront fee**.
- A **free subscription for 3, 6 or 12 months**, chosen per creator and product by the founder, case by case.
- An **honest review video** in return. Valstara may reuse it on its own Instagram and TikTok for 12 months.
- The creator becomes a **partner** at once (`creator` type): their own code and link, the pre-launch 10% commission (0.4) on referred customers' orders from early access until 1 Oct 2028, and friends get the welcome discount and wave 1.
- **The brief is to demonstrate and give an honest opinion, not to praise the brand.** After early access, the strongest content shows a real checkout, the real delivery time, real activation and real support.
- **The 12-month reuse right needs the original file.** Part 3.2 rules out watermarked reposts, which lose reach, so the creator contract should require delivery of the original video without platform watermarks, a licence to repost it natively on Valstara's Instagram and TikTok for 12 months, and the disclosure kept on every reuse.
- **To-do (11.4): how a review subscription reaches a creator before the store exists,** and what the review can show. It goes hand in hand with the asset kit files. Before early access there is no Valstara checkout or order, so a pre-launch review can cover the product and Valstara's delivery and support, but not the buying experience.

## 4.2 Who to target

- **Many small creators over one large one.** The reports measured nano-creator engagement at 2–3× micro (up to ~11.9% on TikTok), and expect a minority of creators to drive most results.
- **Audiences that buy digital goods, in any niche** (brand guidelines §10.3): AI and productivity, students and study tools, streaming and entertainment, software and design, tech deals, personal finance and "save money" creators, and gaming for in-game currency.
- **Never associate with** gambling, casino, skin-gambling or case-opening, nicotine, alcohol, or adult content (guidelines §10.1).
- **Prefer creators whose audience is mostly in our 20 price-index markets and over 18.** Do not rule out creators with younger audiences (founder, 21 Nov 2026). Many of our products are used by teenagers (Netflix and Spotify, for example), and in-game currency such as Roblox's Robux is being considered. Teenagers are future customers even though they cannot enter the giveaway.
  - **Decided (founder, 24 Nov 2026): the waitlist opens to people aged 13 and over; the giveaway stays 18 and over, and says so plainly.** It is ticket E11.8-06, behind `waitlist.age_13`. Until it ships, the site still says "Open to people aged 18 and over", and no campaign may invite under-18s to join. The three conditions the founder accepted:
    - **Marketing email is for people aged 16 or over**, and the box says so. The age for marketing consent without a parent's authorisation is 13 to 16 depending on the country (GDPR Article 8; for example 16 in Germany, Ireland, the Netherlands and Poland, and 13 in the UK, Sweden and Denmark), and the site collects neither age nor country.
    - **Giveaway entry needs a separate, unticked "I'm 18 or over, enter me in the giveaway" box.** Without it, a member holds no entries, so `/me` never shows a 15-year-old entries they could not win. A member who skips it, or turns 18 during the campaign, can tick it later on `/me` (founder, 24 Nov 2026).
    - **A lawyer reviews the age change, together with the whole privacy notice and terms (P12), before 13+ is switched on.** It does not hold up development or the 18+ launch: E11.8-06 builds the mechanics behind a flag that stays off, and E11.8-07 applies the reviewed wording after E12. Inviting under-18s brings in the UK Age Appropriate Design Code, and ADR-030's waiver of legal review does not cover "a material change to this scope".
  - **For creators with teen audiences, after E11.8-06 ships:** say "join the waitlist" to everyone, and say the giveaway is for 18 and over in the same breath. Never "join and win" to a teen audience.
    - Partner applicants stay 18 or over.
    - Advertising to minors is restricted in the UK, the EU and the US (COPPA for under-13s), and so is content placed in children's media.
    - **Roblox (Robux) is not on the P8 launch provider list.** It cannot be shown or promised as "coming" until it is added there.
- **Measure creators** on confirmed signups through their code, the survey categories of those signups, and reusable content. Never on follower count. After launch, measure on first orders.

## 4.3 Outreach stance

**We put an offer on the table, on our terms. The terms are fair, and we do not chase.** There are thousands of suitable creators; no single one is critical.

- **First message: short, specific, human.** Three to five sentences:
  - who we are (one line);
  - why *them* (one specific thing about their content);
  - the offer in one sentence;
  - an easy next step ("happy to send details if it's of interest").

  No wall of text, no hype, no countdown, no "exclusive opportunity", no income claims. Never use *passive income*, *unlimited*, *financial freedom*, *team* or *downline*.
- **One polite follow-up after about a week, then stop** (founder, 21 Nov 2026). Silence is an answer.
- **Give them time.** No deadline pressure. The pre-launch terms are open to anyone accepted during the campaign, so there is no false urgency to use, and we do not invent any. **[Recommendation]** It is true that customers referred after public launch fall under post-launch terms. Say so plainly when asked, never as a pressure line.
- **A "no" is accepted at once,** with thanks and no counter-offer, leaving the door open.

### 4.3a Personal video outreach (Loom)

**Decided in principle (founder, 21 Nov 2026).** A short personal video makes us visibly real: the founder's face in the corner, screen shared, explaining the offer. A suspicious creator wants exactly that proof.

- **Structure:** a 1–2 minute personal opening, recorded per person (their name, why them, one specific thing about their content), joined to a reusable segment on the offer and how it works. Keep the whole video short; the personal part carries it.
- **Where to send a link:**
  - **in a first message:** email, Discord, Telegram and WhatsApp, where links in direct messages are normal;
  - **on X, Instagram, TikTok and Reddit:** no link in the first messages. Links in cold direct messages can trigger the platforms' spam systems. Send the video link only after a few real messages back and forth, if the conversation hasn't already moved to email or another chat app.
- **[Open] Platform research:** check each platform's current direct-message and link rules before the outreach starts, and record them beside the giveaway rules (3.4).
- **Evidence: not verified.** The higher response rate comes from an anecdote, not data we have checked. Treat it as a hypothesis. Track reply and acceptance rates for messages with and without a video, per channel, and keep the approach only if our own numbers support it.
- **Tooling:** check Loom's current plan limits before relying on its free tier, because recording length and video count are capped on free plans. An unlisted YouTube video is a no-cost alternative for the reusable segment.

## 4.4 Objections and how to answer them

| They say | The answer (in substance) |
|---|---|
| "What's your rate?" / "I charge $X per post" | We don't pay upfront fees. What we offer is the subscription to review, honest content on your terms, and a partner code that earns 10% of what the customers you refer during pre-launch buy, from early access until one year after public launch. That is more than triple GameSeal's base commission rate. If that doesn't fit, no problem |
| "Can I get paid now for the signups I bring?" | Commission comes from real orders, and orders start with early access. Before then there is nothing to pay commission on, so there is no early payout. Your signups are recorded from day one and carried to the main platform |
| "Can you raise the rate / give me a special rate?" | The pre-launch 10% is the same for every partner. We keep one rate so it stays fair. The variable part is the review product and term, which the founder decides per creator |
| "What happens after launch?" | Customers you referred during pre-launch keep earning you 10% until one year after public launch. Customers you refer after launch fall under post-launch terms: for partners these are agreed case by case, and there will also be a separate affiliate programme |
| "Is this legit? Will I actually get paid?" | Name the company (3NITY Digital Limited, Hong Kong, registration number), the founder by name, and the trust pages. Explain that there is a signed, plain-English contract they can read in their own time and show a lawyer if they like. Privately, the founder may mention the earlier store and its Trustpilot reviews (0.6) |
| "Is this a pyramid scheme / MLM?" | No. One level only: no one earns anything for recruiting other partners. Commission comes only from customers' own purchases |
| A small creator expects cash on top | Thank them, restate the offer plainly, and say it is the offer. Each case is handled individually, but the structure does not change. Let them decide |
| "Can I just promote it without a review?" | Yes, by applying as a partner at `/partners/apply`. The free review subscription is for creators who make the review video |
| "Can I run my own giveaway with your codes?" | No. The only giveaway is ours, under its published rules (3.4) |

## 4.5 Disclosure: mandatory, every time

Free product, discount, credit or commission is a **material connection**. The disclosure is **clear and conspicuous, beside the endorsement**: in the video and in the caption, not only in the bio and not hidden behind "more". Use each platform's paid-partnership label as well. This applies to creators, student ambassadors and every partner, in every country we reach (FTC Endorsement Guides, ASA/CAP Code, EU Unfair Commercial Practices rules). **Decided (founder, 21 Nov 2026):**

- Put it in the contract and the kit, with exact example wording.
- Check a sample of posts after they go live.
- A creator who will not disclose is not activated, or is paused.

---

# PART 5 — STUDENT AMBASSADORS: ONLINE AND ON CAMPUS

**New in version 2.** Student ambassadors are partners like any other: the same system, contract and commission. What differs:

- their friends get **at least 15%** off a first order instead of 10%;
- the application requires a university;
- their work is **partly in person**.

There are no other ambassador-specific rules (founder, 21 Nov 2026).

**Ambassadors run their own promotion.** They are independent partners who earn commission, not staff. Valstara provides the kit, guidance, tips and methods to raise their chances. **How they promote is their choice and at their own cost**: flyers, stalls, events or nothing but word of mouth. They must stay within the law, their campus's rules and our partner rules (5.4). Valstara does not book, fund or staff anything on campus.

## 5.1 What the ambassador's pitch is

- **For their friends:** *"Join through my link or code: you get early access before public launch and at least 15% off your first order. Joining is free, and nothing is bought now."*
- **What to lead with:** products with no student plan, or a weak one (AI tools, Netflix and similar). **Do not lead with Spotify or other services whose student plan is often cheaper than Valstara.** The price index can check this market by market.
- **What they may not say:** anything not on the site; a percentage saving on a specific product; "instant"; "cheapest"; that the university endorses Valstara; or anything about earnings that implies income.

## 5.2 Recruiting ambassadors

- **Where to find them (founder, 21 Nov 2026: accepted; the research is done per country when this task is worked on):**
  - student entrepreneurship, business, marketing and computing societies;
  - campus job boards and student-union noticeboards (some accept "student ambassador" adverts);
  - LinkedIn and Handshake-style student job platforms;
  - members who hit 10 referrals (the auto-invite);
  - referrals from existing ambassadors. That is personal outreach only: **one level means no commission for recruiting.**
- **Whom to take:** students active in real communities (society committees, course reps, large study groups), not people with the most followers. The founder approves each one by hand.
- **Recruiting copy** follows 4.3: short, specific and plain, no income claims, and no "be your own boss".
- **Onboarding (founder, 21 Nov 2026), for every partner type:**
  - **A pre-recorded onboarding video** of 15 minutes or less, covering the pitch, the rules in 5.4, how the dashboard works and what counts (confirmed signups only). It opens with a **short personal greeting recorded for each new partner** (hello, their name, a word on why they were accepted), then cuts to the shared recording, as in 4.3a.
  - **A one-page written guide** with the same content, for reference.
  - **Questions go to email.**
  - **A live 15-minute call is an exception, not the default.** Offer it on request while volume allows. When volume grows, keep it for the most promising partners who ask for one.

## 5.3 Methods ambassadors may choose (the guidance we give them)

This is advice for the onboarding video, the guide and the kit, not a plan Valstara runs. The ambassador decides what to do and pays for it.

| Activity | How, and what to watch |
|---|---|
| **Word of mouth** | The best channel there is, if it stays personal. Friends join through the link, the QR code or by typing the code ("Have a referral code?" on the site) |
| **Group chats** (course WhatsApp, Discord, Telegram, Facebook groups) | One post per group, using the kit templates, **only where the group's rules allow promotion**. No mass DMs and no repeated posting |
| **Flyers and posters** (the kit's print flyer: QR code, code and the welcome perk) | **Only where posting is permitted.** Many universities require approval or a stamp from the student union or estates. Unauthorised posting can get the ambassador sanctioned and the brand banned from campus. Check each campus's rules first |
| **Stalls at society fairs and freshers' events** | The ambassador's choice and cost. Usually booked through the student union, often for a fee for commercial stands. The guide tells them to check first |
| **Small events and workshops** | Make the session useful on its own: *"What your subscriptions actually cost per year"* (from the price index), *"How to check a digital seller before you pay"* (the red-flags checklist), or *"AI tools for your course: which plan you actually need"*. The Valstara mention is a short closing segment with the QR code. Book rooms through a society; do not use university branding |
| **Social posts** | Same rules as creators: disclose, no unverifiable claims |

## 5.4 Rules that keep the campaign honest (and stop fraud flags)

1. **Every signup goes through the site** — the link, the QR code or the typed code — **and is verified by the person themself.** Ambassadors **never collect emails on paper or in a spreadsheet, and never sign anyone up on their behalf.** A paper list would be personal data outside our system and our privacy notice. It also has no double opt-in, and typing a friend's email is not their consent.
2. **No incentives beyond the official perks.** No paying, gifting or raffling to get signups. Bought signups do not buy, and the founder can void any referral.
3. **Only real, verified people count.** Duplicate or throwaway addresses are flagged and voided, and voided referrals drop out of the ladder, wave 1 and the dashboard.
4. **Expect campus Wi-Fi to trigger velocity flags.** Many signups from one campus network share an IP prefix, so a busy event can raise IP-velocity flags. Flags never auto-ban and the founder reviews them (review only, see below). Ask ambassadors to tell the founder the date and place of each event, so flags from it can be judged in context.
5. **Ambassadors must be 18 or over**, as every partner must. The waitlist itself says 18+ today. Once the founder's 13+ decision is built (E11.8-06), friends aged 13–17 may join, but they cannot enter the giveaway, and nothing may promise them that they can.
6. **Disclose.** "I'm a Valstara partner and earn commission on purchases" on posts. In person, saying it plainly is enough and is the honest thing to do.
7. **No university names, crests or logos** on flyers or posts, and no implication of official endorsement.

### Same-network signups: review only (founder, 24 Nov 2026)

**Decided: flag and review; never block.** Signups from one network keep raising velocity flags as they do today. Nothing is blocked automatically. The founder reviews them later, partner by partner.

- **Why:** most same-network signups are expected to be genuine, such as student ambassadors' classmates on campus Wi-Fi.
- **The real test comes after launch:** how many of a partner's referred people buy or do anything at all. A partner with 500 referrals, 450 of whom signed up once and never came back, shows up in that review, and the decision is based on it.
- **What the review can use:** the velocity flags raised at signup are kept. The hashed network prefixes behind them are deleted after 90 days, so the review relies on the flags and on post-launch activity, not on IP data. The site never stores a full IP address.
- **Ask ambassadors to report their event dates and places,** so flags from them can be read in context.

## 5.5 Timing and measurement

- **Recruit now, through spring term 2027**, so ambassadors build their referral count before early access (wave 1 for their friends) and before the giveaway closes on 31 August 2027.
- **Main push: the start of the academic year, around public launch** (1 Oct 2027). The `/r/{CODE}` links and codes keep working on the main platform, so autumn flyers can be printed with them. **Customers an ambassador refers after public launch fall under post-launch terms (0.4),** and the onboarding video must say so.
- **Measurement is per ambassador, not per event.** One code per partner, and no sub-IDs, by design. To judge an event, compare that ambassador's signups-per-week before and after it on their dashboard. Judge ambassadors on confirmed signups, their survey categories, and, after early access, first orders.

---

# PART 6 — REDDIT, COMMUNITIES AND DEAL SITES

## 6.1 Reddit

- **Two accounts only:** a transparent founder account and an official brand account. **No sockpuppets, fake testimonials, planted "is Valstara legit?" threads, undisclosed employee or partner advocacy, or bought or solicited upvotes.** For a trust brand, astroturfing is existentially fatal.
- **Weeks of genuine, useful commenting before anything promotional,** with roughly a 10:1 ratio of value to promotion (Reddit's own guidance: no more than about 10% of activity linking to your own content). Read every subreddit's rules, self-promotion thread and vendor-verification procedure first. Always disclose affiliation.
- **The monthly price report is legitimately useful Reddit content** (growth decisions: send findings to relevant subreddits). Post it only where the rules allow, as data, not a pitch.
- **Partners must follow the same rules,** and a partner spamming subreddits with a code harms the brand. **Decided (founder, 21 Nov 2026):** "no spamming communities; follow each community's rules" is a contract term and a kit rule, with pause or termination as the remedy.
- **The expected output is buyer objections, exact customer language and a reputation,** not fast signups. Use Reddit Pro's free tools to *monitor* topics, never to automate posting.
- **Reddit is a large share of AI-assistant citations** (the reports cite 40–47% across studies). Useful, accurate answers there feed GEO (Part 7.3).

## 6.2 Deal sites (post-launch)

Slickdeals, MyDealz, HotUKDeals and Dealabs prohibit merchant self-posting. **Use the Slickdeals Deal Specialist funnel and the Pepper network's official merchant routes after launch.** A front-paged deal converts only once Trustpilot and legitimacy signals exist. There is nothing to post pre-launch, because there are no prices to buy at.

---

# PART 7 — PRICE INDEX, PR, SEO AND GEO

## 7.1 The price index as a marketing asset (built)

- **What it is:** official list prices for 19 services across 20 markets, in local currency, refreshed monthly by hand, with a change log. Its pages rank for "[service] price in [country]" searches before launch. The differentiator, once the founder turns it on, is the official price beside the Valstara price.
- **The pages are justified as programmatic SEO only because each one's data genuinely differs:** the local price, its history, the market comparison and the FAQ. **Never add pages whose only difference is a swapped country name.** That is the scaled-content abuse the reports warn about.
- **Each month** the tool writes an outreach report (`reports/monthly/YYYY-MM.md`) and a public page (`/price-index/YYYY-MM`). **Distribution:**
  - send the findings to journalists, newsletters and relevant subreddits;
  - post a "What changed this month" video and carousel;
  - post an X thread;
  - send a Telegram channel post.
- **The data source is not credited on Valstara's pages** (founder decision). Outreach copy should say only what the methodology page says. It must not claim the prices come from official pages: they come from a public listing, checked by hand against providers' own pages where needed.

## 7.2 SEO

- **The trust and legal pages are the SEO surface that survives into the store,** at their permanent URLs. The landing page converts; those pages rank.
- **Never mass-produce thin or AI-generated pages.** Publish trust content and price data before broad informational blogging. AI Overviews are eroding clicks on informational queries (Ahrefs, Pew and Semrush, 2026), so weight effort towards queries close to a purchase or a trust decision.
- **Let Search Console decide what comes next,** especially pages with high impressions and low click-through.
- **Decided (founder, 22 Nov 2026): verify the domain in Google Search Console and Bing Webmaster Tools on the day the site goes live** (just after E12-07, not as part of it). Verification is a DNS record; nothing goes on the page. **It is measurement, not SEO work, and it is free.** Google starts crawling the price and trust pages the moment they are public, whether or not any link-building has happened. Verifying at go-live does three things:
  - it submits the sitemap, so the ~400 price pages are discovered quickly;
  - it shows indexing errors early;
  - it gives a clean "before" baseline, so the effect of any later SEO work can be measured against it.
- **SEO packages that build links: check before buying.** Google's spam policies treat buying links that pass ranking credit as a link scheme. A manual penalty on a new domain whose proposition is trust would be very costly. Before buying any package, ask exactly what links it builds and where, and reject paid-placement or private-blog-network links. Prefer links earned by the price data and PR (7.1, 7.4).
- **Store-launch SEO** (product pages naming the fulfilment method, region, term and guarantee coverage; Product structured data; one product page per keyword cluster; no per-country clones; Core Web Vitals) is in Part 9 and belongs to the storefront.

## 7.3 GEO: being cited by AI assistants

- `llms.txt` ships, but **expect nothing from it.** The project's own research found no correlation with citation frequency, and Google says it does not use it.
- What does move citations, per the reports:
  - **brand search volume** (social and PR feed it);
  - **recent, dated content**;
  - **Reddit presence**;
  - **fast pages**.
- **Decided (founder, 21 Nov 2026):** track buyer-intent prompts monthly across ChatGPT, Perplexity, Gemini and Google AI Overviews. **There is no fixed number of prompts; the set is built when the task is worked on.** Build it as several prompts per product × market × intent:
  - **price, by market:** "Netflix price in Sweden", "… in Italy", "… in France";
  - **saving:** "cheapest way to get ChatGPT Plus", "how to get ChatGPT Plus cheaper", "ChatGPT discount code", "ChatGPT coupon code";
  - **trust:** "is Valstara legit", "safe place to buy cheap subscriptions".

  Keep the set fixed between months, adding prompts without dropping any, so trends stay comparable.

## 7.4 PR

- **The monthly price report is the PR engine.** "Spotify raised prices in 4 of our 20 markets this month" is a story a journalist can use without mentioning us favourably.
- **Decided (founder, 21 Nov 2026):** build a list of consumer-tech, personal-finance and student journalists and newsletters per market, and pitch them the data, not the brand.
- **Building in public** (founder on LinkedIn and X) gives journalists a person to quote.

---

# PART 8 — BUDGET, MEASUREMENT AND KILL RULES

## 8.1 Budget principles

- **Spend on assets that keep acquiring after the money is gone:**
  - creator review subscriptions (at Valstara's cost price, not retail);
  - the asset kit and printed flyers;
  - content production;
  - the paid email plans.

  **Do not buy cold traffic at scale.**
- **Paid social ads for discounted subscription goods carry account-ban risk on Meta and TikTok** (the reports' finding). There is also no site pixel to optimise against before launch.
- **Decided (founder, 22 Nov 2026): a small brand-defence Google Search campaign, after launch.**
  - **What it is:** Google Ads bought only on searches for our own name ("Valstara", "valstara.com", "Valstara legit", "Valstara discount"), so our ad sits at the top of the results for people already looking for us.
  - **Why:** once a brand gets known, resellers, coupon sites, and sometimes scammers or look-alike shops bid on its name and appear above it, taking the customer or their trust. Our own ad, pointing to our real site, closes that gap.
  - **Cost:** it is cheap, because Google rates an ad for your own brand as highly relevant, and few others bid on it.
  - **Timing:** after launch, because before then almost nobody searches the name and there is nothing to buy. Search Console (7.2) shows when brand searches become worth defending.
- Keep a **$400–600 contingency.**
- **The founder sets the budget split** (founder, 21 Nov 2026).

## 8.2 What we judge

- **Pre-launch:** cost per verified, category-qualified member; the verification rate; survey completion; the share of members who refer; confirmed referrals per active referrer and per partner; and the partner and ambassador yield (confirmed signups per active partner per week).
- **Post-launch:** waitlist → first-order conversion by category and wave; first-order contribution after every cost; delivery within the promised window; time to first support reply; resolution, replacement and refund rates tracked separately; chargebacks; and repurchase at 30, 60 and 90 days.
- **North star (from early access):** 90-day contribution per new customer cohort.
- **Break-even cost per lead** = first-order contribution × lead-to-first-purchase rate. For example, $15 × 20% = $3 per lead before any future value. **Never judge on followers, impressions or raw signups.**
- **Viral coefficient** = qualified invites per member × referral conversion rate. Below 1 still lowers blended acquisition cost.

## 8.3 Benchmark content against our own median

After 20 pieces in one format, compute Valstara's median. **Top 20%:** remake the topic with a new angle. **Middle 60%:** keep testing. **Bottom 20%:** stop, unless it is strategically necessary.

- **Short video:** 3-second hold, average watch time, completion, shares and profile visits per 1,000 views, and site visits.
- **Carousels:** saves and shares as a share of reach.

## 8.4 Kill rules

| Trigger | Action |
|---|---|
| A credibility incident on the leaderboard (suspected gaming) | Turn `leaderboard.public` off (no deploy needed); the weekly email's top 10 becomes the fallback |
| A wrong price live on a price page | Turn `prices.pages` off at once (every price page returns 503 without losing its index status); fix, then republish |
| A partner breaking disclosure, spamming or misrepresenting | Founder pauses them (link and code stop attributing) and voids bad referrals |
| A partner-programme incident (abuse, a wrong claim in partner copy) | Turn `partners.enabled` off: applications pause, `/r/{CODE}` stops attributing, dashboards say the programme is paused, and no data is touched |
| A social platform below threshold after 60 days of consistent posting | Deprioritise it; move effort to the top two channels |
| *Post-launch:* Trustpilot below 4.0 | Freeze all acquisition spend; fix fulfilment and service first |
| *Post-launch:* paid cost per acquisition above order value within 2 weeks | Pause the campaign |
| *Post-launch:* waitlist → buyer below 10% | Fix the offer and onboarding before scaling spend |

---

# PART 9 — KEPT FROM THE ORIGINAL THREE REPORTS

Kept because nothing in the project contradicts it. **Statistics are the reports' figures from August 2026 and must be re-verified before external use.**

## 9.1 Reviews and Trustpilot (from early access)

- **Never incentivise reviews** (no discount, code, entry, refund, freebie or credit for a review). **Never gate them**; invite every customer neutrally. Never ask for five stars. Respond to negative reviews quickly and publicly with the remedy in progress. Invite steadily, not in bursts.
- The profile is claimed and linked from `/legit`, with **no widget or rating pre-launch** (a three-review score signals "unproven").
- Invite 7–14 days after delivery. Ramp gradually, because spikes get flagged. Recency dominates. A 4.2–4.5 rating with thoughtful replies converts better than a suspicious 5.0.
- Targets: 5–10 reviews in the first 30 days; 15–25 at 4.3+ by day 60; 50+ by month 6; 100+ at 4.4+ by month 12.
- **The giveaway is never connected to reviews.**

## 9.2 The Vault, lifecycle and retention (store)

There is no recurring billing, so **the Vault and the renewal reminder are the revenue engine.** The lifecycle runs:

1. delivery and activation;
2. a day 2–3 "is everything working?" check;
3. a day-7 referral invitation, with the reminder that a friend referred them (2.2);
4. a relevant mid-term cross-sell;
5. pre-expiry reminders;
6. the expiry-day notice;
7. one-click reorder at current price;
8. win-back only if they have not repurchased.

Experiment G: *"Your access ends in 14 days. Valstara does not auto-renew you."* turns a limitation into a trust reminder.

## 9.3 Product pages (store)

- **State the fulfilment method explicitly:** activation code, account invitation, new account or official voucher.
- Show region eligibility, exact term, account requirements, activation steps, delivery time, expiry and guarantee coverage.
- Add a **"What happens when…" table** under the guarantee: not delivered; code already used; wrong region supplied by us; access stops during the term; customer bought the wrong region despite a warning; publisher discontinues the product; change of mind.
- **Never phrase the guarantee as if it created statutory rights** (EU and UK digital-content remedies exist anyway). The differentiation is speed, clarity and coverage beyond the minimum.
- Treat the EU 14-day withdrawal rules per country at checkout.
- One page per product targets the whole keyword cluster (buy, price, 3/6/12 months, region, activation, renewal). No near-duplicate pages, and no programmatic country clones of product pages.
- Core Web Vitals targets: LCP < 2.5s, INP < 200ms, CLS < 0.1.
- Hreflang errors void whole clusters, so QA them.
- Prefer subdirectories (`/de/`); the site already serves English at the root for this reason.
- Do not inject self-authored AggregateRating.

## 9.4 Store-launch experiments

A/B testing needs storefront tooling; the pre-launch site has no experiment framework, by design.

- **B:** explicit delivery method, measured on conversion **and** support tickets per 100 orders.
- **C:** a dated guarantee ("Protected by Valstara until 19 August 2028").
- **D:** "See today's verified price" in editorial and social contexts.
- **E:** a proof-first creator video against a polished one.
- **A:** a trust-first against a savings-first hero, measured on purchase, not clicks.

## 9.5 The ten buyer questions

Every product page, Reel, Reddit answer, support macro, partner template and ambassador script answers them **consistently**:

1. Is Valstara legit?
2. Why is it cheaper?
3. Who actually sells me the product?
4. What exactly gets delivered?
5. How long will it work?
6. What happens if it stops?
7. Can I use it in my country?
8. How quickly will I get it?
9. Will it auto-renew?
10. Can I get my money back?

**Decided (founder, 21 Nov 2026):** write one approved answer to each, from the trust pages and store documentation, and reuse it everywhere. **The ten are a starting set, not final;** add questions as the audience research, support inbox and survey surface new ones. Ofcom (2025) found 43% of UK adults use social platforms for search daily, and 34% use video platforms such as TikTok, so the same buyer meets our answers on several surfaces.

## 9.6 Competitor guarantee teardown

- **GameSeal:** its stronger protection is a paid add-on, and the remedy is at its own discretion.
- **G2A:** says in its terms that it is not the seller.
- **Eneba:** stops change-of-mind returns once a code is viewed.

The buying questions (*who sold this to me, who do I contact, what happens if it dies in month five*) are where the marketplace answer is conditional and Valstara's is not. **Use this as framing, not as named attacks** (Part 1.2).

**Do not use "Hong Kong entity weakens EU buyer protection" against any competitor.** Valstara's own company is in Hong Kong. The reports listed it as a G2A and Kinguin weakness; for us it is a self-own.

## 9.7 Post hooks

Kept, with changes. Hooks that named and attacked competitors were rewritten to category framing. Hooks about products outside the launch catalogue were marked.

1. "Every AI subscription price increase in 2026, ranked."
2. "What Netflix actually costs in our 20 markets — from our price index."
3. "Your subscriptions cost more than your car insurance. Here's the math."
4. "How to tell if a digital-goods store is safe — an honest checklist from someone who sells them."
5. "Why cheap game keys get revoked — and how to avoid it." *(Game keys are not in the launch catalogue: education only.)*
6. "The difference between a marketplace and a direct seller (and why it matters when something breaks)."
7. "ChatGPT Plus costs $20 a month. Here's every legit way to pay less."
8. "I read 500 one-star reviews of digital-goods stores. Here's what actually goes wrong." *(Category-wide, no store named.)*
9. "Spotify raised prices again. Here's what a year actually costs now."
10. "We deliver within 24 hours, Monday to Friday. Here's why we don't promise faster."
11. "How regional pricing works — and why VPN tricks can get your account banned."
12. "Adobe wants $660 a year. Let's talk alternatives and real discounts."
13. "The 3 questions to ask before buying anything digital online."
14. "What happens when a digital purchase goes wrong? A walkthrough of our guarantee."
15. "Every streaming service, ranked by price per hour watched."
16. "Cheapest legit way to get Microsoft 365 (not a sketchy $3 key)."
17. "Why the same subscription costs double in Switzerland what it costs in Poland." *(Check against the index first.)*
18. "The real reason digital-goods sites feel scammy (and how to spot a real one)."
19. "AI subscription stacking: what a power user actually pays per month."
20. "We asked what makes you trust an online store. Here's what you said." *(Use only real survey or poll answers.)*
21. "Six months of ChatGPT Plus, Netflix and Spotify prices in one chart."
22. "Unpopular opinion: most 'lifetime deals' are worse than paying monthly."
23. *(Student)* "Which subscriptions have a student plan — and which don't."
24. *(Building in public)* "We're building a store that has to prove it's not a scam. Week 1."

*Removed:* the gift-card top-up and eSIM hooks (not in the launch catalogue), and "the Turkey trick" phrasing.

---

# PART 10 — WHAT VERSION 2 CHANGED, AND WHY

| Version 1 said | Now | Source |
|---|---|---|
| Communicate the SubSlush transition honestly; 301-redirect SubSlush to Valstara; email-warm on the most engaged SubSlush contacts; soft opt-in for SubSlush customers as "the same operator" | **SubSlush is completely separate.** No public mention, no email track, list never imported, no redirect. One manual announcement goes from SubSlush's own marketing email (founder, 21 Nov 2026) | Growth decisions 17 Nov 2026; ADR-028; compliance §5 |
| Rewards must be store credit or access, never cash | Members: wave 1, the coupon ladder, $5 credit per purchasing friend. **Partners earn 10% cash commission** (post-launch, main platform) | Growth decisions; partner-programme spec |
| Milestone ladder: 1 referral → earlier window; 3 → locked discount; 5 → higher draw | **Retired.** The first 1,000 or 3 referrals give wave 1; coupons at 3/21/39 stepping to 30%; held until a friend's first order | E11.7-03; ADR-025 amendment |
| "Founding Price Lock" for members | Not adopted. Founding vouchers and prepaid sales were **dropped**. "Founding" applies only to the **partner terms**, which are pre-launch only (0.4) | Growth decisions; founder 21 Nov 2026 |
| Fraud rules on device, IP and payment identity; cap referrals per account | **No device fingerprinting, ever.** Email normalisation, disposable/MX checks, self-referral flags, and hashed IP-prefix velocity flags. Flags only; humans decide. No referral cap (coupons end at 54; referrals keep counting) | ADR-013; E5; standing rules |
| Giveaway rules list eligible territories and void locations | **One global draw under Hong Kong law, no country excluded or collected at entry.** Prize: 5 × €300 bundles; entries close 31 Aug 2027 and the draw is on 1 Sep 2027 (founder, 24 Nov 2026; E11.8-05) | ADR-026, ADR-027 |
| Initial form: email → country → product | **Email only.** No country. The survey comes after verification: categories plus buying frequency | ADR-026; ADR-031 |
| Hero: "Digital subscriptions, sold with accountability"; CTA "Join Founding Access"; country selector | Live: eyebrow "Digital goods you know are real.", H1 "Premium digital goods, for less.", CTA "Join the waitlist". No country selector | E11.5 final design; landing copy |
| Waitlist tools: LaunchList, KickoffLabs, Viral Loops | **Built, not bought.** Hosted waitlist and referral SaaS is permanently out of scope (it sells ranking inflation and taxes success) | ADR-020; AGENTS.md |
| GA4, a consent platform, server-side conversion tracking; retarget site visitors | **Cookieless Umami only, no banner, no pixels.** GA4 and a CMP return at store launch. No site-visitor retargeting pre-launch | ADR-007; compliance §3 |
| Affiliate: 5–10% on first order, 30-day cookie, Rewardful or Tolt | **10% on all orders by customers referred during pre-launch, from early access until 1 Oct 2028; one level; a contract per partner** (founder, 21 Nov 2026). No cookie: server-side attribution fixed at signup, with a permanent `/r/{CODE}`. Built in-house pre-launch; the main platform's system after | Partner-programme spec |
| Creator rate card ($10–800 per post) | **No upfront fees.** A free 3/6/12-month subscription, an honest review, 12-month reuse rights, partner status | Growth decisions (creator seeding) |
| Don't programmatically generate country pages | Programmatic **price** pages exist by founder decision, justified by genuinely different data per page. The warning still applies to product pages | Growth decisions; E11.6 |
| `llms.txt`: low cost, some upside | Ships; **expect nothing from it** | `docs/features/seo.md` |
| "Have counsel review" before launch (giveaway, data, CAN-SPAM) | The founder **waived** lawyer review of privacy, terms and the Turnstile basis (ADR-030) and determined the HK giveaway position (ADR-026). Advertising-disclosure obligations for partners are not waived | ADR-026, ADR-030 |
| Competitor weakness: "Hong Kong entity" | **Removed.** Valstara is a Hong Kong company | Brand identity §0 |
| Hooks naming G2A, the gift-card and eSIM hooks | Rewritten or removed | Copy rules; P8 catalogue |
| *(not covered)* | **New:** the partner programme, student ambassadors with on-campus work, creator seeding terms, the price index and monthly PR, Telegram and Discord, the 2027 timeline, and the measurement limits of a cookieless site | Partner-programme spec; growth decisions; founder instruction 21 Nov 2026 |

---

# PART 11 — FOUNDER DECISIONS OF 21–24 NOVEMBER 2026, OPEN TASKS AND OPEN QUESTIONS

## 11.1 Decided

| Topic | Decision | Where applied |
|---|---|---|
| Positioning line | Compare only with GameSeal, G2A and Eneba. Lead with "more than triple GameSeal's commission rate", in pre-launch only | 0.4 |
| Pre-launch commission | 10% for customers referred during pre-launch, on orders from early access (1 Sep 2027) to 1 Oct 2028. Post-launch referrals earn a new rate | 0.4, 4.4 |
| Dates | Early access 1 Sep 2027, public launch 1 Oct 2027 (made final on 22 Nov) | 0.2 |
| Partner competition | 1 Sep – 31 Dec 2027 | 0.4 |
| SubSlush announcement | Sent by hand from SubSlush's own marketing email; the list is never copied to Valstara | 0.6 |
| Private credentials | 1:1 only, accepted | 0.6 |
| Budget | $5,000; the founder sets the split | 0.9, 8.1 |
| First 1,000 | "Join early" messaging, never a running count of places left | 2.2 |
| Referral reminders | Adopted | 2.2 |
| Handles and backups | Secure "valstara" everywhere; backup TikTok and Instagram accounts, each on its own device | 3.1 |
| Content ratio | Start at 4 useful posts to 1 campaign post; review against data (partly done, 11.3) | 3.2 |
| Reel length | 3-minute cap | 3.2 |
| Social giveaways | None on-platform; research each platform's rules first | 3.4 |
| Telegram and Discord | Telegram broadcast-only; Discord small and narrow | 3.5 |
| Creator follow-up | One follow-up after a week, then stop | 4.3 |
| Video outreach | Loom-style personal video where links are safe | 4.3a |
| Disclosure | In the contract and kit; spot-check posts | 4.5 |
| Ambassadors | No rules beyond the 15% floor and the university field; they choose and pay for their own methods | 0.5, Part 5 |
| Ambassador recruiting | Accepted; research per country | 5.2 |
| Onboarding | A pre-recorded video with a personal greeting; calls by exception | 5.2 |
| Partner community rules | No spamming; pause or terminate | 6.1 |
| GEO prompts | No fixed number of prompts | 7.3 |
| Journalist list | Accepted | 7.4 |
| Buyer questions | One approved answer each; the list is not final | 9.5 |
| **22 Nov:** dates final | Early access 1 Sep 2027, public launch 1 Oct 2027, recorded everywhere | 0.2 |
| **22 Nov:** one-year rate lock | No lifetime lock; the 10% window ends 1 Oct 2028 | 0.4 |
| **22 Nov:** positioning lines | "More than triple GameSeal's commission rate", then "double the rate of G2A and Eneba" | 0.4 |
| **22 Nov:** Trust Ledger | The founder's definition; operations numbers only, no revenue; first entry December 2026 | 3.6 |
| **22 Nov:** Search Console | Verify Google and Bing on the day the site goes live | 7.2 |
| **22 Nov:** brand-defence search | A small Google Ads campaign on our own name, after launch | 8.1 |
| **22 Nov:** per-platform signup report | Wanted, as detailed as possible: TikTok, Instagram and the rest each shown separately | 0.7 |
| **24 Nov:** the `/me` early-access fact | Shows the short month, "Sep 2027"; sentences keep "September 2027". Recorded on E11.7-04's plan entry, replacing D-049's smaller type step | — |
| **24 Nov:** where the two new tickets go | Epic E11.8 (E11.8-01 the Trust Ledger page, E11.8-02 the per-platform report), after E11.7-15 and before GATE-8, which now audits E11.6 + E11.7 + E11.8; P11 added for the Ledger's founder text | 3.6, 0.7 |
| **24 Nov:** after public launch | Partners on case-by-case terms; a separate affiliate system with uniform or laddered rates. Neither is decided here | 0.4 |
| **24 Nov:** age | The waitlist opens to 13 and over; the giveaway is 18 and over only; marketing email 16 or over; a separate unticked 18+ box to enter, also offered later on `/me`; a lawyer's review first (P12). Ticket E11.8-06 | 0.3, 4.2, 5.4 |
| **24 Nov:** the founder note to members | A short note in the weekly update, from a content file, with the send-time consent and suppression checks. No Brevo-editor campaigns to members. Ticket E11.8-03 | 3.6, 9.2 |
| **24 Nov:** the referral reminder | A welcome-email line for members referred by another member, naming no one (E11.8-04), plus the storefront's day-7 email after launch | 2.2 |
| **24 Nov:** giveaway dates | Entries close 31 Aug 2027, 23:59:59 UTC; draw 1 Sep 2027. A new rules revision before `giveaway.open` (E11.8-05) | 0.2, 3.4 |
| **24 Nov:** same-network signups | Review only: flag, never block; judge partners on post-launch activity | 5.4 |
| **24 Nov:** support response time | "Within 24–48 hours; up to 7 days for investigations or high volume". The founder moderates Discord | 3.5 |
| **24 Nov:** no supplier register | Supplier counts only in the Ledger; "the Supplier Register" removed from the brand guidelines | 3.6 |
| **25 Nov:** Umami only | Cloudflare Web Analytics dropped: its beacon is a third-party request. E12-05 keeps it off | 0.7 |
| **25 Nov:** the lawyer's review | P12 widened to the whole `/privacy` and `/terms` with the age change. Only E11.8-07, after E12, waits on it | 0.3, 4.2 |
| **25 Nov:** partner announcements | Ticket E11.7-16: one email to every partner, on the digest's audience and opt-out | 0.4 |
| **24 Nov:** to-do items, not decisions | A partner-wide announcement channel (now E11.7-16); the competition's prizes and rules; creator subscriptions before the store; trademark clearance; supplier-status definitions; every founder input and research task | 11.4 |

## 11.2 Recorded in the project on 22 November 2026

The founder authorised the changes in 11.1 "everywhere in all documents", and they were applied in one pass:

- **The plan.** Epic E11.7 gained founder decisions dated 2026-11-22 (dates, partner commission, positioning line). E11.7-04's early-access month, E11.7-05's `/partners` content, E11.7-08's perks example, E11.7-09's terms summary and E11.7-14's hand-over document now follow them.
- **The spec.** `docs/features/partner-programme.md` now holds the summary, the waves, the expiry, the $5-credit line, and the founder's words verbatim under "Founder amendments, 22 November 2026".
- **The growth decisions.** `docs/prerequisites/valstara-prelaunch-growth-decisions.md` has the timeline, duration, rate lock, positioning and competition window; the competition window is no longer open.
- **The other docs.** ADR-012, ADR-025, `docs/data/model.md`, `docs/modules/referral.md`, `docs/features/member-status.md`, `docs/brand/page-design.md` and `docs/ops/launch-cutover.md` now show the new expiry date and month.
- **Configuration.** `waveOneEarlyAccessMonth` is `'2027-09'` and `couponLadder.publicLaunchDate` is `'2027-10-01'` (coupons expire on 2032-10-01). The tests that assert those values were updated with them.

**Added on 24 November 2026 (founder-authorised):**

- **Epic E11.8** in the plan, with **E11.8-01, the Trust Ledger page**, and **E11.8-02, the per-platform signup report**;
- their register rows after E11.7-15, with GATE-8 now auditing E11.6 + E11.7 + E11.8;
- **prerequisite P11**, the Ledger's founder text;
- the spec `docs/features/trust-ledger.md`, with the founder's definition verbatim;
- the report's section in `docs/features/analytics.md`;
- `/trust-ledger` in the SEO route plan and the cutover route table;
- the brand guidelines' programme example amended;
- after the founder accepted the four recommendations: **E11.8-03** (the founder note in the weekly update), **E11.8-04** (the referral reminder), **E11.8-05** (the rules revision with the new dates) and **E11.8-06** (the 13+ waitlist with the 18+ giveaway box), **prerequisite P12** (the lawyer's review), the superseded dates on P4, and "planned" notes in the signup, giveaway and email specs.

## 11.3 Tasks that stay open after their first decision

| Task | Done so far | Stays open until |
|---|---|---|
| The content ratio (3.2) | Starting ratio 4:1 | Reviewed against our own retention and signup data at 20 posts per format, then about 30 and 50. Each review is logged here |
| Algorithm notes (3.2) | Noted | Re-verified each quarter |
| Platform giveaway rules (3.4) | Required | Researched and recorded per platform, before the first giveaway post |
| Platform DM and link rules (4.3a) | Required | Researched before outreach starts |
| Video outreach (4.3a) | Adopted as a hypothesis | Reply and acceptance rates, with and without video, show whether it works |
| Teen audiences (4.2) | Facts listed | Approach decided when creator targeting is worked on |
| Same-network signups (5.4) | Decided: review only | The partner-by-partner review is done, using the kept flags and post-launch activity |
| Competitor commission evidence (0.4) | Network listings found | Dated captures of official terms before first public use; re-checked each quarter |
| GEO prompt set (7.3) | Approach agreed | The set is built; then tracked monthly, indefinitely |
| The ten buyer questions (9.5) | Starting set agreed | Answers written and approved; added to as new questions surface |
| The Trust Ledger (3.6) | Defined; ticket E11.8-01 placed | P11 is supplied, E11.8-01 is built, the first entry ships in December 2026; then monthly, indefinitely |
| Per-platform signup report (0.7) | Ticket E11.8-02 placed | E11.8-02 is built, and the UTM convention is in use on every link we control |

## 11.4 Still open, and what moved to the to-do list (24 November 2026)

### Answered on 24 November 2026 ("Use recommendations")

| # | Question | Answer, and where it is recorded |
|---|---|---|
| Q1 (was D3) | How Valstara sends members a written message | A founder note in the weekly update, from a content file (E11.8-03). No Brevo-editor campaigns to members |
| Q2 (was D4) | The "a friend invited you" reminder | A welcome-email line for member-referred members (E11.8-04), plus the storefront's day-7 email after launch |
| Q3 (was D8) | The giveaway's dates | Entries close 31 Aug 2027; draw 1 Sep 2027 (E11.8-05) |
| Q4 (was D9) | The three conditions for 13+ | Marketing 16+; a required, unticked 18+ giveaway box; a lawyer's review (P12, applied by E11.8-07 after E12) |
| Q5 | A later way into the giveaway for a member who skipped the 18+ box | Yes: the same box on `/me`, giving the base entry plus one per confirmed referral held (E11.8-06) |

### Still open

Nothing. **Q6** (does a referral by a member who did not tick the 18+ box earn their referrer an entry?) is part of the lawyer's review, P12, a to-do task. Until it is answered, the system's setting defaults to no.

### Moved to the marketing to-do list (founder, 24 Nov 2026)

These are tasks, not decisions. Each is settled when its task is worked on, and several also need a development ticket at that point:

- a channel for announcements to every partner at once (was D2; now ticket E11.7-16);
- the post-launch partner competition: prizes, bonus threshold, written rules, announcement date (was D5);
- creator review subscriptions before the store exists: delivery, timing, what the review shows (was D7; goes with the asset kit);
- trademark clearance for "Valstara" (was D12);
- the definitions of an evaluated, verified and rejected supplier for the Ledger (was D13, part of P11);
- every founder input: P10, P5, P6, P7, P11, P12 (the lawyer's review of the privacy notice, the terms and the age change, including Q6), the weekly founder notes, the partner and creator contract template, the giveaway bundle contents and sanctions list, the ten approved buyer answers, the digest's founder note, and the dated competitor-rate captures;
- every research task: platform giveaway rules, direct-message and link rules, ambassador and campus rules per country, creator targeting, audience research, journalist lists, the GEO prompt set, and Loom's limits.

**Settled, no longer open:** Q1–Q5 (above); where the new tickets go (Epic E11.8); post-launch rates (case-by-case partners plus a separate affiliate system, decided outside this repository); same-network signups (review only); the Discord response time and moderation; the supplier register (none).

