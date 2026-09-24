> **Historical — superseded 2026-09-25.** This brief produced two research reports that informed ADR-026 and ADR-027. The founder then chose one global giveaway under Hong Kong law, with no per-country rules, exclusions or local review. Don't use this brief to scope new work: see `docs/architecture/adr/026-global-giveaway-hong-kong-law.md` and `docs/prerequisites/founder-prerequisites.md#p4`.

# Research brief — P4: Giveaway prize, entry rules, and rules-page content

> **How to use this file.** This is a self-contained prompt for a research agent. It carries all the context the agent needs; it does not assume access to the codebase. Paste the whole thing to the research agent. The output is a **decision-support dossier** that lets the founder make P4 decisions and hand a tight, well-scoped brief to qualified promotion-law counsel. **It is not a substitute for legal advice** — its job is to make counsel's time short and precise, and to give the founder defensible defaults.

---

## 1. Your role and objective

You are a senior research analyst specialising in **prize-promotion / sweepstakes law and marketing operations across the EU, UK and Canada**. Produce a comprehensive, evidence-backed dossier on the "P4" prerequisite for a pre-launch waitlist giveaway (details below). For **every requirement**, provide (a) the factual/legal position with **concrete data, figures, thresholds and statistics**, (b) **primary-source citations**, and (c) a **clearly labelled recommended decision** with rationale, confidence level, and the specific point at which counsel sign-off is still required.

Optimise for **decisions the founder can act on** and for **shrinking the counsel bill** — surface the exact questions only a lawyer can answer, pre-researched, rather than leaving them open.

---

## 2. Project context (everything you need to know)

**The business.** "Valstara" is launching a consumer e-commerce brand. Before the storefront opens it is running a **pre-launch waitlist** with a **referral mechanic** and a **prize giveaway** to build a verified email list. The brand's entire positioning is **trustworthiness** — so every mechanic must be squeaky-clean, non-manipulative, and legally defensible. There is a predecessor business, "SubSlush", with ~100 existing customers who will be invited to opt in.

**How the giveaway works (fixed mechanics — research the law around these, do not redesign them):**
- A visitor lands, optionally via a **referral link**, and signs up with email + country (and, for Canada only, province/region).
- Signup uses **double opt-in**: the entry only counts after the person clicks a verification link. **Nothing counts an unverified subscriber.**
- **Entries accrue** as: one **base entry on verification**, plus **entries per confirmed referral** (a referred person who themselves verifies).
- There is a **free Alternative Method of Entry (AMOE)**: entry with **no referral and no purchase required**, carrying **equal weight** to an earned entry.
- Referral rewards (separate from the draw prize) are **anti-fraud gated**: cheap rewards settle on verification; high-value rewards are **held until a post-launch first purchase**. *(This is background — P4 concerns the DRAW PRIZE, not referral rewards.)*
- At draw time, entries are snapshotted, hashed, a seed is recorded, and winners are selected **deterministically and reproducibly**; the draw is **auditable and re-runnable from its seed**. Selection is **proportional to entries**.
- Winners are notified; the **award is recorded against the entry snapshot** that produced it; a **prize-substitution path** exists for when a prize is unavailable at award time.

**Data & privacy posture (already decided):**
- Governed by **GDPR / UK GDPR** and **ePrivacy**. Lawful basis for the email/country data is **consent** (the double opt-in *is* the consent record).
- **No cookies, no device fingerprinting, no third-party trackers.** Country is detected from an IP-country header but is always user-overridable.
- **EU and UK Article 27 representatives** are being appointed separately (that is prerequisite P2).
- Truncated, hashed IP prefixes are stored for fraud prevention (legitimate interest, 90-day retention).

**Geographic scope:**
- **In scope (target markets):** the **EU** (with specific exclusions below), the **UK**, and **Canada** (with Quebec excluded). **Germany is a named, important target market.** Confirm and, if warranted, recommend adjustments to this scope.
- **Excluded at point of entry (already decided; your job is to validate and, if needed, challenge these):**
  | Excluded jurisdiction | Stated reason |
  |---|---|
  | **Italy** | Local data hosting + a ministry notification required for promotional draws |
  | **Poland** | Permits and bank guarantees |
  | **Spain** | Draw must occur in Spain + ~10% prize tax |
  | **Nordics** — Denmark, Finland, Iceland, Norway, Sweden | Restrictive promotion regimes |
  | **Quebec** | Its own promotion regime distinct from the rest of Canada (the reason Canada collects province) |
- The USA is **not currently in scope** — assess whether it should be, but treat inclusion as a significant added-complexity decision.

