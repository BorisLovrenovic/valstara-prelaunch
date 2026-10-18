# Founder prerequisites — action list

**Purpose.** These are the items **no coding agent can complete** — procurement, external configuration, founder decisions, and counsel-reviewed text. Each one gates a part of the build, and work stops at a `BLOCKED:` report until the prerequisite is satisfied. This document is the founder-facing companion to §2 of the development plan: it explains, in full, *what* each item needs, *why*, *how to do it*, and *how the build confirms it is done*.

> **Source of truth.** `docs/plan/development-plan.md` §2 remains authoritative. This file adds context and instructions; it does not change the plan. When an item here is completed, the build enforces it automatically — several are wired to fail the build or make a route unreachable until real values are present, precisely so they cannot be forgotten.

---

## Status at a glance

| # | Item | Status | Gates | Do by |
|---|------|--------|-------|-------|
| **P1** | DNS records + email authentication | ✅ Satisfied 2026-09-27 | —; E8 unblocked | Done |
| **P2** | EU + UK Article 27 representatives | Waived by founder 2026-10-01 (ADR-029) | No representative gate | Done |
| **P4** | Giveaway prize + final text of the one global rules page (Hong Kong law) | ✅ Supplied 2026-09-25 | Publishing E7-02's page | Done |
| **P5** | Upgrade Resend + Brevo past free tiers | 🔴 Partially evidenced; still outstanding | Turning `giveaway.open` on | Before E7 exit |
| **P7** | The four seed mailboxes (Gmail, Outlook.com, GMX, Web.de) | 🔴 Outstanding | E12-07: the first live seed run and the rendering check | Before E12 |
| **P3b** | Trust-page prose (`/legit`, `/guarantee`, `/about`) | ✅ Supplied 2026-09-30; E9-02 published it | E9-02 | Done |
| **P6** | Provision the production VPS | ⚪ Deferred (by design) | Epic E12 | Before E12 |
| **P3a** | Brand token values | ✅ Satisfied | — | Done |

**P1 is complete; sender-reputation warming continues through E11-08/E12-07. P2 is waived by the founder under ADR-029. P3b is complete: the final copy is in `docs/prerequisites/p3b-trust-pages-copy.md` and the three content files.**

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

- **Status:** Waived by founder decision on 2026-10-01 (ADR-029).
- **Decision:** Valstara will not appoint an EU or UK Article 27 representative for the pre-launch campaign.
- **Engineering effect:** E9-03 has no representative fields, build assertion or representative-dependent signup gate.
- **Legal text:** The founder authorised temporary draft `/terms` and `/privacy` text. Reviewed replacement wording remains outstanding; the E11-05 legal finding was waived by the founder on 2026-10-18 in ADR-030.

### Source docs
`docs/plan/development-plan.md` §2 (P2), E9-03 · `docs/legal/compliance.md#1` · `docs/architecture/adr/029-no-article-27-representatives.md`

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
| Contacts | support@valstara.com for every enquiry (founder decision 2026-10-01; replaced the subslush.com addresses) |
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

- **Status:** Waived by founder decision on 2026-10-01 (ADR-029).
- **Decision:** Valstara will not appoint an EU or UK Article 27 representative for the pre-launch campaign.
- **Engineering effect:** E9-03 has no representative fields, build assertion or representative-dependent signup gate.
- **Legal text:** The founder authorised temporary draft `/terms` and `/privacy` text. Reviewed replacement wording remains outstanding; the E11-05 legal finding was waived by the founder on 2026-10-18 in ADR-030.

### Source docs
`docs/plan/development-plan.md` §2 (P2), E9-03 · `docs/legal/compliance.md#1` · `docs/architecture/adr/029-no-article-27-representatives.md`

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
| Contacts | support@valstara.com for every enquiry (founder decision 2026-10-01; replaced the subslush.com addresses) |
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

- **Status:** 🔴 Partially evidenced; still outstanding
- **Nature:** Purchase
- **Gates:** Turning `giveaway.open` **on** (E7 exit).
- **Deadline:** **Before the giveaway opens — not when the limits are hit.** Upgrading reactively means dropped mail at the worst possible moment.

### Account evidence received 2026-10-18

The founder transcribed the Resend account dashboard and checked Brevo's Starter checkout/plan page on 2026-10-18; no account screenshot or billing record is stored in the repository. Brevo Starter has not been purchased or activated:

