# Valstara — Pre-Launch Landing Page: Stack Decisions

**Version:** 2 (revised 25 August 2026)
**Supersedes:** v1 recommendation of a shared Next.js repo on Vercel
**Scope:** the 8–12 week pre-launch waitlist site only. Main-store decisions are locked in `valstara-locked-tech-decisions.md` and are not re-litigated here.
**Pricing:** verified August 2026.

---

## What changed in this revision

| Decision | v1 | v2 (current) | Why |
|---|---|---|---|
| Repository | Waitlist inside the storefront repo | **Separate repo** | Founder preference for clean separation. Accepted — see cost below. |
| Framework | Next.js App Router | **Astro** | Next.js only led because of component reuse. Decoupling removes that, so Astro's smaller payload and simpler model win outright. |
| Hosting | Vercel Pro, $20/mo | **Self-hosted on the existing VPS** (Cloudflare Pages as alternative) | Astro + Node adapter runs beside the waitlist service. Removes the last recurring hosting line. |
| Database | Separate DB, same Postgres instance | **Unchanged** — separate DB; same instance preferred, different host acceptable | Confirmation, not a change. |
| Launch transition | Delete route group, deploy | **DNS/host cutover + port trust pages** | Consequence of separate repos. |

**Net effect on cost:** 12-week recurring spend drops from $61/$177/$286 to roughly **$1 / $117 / $226** at 2k / 20k / 200k visitors.
**Net effect on effort:** unchanged during pre-launch; adds ~15–25 hours of component rebuild in the storefront later, plus a few hours porting trust-page markup.

---

## Recommended stack (v2)

| Component | Choice | 12-week cost |
|---|---|---|
| Framework | **Astro** with the Node adapter; API routes for signup / verify / referral | $0 |
| Interactive islands | Three only: signup form, theme toggle, leaderboard | $0 |
| Hosting | **Self-hosted on the existing €15 VPS**, Docker Compose, beside the waitlist service. Cloudflare Pages + Workers if you would rather not run it on the box. | $0 |
| Repository | Separate repo, e.g. `valstara-prelaunch` | $0 |
| Waitlist API | Astro API routes, or a small Node service if you prefer the split | $0 |
| Database | Separate `valstara_waitlist` Postgres 17 database — **never inside Medusa's** | $0 |
| DNS / CDN | Cloudflare (existing zone), proxied | $0 |
| Bot defence | Cloudflare Turnstile — free, unmetered; Article 5(3) basis is no device storage/access, with IP/TLS/UA processed server-side under Cloudflare's security-processor role | $0 |
| Transactional email | **Resend** on `send.valstara.com` | $0 → $60 |
| Broadcast email | **Brevo** on `mail.valstara.com` (+$9/mo to remove branding) | $0 → ~$165 |
| Analytics | **Umami self-hosted** + Cloudflare Web Analytics. No GA4, no consent banner. | $0 |
| Forms, survey, referral, fraud | Custom | $0 |
| Type | Instrument Sans + JetBrains Mono (OFL, self-hosted). Söhne deferred to store launch. | $0 |

Vercel is out of the pre-launch picture entirely. It returns at store launch for the Next.js storefront, as already locked.

---

## The four revised decisions in detail

### 1. Article 27 — what an EU representative actually is

**Historical decision, superseded for this campaign by ADR-029 on 2026-10-01.** The founder decided not to appoint EU or UK representatives. The analysis below records the earlier decision and does not control E9-03.

A **natural or legal person established in the EU**, designated in writing, acting as the contact point for supervisory authorities and data subjects. Key points:

- It is **not** a subsidiary and creates no taxable presence.
- In practice you buy it as a service — Prighter, DataRep, EDPO and similar, roughly **€200–500/year**.
- They must be established in a member state where your data subjects are.
- They hold a copy of your records of processing and must be **named in the privacy policy**.
- **UK GDPR requires a separate UK representative.** Two appointments, two fees.