**The content P4 must produce (this is the deliverable P4 gates):**
1. The **prize** — its description and value, and a **substitution clause**.
2. The **per-jurisdiction entry rules**.
3. **Counsel-reviewed rules-page text** for each non-excluded jurisdiction, at `/giveaway/rules/<jurisdiction>`. Each page must carry **all** of these required sections:
   - Eligibility
   - Entry methods, **including AMOE**
   - The entry period
   - The draw date and method
   - The odds basis
   - The prize description **and substitution clause**
   - The disqualification rule
   - The promoter's identity
   *(A jurisdiction without a complete, published rules page is simply excluded — no generic page is ever served.)*
4. A **`rules_version`** identifier that is stamped onto every entry at accrual and is retained even when the rules later change.

**The campaign runs on a ~12-week clock.** Rules pages must stay live for the statutory retention period after the campaign, then be retired.

---

## 3. Research tasks

For **each** task below, deliver: the factual/legal findings **with numbers**, primary-source citations, and a **Recommended decision** block. Where a task spans multiple jurisdictions, give a **comparison table**.

### A. Prize selection, value and structure
- Survey **typical prize types and values** for pre-launch / waitlist / referral giveaways in DTC e-commerce. Provide **statistics**: benchmark prize values, single-grand-prize vs multiple-winner structures, and any available **data on how prize type/value affects signup conversion and referral rates**.
- Analyse the trade-off between a **cash/cash-equivalent prize** vs an **own-product bundle / store credit** vs a **third-party high-value item** — for legal simplicity, deliverability, tax, and brand fit (a trust-first brand).
- Identify how **prize value crosses regulatory thresholds** (e.g., where higher value triggers registration, bonding, notification, or tax duties) in the in-scope jurisdictions — with the **specific monetary thresholds**.
- Cover the **substitution clause**: standard market wording patterns, when substitution is legally permissible, and cash-alternative expectations.
- **Recommended decision:** a specific prize type, value band, winner count, and substitution approach, chosen to minimise cross-jurisdiction legal friction while maximising conversion for a trust-brand. State the value ceiling that keeps the promotion in the simplest regulatory tier across all in-scope markets.

