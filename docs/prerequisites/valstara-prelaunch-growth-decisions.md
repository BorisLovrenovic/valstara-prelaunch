# Valstara — Pre-Launch Growth & Partner Programme: Decisions

**Last updated:** 17 November 2026
**Supersedes:** anything in the growth playbooks or the Nov 2026 research report that conflicts with this file.
**Out of scope here:** legal, compliance, payouts, tax. Handled by the legal team.

---

## Timeline (locked)

| Date | Event |
|---|---|
| Now → July 2027 | Pre-launch campaign: waitlist, referrals, partner programme open |
| Early July 2027 | **Early access opens.** Store live for qualifying members. Real orders and partner commissions start on the main platform. |
| Early September 2027 | **Public launch.** Lines up with the start of the academic year. |

## SubSlush (locked)

SubSlush is **completely separate** from Valstara: no shared emails, no mentions on the site, no soft launch on the SubSlush codebase, no SubSlush email track. *This overrides the growth playbook's "don't hide SubSlush" advice.*

## Early access (locked)

- Any member who refers **3 confirmed signups** gets early access in July. This applies to everyone, not just partners.
- Anyone who signs up through an **active partner's link or code** gets early access without needing 3 referrals. Partners themselves get early access automatically.
- Only signups that confirm their email (double opt-in) count toward the 3.
- **Scarcity wording must be honest.** Some high-demand products genuinely have limited supplier stock. Approved framing: *"Some high-demand products have limited supply. Early access members get first pick."* Never imply the public launch will be empty.

## Partner (affiliate) programme — commercial terms (locked)

- **Rate:** fixed **10%** of order value on **all products**. No category rates. Gift cards and game keys aren't in the launch catalogue; revisit when they arrive.
- **Duration:** 10% of every order a referred customer places, for **12 months** from that customer's first order.
- **One level only.** No commission for recruiting other partners.
- **Founding rate lock:** partners who join before public launch keep 10% for 12 months per referred customer for the life of the programme. Any future change applies only to partners who join later.
- **Contracts for every partner.** Short, plain-English and fair: no small print, readable without a lawyer.
- **Programme opens now.** Most active recruiting happens April–June 2027. Student ambassadors and seeded creators (recruited directly, under contract) can start immediately.
- **Positioning:** "double what the big marketplaces pay" (G2A and Eneba pay about 5%).

## Pre-launch partner system (locked 17 Nov 2026)

**It's deliberately simple and temporary.** It's retired when the full affiliate system on the main Valstara platform goes live, which is planned for **July 2027 (early access)**. Keep build time and complexity low.

- **No commissions are calculated before launch.** The pre-launch system only records attribution (who referred whom) and exports it to the main platform.
- **Entry:** anyone can apply, and the founder reviews every application by hand. Members who reach **10 confirmed referrals** get an automatic invitation to apply.
- **Application:** asks only what's essential and relevant. No unnecessary fields.
- **Contract:** the founder reviews the application, creates the contract and sends it through **signfree.io**. The partner signs from the link in their email. The system only records the status (contract sent / signed), the date and the contract version. **There is no signing inside the system.**
- **Retroactive attribution:** when a member becomes a partner, everyone they had already referred is attributed to them as a partner.
- **Codes:** every partner gets a link plus a **custom code they choose** (for example MAYA). The founder can edit it at approval. The system checks it's unique and runs it against a blocklist.
- **Welcome perk** for people who sign up through a partner's link or code:
  - early access;
  - **10% off their first order**, or **15% through a student ambassador's link**.
  - The perk is recorded now and redeemed on the main platform.
- **Leaderboard:** visible to partners only. Other partners appear anonymously (initials or a nickname) unless they choose to show their name.
- **Login:** magic link by email. No passwords.
- **Partner types:** standard, student ambassador, creator.
- **Links are permanent.** Partner links and QR codes must keep working after the switch to the main platform, because flyers will have been printed with them.
- **Code-agent prompt** written 17 Nov 2026.

### Dropped
- Partner competitions before launch: signups are too easy to fake.
- Founding vouchers or any prepaid sales before launch.
- Pending referral credit per signup.
- E-signature built into the system (signfree.io is used instead).

### Post-launch partner competition
Runs on the main platform. Ranked on real referred order value after refunds. Prizes for the top 3, plus a bonus for everyone who passes a set amount. Announce it pre-launch so it motivates partners now.
- **Open:** the measurement window. Founder proposed public launch → 31 Dec 2027. Recommendation: 1 Jul → 31 Dec 2027, to include early access.

## Creator seeding (locked)