This gates the privacy policy, which gates the first signup. Treat it as procurement, not engineering, and start it now.

### 2. Separate repository — accepted, with two carried costs

Clean separation is a reasonable call and the downside is bounded. What it costs:

- **~15–25 hours of component rebuild** in the storefront later — buttons, cards, inputs, theme handling, the country selector, the FAQ accordion. Unavoidable once the frameworks differ.
- **Trust and legal pages must be ported** into the storefront at launch so `/legit`, `/guarantee`, `/about`, `/terms`, `/privacy` keep their URLs and their accumulated authority. That is copy plus markup — a few hours, not a rewrite of the argument.

Mitigations worth doing from the first commit:

- Author the design tokens (colour, type scale, spacing, radii, motion timings) as a **plain CSS custom-property file** with no framework coupling. That file transfers to the storefront verbatim and is the single highest-value thing to keep portable.
- Write trust-page copy as **content files** (Markdown/MDX), not as JSX or Astro markup with prose inline. Porting content is then a copy operation.
- Keep the two repos consistent on tokens deliberately — if they drift during the campaign, the storefront inherits a subtly different brand.

### 3. Database — separate, and that was always the recommendation

The waitlist database is **its own database**, never tables inside Medusa's. That has not changed. The only open variable is where it sits:

| Placement | Launch-day import | Verdict |
|---|---|---|
| Same Postgres instance on the VPS | Local script, one connection away | **Preferred** — simplest, already backed up by pgBackRest |
| Different host you control | Network export/import; at a few thousand rows, trivial | Fine |
| Different provider (Neon, Supabase) | Same, plus an extra DPA, vendor and backup story | Only real cost — avoid without a reason |

Reasons not to write into Medusa's production database before launch, unchanged from v1: schema churn from `db:migrate`, auth-identity pollution, a public writer pointed at the commerce database months before hardening, and a model mismatch — referral edges, milestone state and fraud flags are not customer attributes.

**Launch-day handoff:** freeze waitlist writes → pgBackRest snapshot → idempotent import keyed on lowercased email → `createCustomersWorkflow` with metadata (`referral_tier`, `referral_code`, `confirmed_referrals`, `country`, `category_preference`, `access_window`, `source`, `subslush_customer`) → assign customer groups `wave-1..4` and `subslush-legacy`, because groups and not metadata are what promotions and price lists target → generate per-customer discount codes → keep the waitlist database read-only for 90 days as the audit trail. Rehearse twice against a scratch database.

### 4. Astro wins now

With the projects decoupled, the only argument for Next.js disappears. Astro gives a smaller payload, better Core Web Vitals headroom, and a simpler model for a page that is mostly static content with three interactive islands.

Practical shape:

- **Astro + Node adapter**, running in Docker Compose on the VPS next to Postgres and the waitlist logic.
- **API routes** for signup, verification, referral confirmation and survey submission — same origin, no CORS, no separate service unless you want one.
- **Cloudflare in front**, proxied, doing CDN, caching and Turnstile. This is not the "no Cloudflare proxy in front of Vercel" case; that rule is about Vercel, and Vercel is no longer involved.
- **Cache the leaderboard** at the edge or in-process. It is the only route that can generate real read volume during a spike.
- **Cloudflare Pages** is the alternative if you would rather not run the site on the box; the Astro code is portable between the two with an adapter swap.

Spike behaviour: static pages served through Cloudflare absorb a viral giveaway without a bill. The VPS only sees writes — around 30k signups on a peak day is nothing for Postgres. Load-test the signup endpoint at 10× expected peak anyway.

---

## Everything below is unchanged from v1

### Build vs buy — still build

No hosted tool covers more than half the requirement (trust pages, survey with write-back, geo-scoped giveaway eligibility, staggered access windows), and all of them ship countdown timers, position inflation and fake scarcity — behaviour the brand guidelines forbid. LaunchList sells "ranking inflation" as a feature.