### B. Jurisdictional eligibility and the exclusion list
- For **each in-scope jurisdiction** (EU member states not excluded, UK, Canada ex-Quebec) and **each excluded one**, document the applicable **prize-promotion / lottery / sweepstakes regime**: is a free-entry prize draw permitted without a licence? What are the **registration/notification/bonding requirements, costs (in €/£/C$), and lead times**?
- **Validate the exclusion list**: confirm each stated reason with primary sources, quantify the burden (e.g., Spain's exact prize-tax rate and mechanism, Italy's *manifestazione a premio* notification cost/timeline and the local-hosting requirement, Poland's permit + bank-guarantee figures, each Nordic country's specific restriction, Quebec's *Régie*/RACJ requirements, fees and French-language obligations). **Flag any jurisdiction that is over- or under-excluded.**
- Research **standard eligibility terms**: minimum age (per jurisdiction — note where it is 18 vs other), residency, exclusion of employees/immediate family, one-entry-per-person norms, and how these interact with a referral mechanic.
- Assess whether a **single multi-jurisdiction rules page** is viable or whether **per-country pages** are legally necessary, and where **language requirements** apply (e.g., French for Quebec, German for Germany).
- **Recommended decision:** the final eligibility ruleset (age, residency, exclusions), the confirmed in/out jurisdiction list, and a per-jurisdiction plan for rules-page localisation.

### C. The eight required rules-page sections
For **each** required section, research the **legally expected content and standard market wording**, citing the relevant codes/regulators (e.g., UK **CAP Code** rules on promotions and the **ASA**; EU consumer-protection and unfair-commercial-practices rules; Canadian Competition Act contest requirements). For each section provide: what must be stated, common pitfalls, and a **recommended template clause**.
1. **Eligibility** — see task B.
2. **Entry methods incl. AMOE** — see task D.
3. **Entry period** — how start/end must be expressed, time-zone handling, and rules on changing/extending a live promotion.
4. **Draw date and method** — disclosure requirements for a randomised, reproducible draw; whether/how the "verifiable random selection" method should be described publicly.
5. **Odds basis** — how odds must be expressed when entries are variable (referral-driven), and the compliant way to state "odds depend on number of entries received".
6. **Prize description + substitution clause** — see task A.
7. **Disqualification rule** — lawful grounds for disqualification (fraud, ineligibility, multiple accounts), and how to word it so it is enforceable and fair; note this must be **published** to be enforceable.
8. **Promoter's identity** — what promoter details must be disclosed (legal entity name, address, contact), and how this interacts with the Article 27 representative disclosure.
- **Recommended decision:** a section-by-section **drafting checklist / skeleton** counsel can finalise, with recommended default wording for each.

### D. AMOE — the free alternate entry route
- Explain the **legal function of AMOE** in the in-scope jurisdictions: where a "no purchase / no consideration necessary" free route is legally required to keep a prize draw from being an unlawful lottery, and where the referral-as-consideration question actually bites (referrals may count as "consideration" or unfair inducement in some regimes).
- Research **equal-dignity / equal-weight requirements** — the rule that the free route must carry the same chance as the paid/earned route — and how that has been enforced (cite decisions/guidance).
- Compare **AMOE mechanisms** (web form, email, postal) for friction, fraud-resistance, and legal sufficiency.
- **Recommended decision:** the AMOE mechanism to implement, its exact eligibility parity with earned entries, and where it must be linked/disclosed.

### E. `rules_version` scheme
- Recommend a **versioning convention** for the rules (e.g., semantic vs date-based), and document the legal expectation that **entrants are bound by the version in force when they entered**, and that **mid-campaign rules changes** are handled by publishing both versions and preserving earlier entries' version.
- **Recommended decision:** the exact `rules_version` format and the change-management rule (what triggers a new version, how a live change is communicated).

### F. Cross-cutting compliance
- **Tax:** per jurisdiction, who bears prize tax, withholding obligations, reporting thresholds, and the figures (this drove the Spain exclusion — quantify it and check others).
- **Winner announcement & data protection:** what winner data may lawfully be published, consent for using a winner's name/likeness, and GDPR-compliant winner handling.
- **Data & consent:** confirm the giveaway's consent model (double opt-in) satisfies entry-consent requirements, and whether separate consent for the promotion vs marketing is needed.
- **Record-keeping & audit:** statutory retention periods for promotion records and rules pages per jurisdiction (the campaign plans to keep rules pages live for the statutory retention period, then retire them — supply the actual periods).
- **Recommended decision:** a compliance checklist (tax handling, winner publicity wording, retention periods) with per-jurisdiction figures.

---

## 4. Data and statistics required (coverage checklist)

The dossier must include, at minimum, **concrete numbers** for:
- [ ] Benchmark prize values and winner-count structures for comparable DTC waitlist/referral giveaways.
- [ ] Any available conversion/referral-lift statistics tied to prize type and value.
- [ ] Per-jurisdiction **registration/notification/permit/bonding costs** (€/£/C$) and **lead times** (days/weeks).
- [ ] **Prize-value regulatory thresholds** per jurisdiction (the value at which a heavier regime kicks in).
- [ ] **Prize-tax rates and withholding thresholds** per jurisdiction.
- [ ] **Minimum-age** requirements per jurisdiction.
- [ ] **Language-requirement** triggers (Quebec French, Germany German, others).
- [ ] **Statutory record/rules-page retention periods** per jurisdiction.
- [ ] Counsel-engagement cost/time benchmarks for reviewing a multi-jurisdiction prize-draw ruleset (to budget the P4 review).

Where a figure is unavailable or uncertain, **say so explicitly** and give a sourced best estimate with a range.

---

## 5. Output format

Produce a single structured dossier:

1. **Executive summary** (≤1 page): the recommended prize, the confirmed jurisdiction list, and the top 5 decisions, each in one line.
2. **A consolidated recommended-decisions table**: Requirement | Recommended decision | Confidence (High/Med/Low) | Key figure(s) | Counsel sign-off still needed? (Y/N + what).
3. **Per-task sections A–F** as above, each ending with a boxed **Recommended decision**.
4. **A ready-to-send counsel brief** (appendix): the exact list of questions only a lawyer should answer, pre-loaded with your findings so counsel confirms rather than researches from scratch.
5. **A jurisdiction comparison matrix** (rows = jurisdictions in and out of scope; columns = permitted?, registration cost, lead time, prize-value threshold, tax, min age, language, retention period, notes).
6. **Sources**: numbered, with primary/official sources (regulators, statutes, official guidance) clearly distinguished from secondary commentary. Prefer official and recent (flag anything older than ~3 years).

---

## 6. Standards and constraints

- **Cite primary sources** (regulators, statutes, official guidance) wherever a legal claim is made; do not rely on a single blog. Distinguish **law** from **marketing best practice**.
- **Flag uncertainty and recency** — promotion law changes; note the date of each key source and any pending reform.
- **This is not legal advice.** Mark every point where qualified counsel must give final sign-off; the goal is to make that review fast and cheap, not to replace it.
- **Apply the trust-brand lens throughout:** recommend the option that is cleanest and most transparent, never the one that merely maximises entries through friction or ambiguity. No dark patterns, no manufactured scarcity, no misleading odds framing.
- When two options are close, **make a call and justify it** — the founder wants a recommended decision, not a menu.
