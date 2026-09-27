# Founder prerequisites — action list

**Purpose.** These are the items **no coding agent can complete** — procurement, external configuration, founder decisions, and counsel-reviewed text. Each one gates a part of the build, and work stops at a `BLOCKED:` report until the prerequisite is satisfied. This document is the founder-facing companion to §2 of the development plan: it explains, in full, *what* each item needs, *why*, *how to do it*, and *how the build confirms it is done*.

> **Source of truth.** `docs/plan/development-plan.md` §2 remains authoritative. This file adds context and instructions; it does not change the plan. When an item here is completed, the build enforces it automatically — several are wired to fail the build or make a route unreachable until real values are present, precisely so they cannot be forgotten.

---

## Status at a glance

| # | Item | Status | Gates | Do by |
|---|------|--------|-------|-------|
| **P1** | DNS records + email authentication | ✅ Satisfied 2026-09-27 | —; E8 unblocked | Done |
| **P2** | EU + UK Article 27 representatives | 🔴 Outstanding | Privacy policy → **the first signup** | **Today — longest lead time** |
| **P4** | Giveaway prize + final text of the one global rules page (Hong Kong law) | ✅ Supplied 2026-09-25 | Publishing E7-02's page | Done |
| **P5** | Upgrade Resend + Brevo past free tiers | 🔴 Outstanding | Turning `giveaway.open` on | Before E7 exit |
| **P3b** | Trust-page prose (`/legit`, `/guarantee`, `/about`) | 🔴 Outstanding | E9-02 | Before E9 |
| **P6** | Provision the production VPS | ⚪ Deferred (by design) | Epic E12 | Before E12 |
| **P3a** | Brand token values | ✅ Satisfied | — | Done |

**P1 is complete; sender-reputation warming continues through E11-08/E12-07. P2 remains urgent because nothing can go live until it exists.**

---

## P1 — DNS records and email authentication

- **Status:** ✅ **Satisfied 2026-09-27.** SPF, DKIM and DMARC `p=none` are published for both Valstara sending domains; Resend and Brevo each report their domain as verified.
- **Nature:** DNS/configuration (founder + domain registrar + ESP dashboards)
- **Gates:** None remaining. Epic E8 and E6-06 are unblocked.
- **Follow-up:** Sender-reputation warming continues and is evidenced at E11-08/E12-07.

### Why this matters
The campaign sends from **two providers across two sending domains**, deliberately isolated so neither provider's reputation can damage the other's:

| Sending domain | Provider | Role | Plan ref |
|----------------|----------|------|----------|
| `send.valstara.com` | **Resend** | Transactional mail (verification, welcome, status, receipts) | E8-02 |
| `mail.valstara.com` | **Brevo** | Broadcast / weekly mail | E8-05 |

Every one of these must pass **SPF, DKIM, and DMARC** or mail lands in spam — fatal for a double-opt-in campaign whose entire honesty model rests on verification emails arriving.

### Exactly what to do
1. **Create the subdomains.** At the DNS host for `valstara.com`, create `send.valstara.com` and `mail.valstara.com`. `subslush.com` is out of scope: it is kept separate from Valstara, and the SubSlush announcement is sent manually (ADR-028).
2. **Get the exact records from each ESP.** Do **not** hand-write DKIM — the values are provider-generated:
   - In the **Resend** dashboard, add `send.valstara.com` as a domain. Resend gives you the exact SPF (TXT), DKIM (CNAME/TXT) and return-path records to publish.
   - In the **Brevo** dashboard, add `mail.valstara.com` as a sending domain. Brevo gives you its own SPF/DKIM records.
3. **Publish every record** at the DNS host exactly as provided, for both domains.
4. **Set DMARC to `p=none` to start** on each domain — a TXT record at `_dmarc.<domain>` (e.g. `v=DMARC1; p=none; rua=mailto:<your-reporting-address>`). `p=none` is monitoring mode; it lets you collect reports and confirm alignment before tightening later. This matches the plan's stated `p=none` baseline.
5. **Verify in each dashboard.** Wait for propagation, then confirm Resend and Brevo both report each domain as **verified / authenticated**.
6. **Continue warming.** Start sending at low volume and ramp over the weeks; the reputation curve remains a campaign-open concern.

### How the build confirms it
- **E8-02** verifies SPF, DKIM and DMARC for `send.valstara.com` as a **startup/health check**, surfaced on the admin health view — not a one-time manual step.
- **Campaign-open sequencing gate #2** (`docs/engineering/ci-cd.md`): *"SPF, DKIM and DMARC verify on every sending domain, and the seed test round-trips"* before the public DNS record points at the site.