| Provider and use | Account plan shown | Account limits supplied | Remaining verification |
|---|---|---|---|
| Resend transactional | Pro | 50,000 sends/month, renewing October 24; daily limit shown as unlimited; 10 requests/second. Resend Marketing remains Free and is not the broadcast provider. | Founder set `RESEND_DAILY_CAP=1600` on 2026-10-18 as an internal alert threshold: 50,000 ÷ 30 ≈ 1,667, rounded down. This is not a provider daily limit. |
| Brevo broadcast | Starter package, not yet purchased | The founder checked the 5,000 sends/month, no-daily-limit paid plan on 2026-10-18. This is a prospective allowance, not an active account limit. | Founder replaced the earlier ÷ 30 rule on 2026-10-18: the target `BREVO_DAILY_CAP=1000` is 5,000 ÷ 5, allowing one full-list send on each of at most five weekly broadcast days per month. This is an internal alert threshold, not a provider daily limit. Purchase and verify the plan before completing P5. |

Neither `RESEND_TIER` nor `BREVO_TIER` has been changed in the local configuration. The planned paid caps of 1,600 and 1,000 both pass the unchanged free-cap floor, but P5 remains open because Brevo has not been purchased. After purchase, verify the active allowance and set and check both tiers and caps; `giveaway.open` remains off meanwhile. The founder intends an initial consented audience below 1,000 and a staged upgrade as it grows. The requested 80%-of-capacity P2 alert is separate work requiring its own ticket and plan amendment; it is not active in this gate.

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

- **Status:** ✅ Supplied 2026-09-30 in `docs/prerequisites/p3b-trust-pages-copy.md` and published by E9-02 in `src/content/legit.md`, `src/content/guarantee.md` and `src/content/about.md`.
- **Nature:** Founder input, from the brand and store documentation
- **Gates:** E9-02, now complete.
- **Deadline:** Met before E9.

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

## P7 — The four seed mailboxes

- **Status:** 🔴 Outstanding
- **Nature:** Account setup (free)
- **Gates:** E12-07 — the first live seed run and the manual rendering check.
- **Deadline:** Before E12.

### Why this matters
Seed tests guard against the campaign's most dangerous silent failure: verification mail that stops arriving. They mail inboxes Valstara controls and record whether each message lands in the inbox or in spam, per provider. That needs one real mailbox at each of the four providers the plan names: Gmail, Outlook, GMX and Web.de. Apple Mail is an email app, not a provider, so it needs no seed mailbox. It is used only to view messages for the rendering check.

### Exactly what to do
1. **Create one new mailbox each** at Gmail, Outlook.com, GMX and Web.de. Use them for seed tests and nothing else: no newsletters and no personal mail, so each provider's filtering reflects a fresh recipient.
2. **Enable IMAP access** in each account's settings, where the provider requires it.
3. **Set up sign-in the seed harness can use:** an app password or OAuth, whichever the provider requires for IMAP. **Outlook.com allows IMAP only through OAuth**, not a password.
4. **Keep the credentials in your password manager.** They move into the production secret manager at E12. Never commit them or put them in a local `.env`.
5. **For the E12-07 rendering check**, have Apple Mail on a Mac signed in to one of the seed mailboxes.

### How the build confirms it
E8-04 builds the weekly seed harness and proves it against simulated mailboxes. **Nothing is sent and no seed mailbox is used**, because live sending keys stay off local machines until E12-07. At E12-07 the production host sends the first live seed test and delivers every transactional template to these mailboxes. You then check by hand how each one looks in Gmail, Outlook, Apple Mail, GMX and Web.de. From then on, the weekly harness records inbox-versus-spam placement (founder-authorised 2026-09-29).

### Source docs
`docs/plan/development-plan.md` §2 (P7), E12-07, E8-04 · `docs/architecture/fallbacks.md#the-two-silent-failures`

---

## P3a — Brand token values ✅

- **Status:** ✅ **Satisfied.** Locked in `docs/brand/identity-guidelines.md` §5 (colour) and §6 (typography). Nothing to do.

---

## When you complete an item

1. Complete the item as described above (and, where relevant, hand over the exact values — representative details, approved rules text and `rules_version`, etc.).
2. Update the **Status at a glance** row here.
3. Tell the tech lead which prerequisite is done — they will confirm what it unblocks and point the agent at the next buildable ticket. The build's own gates (health checks, build-time assertions, campaign-open sequencing) then confirm it end to end.