- Target **small and mid-size creators**, not big ones. No upfront fee.
- They get a **free subscription** (3, 6 or 12 months depending on the product) to review honestly. Example: YouTube Premium for 12 months costs Valstara about $50–60, while the creator sees it as worth $160–180 at retail.
- **Contract terms:** the creator posts an honest review video. Valstara may reuse the video on its own Instagram and TikTok for **12 months**. The creator becomes a partner immediately with their own link and code.
- **Timing:** creators can be signed now. Content should land before September; July–August is the latest useful window.

## Student ambassadors (locked)

- Students promote Valstara on campus and in student WhatsApp, Discord and Facebook groups, using their own code and link. They are partners on the standard 10% terms.
- Valstara provides a material kit: printable flyers with a QR code and personal code, and ready-to-post messages and images for student groups.
- **Student perk:** people who sign up through a student ambassador get **15% off their first order** instead of 10%.
- **Product focus:** lead with products that have no student plan or a weak one (AI tools, Netflix and similar). Spotify Student and similar plans are often cheaper than Valstara's price.
- **Timing:** recruit now; main push at the September public launch (start of the academic year).

## Price index + programmatic pages (locked)

- Build both **now**, not in March.
- **Data source:** **https://www.youfundceo.com/**, using a slow, polite scraper.
  - The founder found it to be the most current source. It caught Spotify Sweden 129 → 149 SEK (October 2026) and YouTube Premium Individual Sweden at 169 SEK. Other sites and Google's AI answer were out of date on both.
  - It covers 41 services, so some Valstara products won't be on it.
  - Any (market × product × plan) the source doesn't cover is **flagged** for manual entry.
  - If the gaps turn out to be large, a later tool fetches official provider pricing pages through an in-country proxy or VPN.
- **Run cadence:** **monthly, run by hand** by the founder. No scheduled runs.
- **Currency:** prices are shown in the **local currency exactly as the source displays them. Valstara does no currency conversion.** The source's approximate USD figure is stored only to rank markets against each other internally.
- **Source credit:** **none** on Valstara's pages.
- **Storage:** JSON files in the project folder for now (latest file plus dated snapshots plus a change log); on the server later.
- **Price-index markets:**
  - Europe: UK, Germany, Spain, France, Italy, Poland, Romania, Sweden, Norway, Denmark, Finland, Switzerland, Netherlands, Croatia, Ireland, Austria, Portugal;
  - Canada, **United States, Australia**.
- **Confirmed products tracked:**
  - Adobe Creative Cloud
  - Amazon Prime / Prime Video
  - Apple TV
  - Apple Music
  - Bolt.new Pro
  - Canva Pro
  - ChatGPT Plus
  - Crunchyroll Mega Fan
  - Duolingo Super and Duolingo Max
  - Figma Professional
  - LinkedIn Premium Career and LinkedIn Premium Business
  - Lovable
  - MyFitnessPal
  - n8n Starter
  - Netflix Basic, Standard and Premium (4K)
  - Notion Plus
  - Perplexity Pro
  - Spotify Premium Individual
  - YouTube Premium
- **Programmatic pages:** one template × products × markets (e.g. "[Service] price in [country]"), fed by the price index data.
- **Differentiator:** official list price vs Valstara price in each market. Existing price-by-country sites (Subscription Land, PriceWorld, OpenTheRank and others) show only official prices.
- **Distribution is SEO plus active outreach:** each month, send the findings to journalists, newsletters and relevant subreddits.
- **Code-agent prompt** written 17 Nov 2026. It covers the scraper, the gap-flagging and manual-override system, the change log and monthly report, and the programmatic pages. Amendments with the answers above were also issued on 17 Nov 2026.

## Growth engine (locked)

Trust Ledger and building in public, monthly price index, programmatic pages, overpay calculator.

## Email (locked)

- Segmented, trigger-based. Tracks: members, partners, segmented by survey category and market. **No SubSlush track.**
- Double opt-in at signup. Only confirmed emails are counted or emailed.
- **Partner list:** an automated monthly digest (the partner's stats, rank, waitlist growth) plus quarterly founder updates. Ramp up from about April 2027, three months before early access.

## Member referral rewards (open: recommendation pending founder approval)

- **Signup rewards:** non-monetary only (early access at 3 referrals).
- **Referred friend:** 10% off their first order, single-use.
- **Referrer:** $5 store credit once the friend's first order is completed. Credits stack, because each one is backed by a real purchase.
- **Partners:** their referred friends get the welcome discount (10%, or 15% through students). The partner earns 10% commission instead of the $5 credit.

## Open decisions

1. Window for the post-launch partner competition (Jul–Dec vs Sep–Dec).
2. Member referral reward structure (above).
3. Final $5k budget split.