### Source docs
`docs/plan/development-plan.md` §2 (P1) and Epic E8 · `docs/modules/email.md` · `docs/architecture/adr/009-split-email-providers.md` · `docs/architecture/adr/028-subslush-announcement-sent-manually.md` · `docs/engineering/ci-cd.md#campaign-open-sequencing`

---

## P2 — EU and UK Article 27 representatives

- **Status:** 🔴 Outstanding
- **Nature:** Procurement (~€200–500/year **each** — two appointments, two fees)
- **Gates:** The **privacy policy**, which gates **the first signup**. While either representative field is a placeholder, the build fails and the signup route is unreachable.
- **Deadline:** **Start today.** Procurement has the longest lead time of any prerequisite.

### Why this matters
An Article 27 representative is a **natural or legal person established in the EU**, designated in writing as the contact point for supervisory authorities and data subjects. Key facts:
- It is **not** a subsidiary and creates **no taxable presence**.
- Bought as a service — providers include **Prighter, DataRep, EDPO** and similar.
- Must be established in a member state where the data subjects are.
- Holds a copy of the records of processing and **must be named in the privacy policy**.
- **UK GDPR requires a separate UK representative** — so you need **two**: one EU, one UK.

The plan makes this a *hard build gate* rather than a checklist because a checklist item gets forgotten and a missing representative is a live legal exposure the moment the first person signs up.

### Exactly what to do
1. **Choose a provider** (Prighter, DataRep, EDPO, or comparable) offering both EU and UK Article 27 representation.
2. **Purchase both appointments** — EU representative and UK representative.
3. **Obtain the designated details for each**: the representative's **legal name**, **full address**, and the **contact route** (email/postal) that must appear in the privacy policy.
4. **Provide those details** so they can be placed into the privacy/terms content files (consumed by E9-03). These replace the placeholder fields the build currently rejects.
5. **File your records of processing** with each representative as their service requires.

### How the build confirms it
- **E9-03** adds a **build-time assertion that neither the EU nor the UK representative field is a placeholder**; the assertion is fixture-proven, and **the signup route is unreachable while it fails**.
- **Campaign-open sequencing gate #1:** *"The privacy policy names both representatives, and the build-time assertion for it passes."*

### Source docs
`docs/plan/development-plan.md` §2 (P2), E9-03 · `docs/legal/compliance.md#1` · `docs/architecture/adr/019-article-27-representatives.md`

---

## P4 — Giveaway prize and the global rules-page text

- **Status:** ✅ **Supplied 2026-09-25.** The rules text is approved in `docs/prerequisites/p4-rules-page-draft.md`.
- **Nature:** Founder input. One global rules page under Hong Kong law, with no per-country rules, exclusions or local review (ADR-026).
- **Gates:** nothing any more. Two follow-ups remain, and neither blocks anything (see below).

### What was supplied (2026-09-25)
| Item | Value |
|---|---|
| Prize | **5 × Valstara product bundle, approximate retail value €300 each — €1,500 in total** |
| Bundle contents | **Not chosen yet — deliberately not a blocker.** The page states the prize by value and promises the products will be listed before the draw. Dummy products are used only in test fixtures; the draw refuses to run until the real contents are listed |
| Substitution | Bundle first. If a product is unavailable at award time, the winner chooses replacement products so the bundle keeps at least €300 of retail value. If the winner wants no replacement, the promoter pays that product's retail value in cash, as a last resort |
| Entry period | Opens 00:00 UTC 1 October 2026 (or when the waitlist goes live, if later); closes 23:59:59 UTC 1 March 2027 |
| Draw date | 1 April 2027 |
| Winner deadlines | Notified within 7 days of the draw; 14 days to reply |
| Promoter | **3NITY DIGITAL LIMITED**, Business Registration No. 79886556, Unit B, 12/F, Hang Seng Causeway Bay Building, 28 Yee Wo Street, Causeway Bay, Hong Kong |
| Contacts | Customer support: hello@subslush.com · Legal and payment enquiries: compliance@subslush.com |
| Sanctions list | **Not set yet — deliberately not a blocker.** Configuration that may be empty; add it before the first award (April 2027) |

### Still to supply (neither is a blocker)
1. *Before the draw on 1 April 2027:* the bundle contents. The draw refuses to run until they are listed.
2. *Before the first award:* the sanctioned-jurisdiction list, matched to what your payment provider and bank require.