Every buy option prices per lead or per participant, so **a successful giveaway taxes you monthly at exactly the moment cash is tightest**: Viral Loops steps $35 → $99 → $159 → $279 at 1k/5k/10k/25k participants; KickoffLabs $19 → $289. Net time saved by buying is only ~20–25 hours after integration and styling overrides — against $300–1,200 from a pot that also has to buy the prizes.

### Email — split providers

Rationale is **failure isolation**, not deliverability theory. Spam complaints happen on the marketing list; if verification email shares that reputation, new signups stop verifying and the funnel dies silently at the exact step you are measuring.

**Brevo prices by emails sent, not contacts stored** — the right model for a list that balloons to 20k+ names receiving ~6 emails each. About $29/mo at 20k emails with effectively unlimited contacts, versus roughly $150/mo on MailerLite for the same list. Add $9/mo to remove the "Sent by Brevo" footer.

**Listmonk + SES rejected:** saves ~$90 across the campaign in exchange for SES production-access risk, self-built bounce and complaint handling, suppression-list legal exposure, and a cold sending path — on the single most valuable send of the campaign.

### The SubSlush migration send

*(Superseded 2026-09-27 by ADR-028: the founder sends the announcement manually, and `subslush.com` is kept separate from Valstara's domain, DNS and email providers.)*

**Send it from `subslush.com`, not valstara.com.** That domain has history with these exact recipients, and a rebrand email from an unrecognised domain is indistinguishable from phishing — the one failure mode a trust-positioned brand cannot afford. Warm `send.valstara.com` in parallel on verification traffic: low volume, high engagement, near-zero complaints. SPF + DKIM per subdomain, DMARC `p=none` → `quarantine`. Stage the send by recency in batches, watching rates between them. Validate the ~100 addresses first (~$1).

### Analytics — cookieless, no consent banner

GA4 requires opt-in consent in Germany (no analytics exemption at all) and CNIL's French exemption is narrow and conditional. A banner costs conversion directly on a page targeting 20–35% signup — and corrupts the measurement it was added for, since consented GA4 only ever sees a self-selected subset. **Cookieless gives you better numbers here, not worse.** Add GA4 and a CMP at store launch, when ads and ecommerce attribution matter.

Referral attribution: capture `?ref=` **server-side** on the rendering request and carry it as a signed hidden field. More reliable than a cookie, and outside ePrivacy Article 5(3) entirely.

### Fraud — the structural answer

Confirm cheap rewards on verification; **hold high-value rewards (large discounts, extra draw entries) until the referred person completes a first order.** Fraud is economics, not detection.

Supporting layers, in order of value per hour: address normalisation before uniqueness checks (`+tags`, Gmail dots), disposable-domain blocklist plus MX check, self-referral and /24 velocity flags (flag, never auto-ban), manual review of the top 20 before awarding prizes.

**Skip device fingerprinting** — it requires consent under ePrivacy (banner, conversion loss), FingerprintJS licensing is ambiguous across versions, and Fingerprint Pro is ~$99/mo for a fraud class that reward-gating already makes unprofitable.

### Internationalisation — English only

No i18n framework. A reviewed six-language pass over 3–5k words of trust and legal copy is €500–2,000 — 10–40% of the entire marketing budget, spent on the throwaway artifact. Serve English at the **root**, not `/en/`, so adding `/de/` later is additive rather than a site-wide redirect. Astro's i18n routing is there when the store needs it.

Country selector: dropdown, pre-filled from geo-IP, always overridable. With Cloudflare proxying the site, use the free **`CF-IPCountry`** header. (The v1 note about `x-vercel-ip-country` no longer applies.) The field drives giveaway eligibility, the VAT story and the access wave — never let detection silently decide it. *(Superseded 2026-09-25 by ADR-026: no country is collected and the giveaway is one global draw under Hong Kong law.)*

### Fonts

Ship on Instrument Sans; buy Söhne at store launch. Klim web licences are perpetual and **tiered on traffic** — a viral spike pushes you past the tier you just bought. Build with `size-adjust` / `ascent-override` metric-matched fallbacks now so the swap is one line and a QA pass. **Always self-host WOFF2** — the Munich Google Fonts ruling makes the Google CDN a live liability in a named target market, and Klim's licence requires self-hosting regardless.

### Domain and SEO transition

Pre-launch site on the **root domain**. Build trust and legal pages at their **permanent URLs** (`/legit`, `/guarantee`, `/about`, `/terms`, `/privacy`) so they never move.

| Route | Pre-launch role | At launch |
|---|---|---|
| `/` | Waitlist landing page | Storefront home. Same URL, new content. |
| `/legit`, `/guarantee`, `/about` | Trust content | Port to storefront, same URLs |
| `/terms`, `/privacy` | Legal | Port and revise in place |
| `/giveaway/rules/*` | Per-jurisdiction rules *(superseded by ADR-026: one global page, public 12 months after the final award)* | Keep live for the statutory retention period, then `410` |
| `/waitlist`, `/leaderboard`, `/me` | Campaign mechanics | `301` to `/` and the account area |

With separate repos, launch is a **host cutover at the DNS/proxy layer** on `valstara.com`, not a deploy. Plan it as a checklist item with the trust-page port completed and verified beforehand.

**Trustpilot (amended by founder decision 2026-10-10):** claim the profile now and link to it; no widget or rating appears pre-launch. The widget may return with the storefront's consent management platform.

**llms.txt:** ship it, expect nothing. The largest study (~300k domains) found no correlation with citation frequency and Google says it does not use it. One hour of cheap insurance, not a channel.

---

## Cost model (v2)

| Line | 2k visitors | 20k visitors | 200k visitors |
|---|---|---|---|
| Hosting (VPS, existing capacity) | $0 | $0 | $0 |
| Cloudflare DNS / Turnstile / Web Analytics | $0 | $0 | $0 |
| Resend — transactional | $0 | $40 | $60 |
| Brevo — broadcast (+$9 unbranding) | $0 | $76 | ~$165 |
| Umami (self-hosted) | $0 | $0 | $0 |
| Fonts (OFL) | $0 | $0 | $0 |
| SubSlush list validation (one-off) | $1 | $1 | $1 |
| **Total, 12 weeks** | **$1** | **$117** | **~$226** |

**Free-tier cliffs to pre-empt:** Resend free is 100 emails/day; Brevo free is 300/day. Upgrade **before** the giveaway opens, not when the limits hit.

---

## Build estimate

Solo developer with AI assistance, working from finished copy and design direction. Unchanged in total by the framework switch.

| Feature | Full | Lean |
|---|---|---|
| Repo, tokens, type scale, theme toggle, primitives | 8–10 | 6 |
| Layout, nav, footer, hero, sections, responsive | 12–16 | 8 |
| Signup form, Turnstile, validation, country selector | 6 | 5 |
| Double opt-in (tokens, verify endpoint, templates) | 6 | 6 |
| Referral engine: codes, attribution, confirmation, milestones | 12–16 | 10 |
| Leaderboard, cached and anonymised | 4–6 | 2 |
| Fraud layer: normalisation, blocklist, velocity, flags | 8–10 | 5 |
| Preference survey + segment write-back | 6–8 | 3 |
| Member dashboard | 8 | 0 |
| Trust + legal pages (build only) | 8 | 8 |
| Giveaway eligibility gating, AMOE, rules pages | 6 | 4 |
| Email templates (6) + ESP sync | 8 | 6 |
| Analytics, event schema, UTM, Umami deploy | 6 | 3 |
| Admin: export, flag review | 6 | 1 |
| SEO, schema, sitemap, OG images, llms.txt | 5 | 3 |
| QA: cross-browser, a11y, load test, email rendering | 10 | 6 |
| **Total** | **~119–139 h** | **~76 h** |

Plus, deferred to store launch as a consequence of the separate repo: **~15–25 h** component rebuild and a few hours of trust-page porting.

---

## Cut list, in order

1. Internationalisation (already cut)
2. Admin UI → SQL and a CSV export script
3. Member dashboard page → signed status link in email
4. Public leaderboard → top-10 block in the weekly email (also removes the credibility exposure)
5. Survey as a separate step → two questions on the verification success page
6. Advanced fraud checks → keep normalisation, blocklist and self-referral; drop velocity anomaly detection
7. Milestone ladder beyond tier 1 → add the 5-referral tier mid-campaign

**Never cut:** signup form, double opt-in deliverability, referral attribution, trust pages, legal and giveaway rules pages, funnel analytics. If one of these is unfinished, delay the campaign rather than launch without it.

---

## Named risks

1. **The SubSlush migration send lands in spam** — highest impact, unrepeatable. Send from subslush.com, full authentication, staged batches, validate first. *(Superseded 2026-09-27 by ADR-028: a manual founder send outside the system.)*
2. **Verification email failure kills the funnel silently** — looks identical to poor conversion. Alert on verification *rate*; weekly seed tests into Gmail, Outlook, GMX and Web.de.
3. **GDPR exposure** — Article 27 EU representative plus a UK one, named in the privacy policy before the first signup. Exclude Italy, Poland, Spain, Quebec and the Nordics from the giveaway at point of entry (Italy: local data hosting and ministry notification; Poland: permits and bank guarantees; Spain: draw must occur in Spain plus 10% prize tax). *(Superseded 2026-09-25 by ADR-026: no country is collected and the giveaway is one global draw under Hong Kong law.)* The Article 27 representatives are unaffected and still required.
4. **Referral fraud discredits the leaderboard** — reputational, not financial. Reward-gate, review the top 20 manually, publish the disqualification rule.
5. **Free-tier cliffs** — upgrade email providers before the giveaway opens.
6. **Token drift between the two repos** — new in v2. If the pre-launch design system diverges during the campaign, the storefront inherits a subtly different brand. Keep tokens in one portable CSS file and treat it as canonical.
7. **Launch cutover on the root domain** — new in v2. A host swap is riskier than a deploy. Port the trust pages, verify on a staging host, and rehearse the cutover before launch day.
8. **Söhne licensing surprise** — Klim prices interactively at checkout; confirm before budgeting.

---

## First five actions

1. **DNS and email authentication today** — `send.` and `mail.` subdomains, SPF/DKIM/DMARC. The only item with a hard 12-week clock.
2. **Appoint EU and UK Article 27 representatives** — gates the privacy policy, which gates the first signup.
3. **Initialise `valstara-prelaunch`** — Astro, Node adapter, Docker Compose, and the portable token file.
4. **Stand up the waitlist database on the VPS**, schema designed against the Medusa import shape from day one.
5. **Write the trust pages** as content files — longest lead time, highest conversion value, and the only content that survives into the store.

---

## Least-certain figures

- **Söhne web licence** — Klim's buy page prices interactively and would not render a figure. The $60/style base tier comes from Klim's own pricing announcement; confirm at checkout. Least certain number here.
- **Brevo tiers above 100k emails/month** — interpolated between published points ($29 @ 20k, $55 @ 60k, $69 @ 100k; verified 5 Aug 2026).
- **FingerprintJS licence** — sources disagree between BSL and MIT across versions. Moot, since fingerprinting is not recommended.
- **Cloudflare Email Service** — outbound transactional now exists (API, SMTP, Workers binding) but is in beta, needs Workers Paid, and has undisclosed scaling quotas. Re-evaluate for the store in ~6 months.