### How the build confirms it
- **E8-02** verifies SPF, DKIM and DMARC for `send.valstara.com` as a **startup/health check**, surfaced on the admin health view — not a one-time manual step.
- **Campaign-open sequencing gate #2** (`docs/engineering/ci-cd.md`): *"SPF, DKIM and DMARC verify on every sending domain, and the seed test round-trips"* before the public DNS record points at the site.

### Source docs
`docs/plan/development-plan.md` §2 (P1) and Epic E8 · `docs/modules/email.md` · `docs/architecture/adr/009-split-email-providers.md` · `docs/architecture/adr/028-subslush-announcement-sent-manually.md` · `docs/engineering/ci-cd.md#campaign-open-sequencing`

---

## P2 — EU and UK Article 27 representatives

- **Status:** 🔴 Outstanding
- **Nature:** Procurement (~€200–500/year **each** — two appointments, two fees)
- **Gates:** The **privacy policy**, which gates **the first signup**. While either representative field is a placeholder, the build fails and the signup route is unreachable.
- **Deadline:** **Start today.** Procurement has the longest lead time of any prerequisite.

### Why this matters
An Article 27 representative is a **natural or legal person established in the EU**, designated in writing as the contact point for supervisory authorities and data subjects. Key facts:
- It is **not** a subsidiary and creates **no taxable presence**.
- Bought as a service — providers include **Prighter, DataRep, EDPO** and similar.
- Must be established in a member state where the data subjects are.
- Holds a copy of the records of processing and **must be named in the privacy policy**.
- **UK GDPR requires a separate UK representative** — so you need **two**: one EU, one UK.

The plan makes this a *hard build gate* rather than a checklist because a checklist item gets forgotten and a missing representative is a live legal exposure the moment the first person signs up.

### Exactly what to do
1. **Choose a provider** (Prighter, DataRep, EDPO, or comparable) offering both EU and UK Article 27 representation.
2. **Purchase both appointments** — EU representative and UK representative.
3. **Obtain the designated details for each**: the representative's **legal name**, **full address**, and the **contact route** (email/postal) that must appear in the privacy policy.
4. **Provide those details** so they can be placed into the privacy/terms content files (consumed by E9-03). These replace the placeholder fields the build currently rejects.
5. **File your records of processing** with each representative as their service requires.

### How the build confirms it
- **E9-03** adds a **build-time assertion that neither the EU nor the UK representative field is a placeholder**; the assertion is fixture-proven, and **the signup route is unreachable while it fails**.
- **Campaign-open sequencing gate #1:** *"The privacy policy names both representatives, and the build-time assertion for it passes."*

### Source docs
`docs/plan/development-plan.md` §2 (P2), E9-03 · `docs/legal/compliance.md#1` · `docs/architecture/adr/019-article-27-representatives.md`

---

## P4 — Giveaway prize and the global rules-page text

- **Status:** ✅ **Supplied 2026-09-25.** The rules text is approved in `docs/prerequisites/p4-rules-page-draft.md`.
- **Nature:** Founder input. One global rules page under Hong Kong law, with no per-country rules, exclusions or local review (ADR-026).
- **Gates:** nothing any more. Two follow-ups remain, and neither blocks anything (see below).

### What was supplied (2026-09-25)
| Item | Value |
|---|---|
| Prize | **5 × Valstara product bundle, approximate retail value €300 each — €1,500 in total** |
| Bundle contents | **Not chosen yet — deliberately not a blocker.** The page states the prize by value and promises the products will be listed before the draw. Dummy products are used only in test fixtures; the draw refuses to run until the real contents are listed |
| Substitution | Bundle first. If a product is unavailable at award time, the winner chooses replacement products so the bundle keeps at least €300 of retail value. If the winner wants no replacement, the promoter pays that product's retail value in cash, as a last resort |
| Entry period | Opens 00:00 UTC 1 October 2026 (or when the waitlist goes live, if later); closes 23:59:59 UTC 1 March 2027 |
| Draw date | 1 April 2027 |
| Winner deadlines | Notified within 7 days of the draw; 14 days to reply |
| Promoter | **3NITY DIGITAL LIMITED**, Business Registration No. 79886556, Unit B, 12/F, Hang Seng Causeway Bay Building, 28 Yee Wo Street, Causeway Bay, Hong Kong |
| Contacts | Customer support: hello@subslush.com · Legal and payment enquiries: compliance@subslush.com |
| Sanctions list | **Not set yet — deliberately not a blocker.** Configuration that may be empty; add it before the first award (April 2027) |

### Still to supply
1. **The company's registered name**, exactly as on the Business Registration Certificate.
2. *(Before the draw on 1 April 2027, not blocking now)* the bundle contents.
3. *(Before the first award, not blocking now)* the sanctioned-jurisdiction list, matched to what your payment provider and bank require.

### How the build confirms it
- E7-02 publishes the text in `docs/prerequisites/p4-rules-page-draft.md`, schema-validates every section, fails the build on a placeholder (such as a missing promoter name) or on a prize above the limits, and publishes each revision immutably with its SHA-256.
- E7-05 refuses to run the draw while the bundle contents are still "to be announced".

### Source docs
`docs/prerequisites/p4-rules-page-draft.md` · `docs/architecture/adr/026-global-giveaway-hong-kong-law.md` · `docs/plan/development-plan.md` §2 (P4) and Epic E7 · `docs/legal/compliance.md#4`

---

## P5 — Upgrade Resend and Brevo past the free tiers

- **Status:** 🔴 Outstanding
- **Nature:** Purchase
- **Gates:** Turning `giveaway.open` **on** (E7 exit).
- **Deadline:** **Before the giveaway opens — not when the limits are hit.** Upgrading reactively means dropped mail at the worst possible moment.

### Why this matters
Free-tier caps are **Resend 100/day** and **Brevo 300/day**. A viral signup spike will blow through these instantly, and once mail starts failing during a launch there is no recovery. The caps are treated as configuration, not hard-coded assumptions, so the upgrade is purely a purchasing action on your accounts.

### Exactly what to do
1. **Upgrade the Resend plan** to a tier whose daily/volume allowance covers the expected transactional load (verification + lifecycle mail) with headroom.
2. **Upgrade the Brevo plan** to a tier covering the broadcast list with headroom.
3. **Install live API keys on the production host only** — never a sandbox key in production, and no live key in the repository or any developer environment.
4. Confirm the configured daily-cap values reflect the new tiers.

### How the build confirms it
- **Campaign-open sequencing gate #3:** *"The ESP tiers are upgraded past the free caps before `giveaway.open` is turned on."*
- **E8-02** config validation asserts **a sandbox key cannot be present in production**.
- `quotaProjection()` alerts at a week's headroom against the configured caps.

### Source docs
`docs/plan/development-plan.md` §2 (P5) · `docs/modules/email.md` (quota rules) · `docs/engineering/ci-cd.md#campaign-open-sequencing`

---

## P3b — Trust-page prose

- **Status:** 🔴 Outstanding
- **Nature:** Founder input, from the brand and store documentation
- **Gates:** E9-02.
- **Deadline:** Before E9.

### Why this matters
`/legit`, `/guarantee`, and `/about` are the pages that carry the brand's entire trust proposition. **A page shell with placeholder text is explicitly not a deliverable** — the agent will not build these on stubs, because empty trust pages undercut the one thing the brand is selling.

### Exactly what to do
1. **Write the real, final copy** for each of `/legit`, `/guarantee`, and `/about`, drawn from your brand and store documentation.
2. **Deliver it as content** so the pages can be built from content files (the content-pipeline pattern already used elsewhere — no prose inline in markup).

### How the build confirms it
- **E9-02** builds these pages from content files; without the real prose, the ticket reports `BLOCKED:` rather than shipping placeholders.

### Source docs
`docs/plan/development-plan.md` §2 (P3b), E9-02

---

## P6 — Provision the production VPS

- **Status:** ⚪ Deferred by design — **no action needed yet**
- **Nature:** Purchase and provisioning
- **Gates:** Epic E12 (the final infrastructure/cutover epic).
- **Deadline:** Before E12.

### Context
By founder decision (2026-08-27), the entire site is **built and verified locally first**, and the host is **provisioned once, at the end**. Nothing before E12 requires it. There is deliberately nothing to do here until the build reaches E12 — this item is listed only so it is not forgotten at cutover.

### Source docs
`docs/plan/development-plan.md` §2 (P6), Epic E12

---

## P3a — Brand token values ✅

- **Status:** ✅ **Satisfied.** Locked in `docs/brand/identity-guidelines.md` §5 (colour) and §6 (typography). Nothing to do.

---

## When you complete an item

1. Complete the item as described above (and, where relevant, hand over the exact values — representative details, approved rules text and `rules_version`, etc.).
2. Update the **Status at a glance** row here.
3. Tell the tech lead which prerequisite is done — they will confirm what it unblocks and point the agent at the next buildable ticket. The build's own gates (health checks, build-time assertions, campaign-open sequencing) then confirm it end to end.
