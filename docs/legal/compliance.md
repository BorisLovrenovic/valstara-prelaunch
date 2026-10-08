# Compliance

Status: authoritative for **what the code must do**. It is not legal advice. The founder authorised temporary draft wording for `/terms` and `/privacy` on 2026-10-01; reviewed replacement wording remains outstanding (ADR-029).

Three regimes bind this campaign: **GDPR/UK GDPR** on the data, **ePrivacy** on what may be stored on a visitor's device, and **Hong Kong law** on the giveaway. Valstara is incorporated in Hong Kong and runs one global giveaway under Hong Kong law; the founder accepts residual foreign promotion-law risk as a business cost (ADR-026, 2026-09-25). Data protection is **not** part of that trade-off: GDPR and UK GDPR apply in full to people in the EU and UK.

---

## 1. Article 27 founder decision

The founder decided on 2026-10-01 that Valstara will not appoint EU or UK Article 27 representatives for this pre-launch campaign (ADR-029, superseding ADR-019). The privacy notice therefore has no representative fields, and no representative-dependent build or signup gate exists. This records the decision; it does not establish an exemption from EU or UK law. The E11-05 privacy audit must record its assessment before launch.

---

## 2. Lawful basis and the record of processing

| Data | Purpose | Basis | Retention |
|---|---|---|---|
| Email address | Operating the waitlist the person joined: verification, status, referral and milestone updates, giveaway entry and winner notices, and the single launch-access notification the waitlist promises | **Contract** — providing the service requested, under the waitlist terms and giveaway rules (Art. 6(1)(b)) | Until handoff, erasure or leaving the waitlist |
| Email address, for **marketing** | The weekly update, product news, other broadcasts, and storefront marketing after handoff | **Consent** — a separate, optional, unticked opt-in, confirmed by the verification click (ADR-027) | Until withdrawal; withdrawal is recorded and never affects the waitlist place or giveaway entries |
| Marketing-consent record | Demonstrating consent | Legal obligation (Art. 7(1)) | While consent is relied on, plus the evidential period after withdrawal |
| Category preference | Launch segmentation | Consent (the survey is optional and skippable) | Until handoff or withdrawal |
| Referral edges | Running the referral mechanic | Contract | As above; anonymised on erasure |
| Giveaway entries | Running the draw under its rules | Contract | Draw records 6 years (see §4) |
| **Provisional winners' country of residence** | Sanctions check, regional availability of the digital goods, Canadian skill-testing question | Contract; legal obligation for the sanctions check | Collected **only from provisional winners, at award time**; 6 years with the award record, including on erasure under the exception below. **No postal address** — prizes are delivered electronically |
| UTM and source | Attribution | Legitimate interest | 12 months |
| **Truncated hashed IP prefix** | **Fraud prevention on a prize giveaway** | **Legitimate interest** | **90 days, purged daily** |
| Email delivery events | Deliverability and suppression | Legitimate interest / legal obligation | Campaign + statutory |

**No country or region is collected at signup** (ADR-026). The only location data the campaign holds is a provisional winner's country of residence, collected at award time.

**Joining and entering never depend on marketing consent** (ADR-027, GDPR Art. 7(4)). The ICO states in terms that consenting to a prize draw is not consenting to marketing. The signup form therefore carries a **separate, optional, unticked** marketing opt-in with versioned wording.

**The double opt-in proves ownership of the address in every case, and confirms marketing consent where it was given.** A ticked signup stores the wording version in `marketing_opt_in_pending_version` until verification; a later ticked submission while pending replaces that version. Verification copies it into the consent record and clears the pending fields in the same audited transaction. Every later withdrawal or re-grant is audited. That is what makes consent demonstrable rather than asserted.

**To confirm in the privacy audit (E11-05):** that the single launch-access notification is a message the person requested by joining the waitlist, not marketing.

**Withdrawal is one click** and is as easy as giving it. Every marketing mail carries an RFC 8058 one-click unsubscribe that withdraws marketing consent, and `/me` has a marketing on/off control. **Withdrawing marketing consent never removes a person from the waitlist or the giveaway.** Leaving the waitlist entirely is a separate, explicit action that suppresses all mail.

E6-06's email unsubscribe POST consumes a single-use signed token without Turnstile or JavaScript. `/me` offers a separate Turnstile-checked leave action using the reusable status token; explicit leave also changes a verified subscriber to `unsubscribed`, ending draw eligibility. Token consumption, consent withdrawal or global suppression, and its audit event commit together. On failure they all roll back, the link remains usable, and the person sees an honest retry message. A P1 operator-task alert carries the token hash and request action so it can be applied manually if the person does not retry (founder-authorised 2026-09-28).

**Erasure anonymises referral edges rather than dropping them.** The edge survives with its subject nulled, so counts stay defensible. Erasure leaves no personal data outside the documented award-record retention below. The reasoning is recorded here because it is the kind of decision a supervisory authority would ask about.

**Award-record retention exception (founder-authorised 2026-10-01, E9-05).** Erasure removes the email address and every other personal field for everyone, winners included, except the `giveaway_award` and `giveaway_award_candidate` records of anyone who reached the award stage. Those records remain unchanged for six years, including country of residence, age confirmation, check outcomes, substitution, values and timestamps. They reference only the opaque subscriber ID and never an email. The basis for this erasure exception is GDPR Art. 17(3)(b) for sanctions checks and Art. 17(3)(e) for legal claims. `/privacy` discloses the exception. Retained draw snapshot and selection rows keep only the opaque subscriber ID as the subject reference; nothing may link it back to a person after erasure. Retention does not authorise retaining an email or an identity mapping.

**Erasure and the draw (founder-authorised 2026-10-01).** Before snapshot commitment, erasure voids the subject's ledger entries so the snapshot excludes them. After commitment, the draw, snapshot rows and selection remain unchanged. An immutable, append-only void record stores the draw ID, opaque subscriber ID, reason `erasure`, void timestamp and actor. Exact reproduction and publication remain possible. An erased current provisional winner is replaced from the next unclaimed reserve; erased reserves are skipped. A confirmed or delivered award is never reassigned, and its retained award record remains intact. The provisional replacement updates the candidate outcome through the award workflow, not by scrubbing retained evidence. No rules revision is required: Section 9 already provides for the next reserve when a winner cannot receive the prize.

**Backups and processors (founder-authorised 2026-10-02).** Processing stops immediately; local erasure waits for Brevo confirmation and includes the suppression row; a later signup must complete double opt-in again. The only additions to the award-record retention exception are existing encrypted backups and processor delivery logs. pgBackRest backups are not modified and remain beyond use, never read for ordinary processing, until expiry through weekly-full rotation with `retention-full=2`. The disclosed window is **up to 30 days**. An append-only ledger stores only opaque subscriber ID and `erased_at`. Before a restored database serves traffic, the idempotent re-apply command must erase every ID from the newest available ledger. E12-04 owns its scheduled off-host copy; E9-05 owns the ledger, command and restore test.

Brevo's contact is deleted by `ext_id`, not merely unlinked from a list. Erasure is complete only after Brevo confirms deletion, with 404 treated as complete; bounded retries run for up to seven days, then raise a P1 operator task with only the opaque subscriber ID. Resend has no deletion call and its sending-only key is not widened. Both providers' delivery logs expire under processor retention. `/privacy` discloses limited provider delivery-log retention and backups expiring within 30 days. No further retention exception is authorised.


**Pending-erasure amendment (founder-authorised 2026-10-02; final provider-confirmation decision).** Processing stops at the signed confirmation commit. The audited request sets `erasure_pending`, excluding the subject from mail queueing and dispatch, Brevo upserts, the leaderboard, entry accrual, draw/award eligibility and `/me`. Local erasure waits for successful Brevo deletion or 404; the original subscriber row supplies `email_normalised`. No encrypted identifier or second email copy is created. The worker retries with exponential backoff capped at one hour for seven days, then raises P1 with only the opaque ID. The operator deletes the contact in the dashboard and uses the audited completion CLI. The hard deadline is 30 days from confirmation, with P1 re-alerts from day 28 and daily thereafter while unresolved. All time-dependent decisions inject a clock. The public promise is normally immediate completion and always within one month, with processing stopped at once. A failed local commit after provider deletion leaves the pending row recoverable: the repeated provider DELETE returns 404 and local fulfilment can complete atomically.

The six-year award retention, backup window of up to 30 days, and limited processor delivery-log retention remain unchanged. Live fulfilment removes suppression, and a later signup requires double opt-in again. The append-only erasure ledger and draw-void records contain no email. A restore must re-apply the newest ledger before traffic or outbound workers resume.

---

## 3. ePrivacy — why there is no banner

Article 5(3) applies to **storing information on, or accessing information already stored on, a visitor's device**. This site does neither for any non-essential purpose:

- **No analytics cookie or storage access.** Valstara's first-party page-view emitter sends a minimal payload to self-hosted Umami and suppresses the collector request's `Referer` header so URL query tokens are not sent. Umami's stock tracker is never served, so its `umami.disabled` browser-storage read does not run (founder-authorised 2026-10-05). The emitter reads or writes no cookie, Web Storage or IndexedDB. Cloudflare Web Analytics is cookieless.
- **No referral cookie.** `?ref=` is read **server-side on the rendering request** and carried as a signed hidden field — a mechanic that is both more reliable and entirely outside Article 5(3).
- **No site-run device fingerprinting API.** The site invokes no canvas, font-enumeration, WebGL or timing-entropy API. Cloudflare's server-side security processing is disclosed separately below.
- **No third-party script** on any page, except two sanctioned exceptions: the deliberately-flagged Trustpilot widget, which stays off until a rating is worth showing, and Cloudflare Turnstile on the signup, verification-recovery and member marketing-preference forms (ADR-006, S-01). The no-banner basis for Turnstile is specifically Article 5(3): the rendered-page probe confirms that it neither stores information on nor accesses information already stored on the visitor's device. Both exceptions are enforced by the third-party-request CI gate's allowlist; nothing else off-origin loads.
- **One storage write exists**: the theme preference. Functional, non-identifying, and documented in the inventory embedded in `/privacy` and the standalone inventory at `/privacy/storage`. The privacy notice links to that page; its one entry is tested against the storage-gate allowlist and the source write.

**This is not a shortcut.** GA4 requires opt-in consent in Germany with no analytics exemption at all, and CNIL's French exemption is narrow and conditional. A banner on a page targeting 20–35% signup costs conversion directly **and corrupts the measurement it was added for**, since consented analytics only ever sees a self-selected subset. **Cookieless gives better numbers here, not worse.** GA4 and a CMP return at store launch, when ads and ecommerce attribution justify the cost.

**The three CI gates in `docs/security/threat-model.md#ci-security-gates` are what keep this true.** Without them it is an intention.

### Cloudflare Turnstile processor disclosure

**LEGAL SIGN-OFF REQUIRED before this becomes customer-visible privacy-policy copy.** The site runs no device-fingerprinting API. For bot and abuse prevention, Cloudflare processes the visitor's **IP**, **TLS** connection characteristics and **user-agent** server-side in its role as Valstara's security processor. The Article 5(3) no-banner basis is limited to the probe-confirmed absence of device storage/access; it does not claim that Cloudflare processes no security signals.

---

## 4. Giveaway — one global draw under Hong Kong law

**Founder decision, 2026-09-25 (ADR-026, superseding ADR-018).** The promoter is the Hong Kong company. The giveaway is governed by Hong Kong law, runs as a single global draw, and **excludes no country at entry**. No Hong Kong Trade Promotion Competition Licence is required for this free-entry draw (founder determination, 2026-09-25).

**The rules the draw is built to:**

| Rule | What it means in practice |
|---|---|
| **No purchase necessary** | The ordinary verified signup is the free entry route. Entry never requires a purchase, a referral or marketing consent. The signup call to action links to the current rules page while the giveaway is open. Each base or referral ledger row is exactly one entry, enforced by a database check constraint; E7-05 verifies equal weight in the draw |
| **18 or over** | Stated on the signup form and in the rules; confirmed with each provisional winner at award time |
| **One registration per natural person** | One base entry on verification, plus entries for unique referred people who themselves verify. Multiple identities, self-referral and automation are grounds for disqualification |
| **One prize per person** | Once a person is selected, their remaining entries leave the pool for later selections |
| **Small prizes** | Each prize **≤ €449** approximate retail value; the total pool **below US$5,000**, checked at a conservative euro-to-dollar rate recorded in the rules content. Values are stated in euros. **Current prize (P4, 2026-09-25): 5 Valstara product bundles at €300 each, €1,500 in total** |
| **Honest odds** | Each eligible entry has equal weight; a person's odds are their eligible entries divided by all eligible entries when entries close, subject to one prize per person |
| **Taxes and delivery** | Winners pay any local taxes on their prize. Prizes are digital goods delivered electronically, at no cost to the winner |
| **Award-time checks** | Only provisional winners give their **country of residence** (no postal address): for a **sanctions check** against a configured list, which may be empty until the founder adds it (a winner in a listed jurisdiction is replaced from the reserve list), for regional availability of the products (an unavailable product follows the substitution rule), and so a winner resident in **Canada** answers a skill-testing question |
| **Substitution** | Bundle first; if a product in it is unavailable at award time, the winner picks replacement products so the bundle keeps at least its stated retail value; if the winner wants no replacement, the promoter pays that unavailable product's retail value in cash, as a last resort. Used only when a product becomes unavailable for reasons outside the promoter's control |
| **Bundle contents** | May be "to be announced": the page then states the prize by value and promises the products will be listed before the draw. Never dummy products on the public page; the draw refuses to run until they are listed |

E7-06 uses a founder-approved repository catalog for each product's retail value and regional availability. The published 14-day response deadline covers only the Section 9 age, residence and Canadian skill checks. Passing them confirms the award. An unavailable item opens a separate substitution offer with a configured 14-day deadline from its recorded offer time. A catalog-validated replacement keeps the stated bundle value; explicit decline or no choice by that deadline settles cash for the unavailable item only. Substitution never forfeits the confirmed award. The provisional winner form uses a status token and Cloudflare Turnstile; the same processor disclosure and no-storage probe apply to this form.

**One rules page, at `/giveaway/rules`.** It carries these sections: eligibility (age, one person, excluded persons) · entry methods including the free route and how referral entries work · the entry period in UTC · the draw date and method · the odds basis · the prize description, approximate retail value and substitution clause · taxes and delivery · award-time verification (age, sanctions, country of residence with no postal address, the Canadian skill-testing question, and the response deadline) · the disqualification rule · winner publicity · governing law (Hong Kong) · the promoter's identity. Every published version is immutable at `/giveaway/rules/<rules_version>` and is stored with a SHA-256 of its rendered content.

E7-02 publishes the approved P4 text from `src/content/giveaway-rules/VAL-GW-LAUNCH-20260925-r1.md`. Its structured prize data records a conservative conversion assumption of **US$2 per €1**, so the €1,500 pool is checked as US$3,000. The SHA-256 covers the exact rendered rules article served at the revision's permanent URL; the current URL serves the latest revision. Changing published prose without changing the version fails the build.

**Contact revision, founder-authorised 2026-10-01.** `VAL-GW-LAUNCH-20261001-r1` replaces the SubSlush contact addresses with support@valstara.com and is the current revision. `VAL-GW-LAUNCH-20260925-r1` remains unchanged at its permanent URL. Each revision has its own rendered-content SHA-256; the append-only history check guards both after publication.

**Why the prize limits are what they are.** Staying at €449 or less per prize and below US$5,000 in total keeps several foreign regimes from being triggered at all: the Netherlands' gaming-tax line, the New York and Florida registration thresholds, and Austria's duty exemption. They are the zero-cost risk reduction that goes with accepting foreign promotion-law risk.

**Winner publicity is minimal.** Information showing a valid award took place (for example first name and initial of the surname) is published or made available only to the extent needed. Any photograph, testimonial or likeness needs separate, optional permission and is never a condition of the prize.

**Accepted risk, recorded so it is not forgotten.** Some countries regulate or prohibit free chance draws open to their residents; the P4 research (`docs/prerequisites/`) found, for example, that Belgium prohibits them and that Portugal, Italy, Spain and Poland require authorisation or charge prize taxes. A Hong Kong governing-law clause does not remove a consumer's mandatory home-country protections. The founder accepts this for a one-time, pre-launch campaign.

**Retention.** The current rules page stays public for 12 months after the final award. Every rules version, the entry snapshot, seed, reserve list and award records are kept internally for 6 years. Neither period is presented as a statutory requirement; both are Valstara policy.

---

## 5. Marketing consent and the SubSlush list

The ~100 SubSlush addresses are **existing customers of the predecessor business**. The founder sends the announcement manually under that relationship, outside the Valstara system and its email providers (ADR-028). It **asks them to opt in to the Valstara list rather than assuming it**: a recipient joins only by signing up through the normal double opt-in. The SubSlush list is never imported.

That is a stricter reading than the soft-opt-in rules of some jurisdictions require. It is the right one for a brand whose entire proposition is trustworthiness, and it costs perhaps a few dozen addresses.

---

## 6. Accessibility

The EU Accessibility Act applies to the store, not straightforwardly to a pre-launch page — but the standard is met anyway: **WCAG 2.2 AA**, verified by an automated pass in CI and a manual audit before the campaign opens (E11-03). It is cheaper to build than to retrofit, and the same components are being ported into the storefront where it will apply.

E11-03's local audit evidence, including the completed spoken screen-reader pass, is recorded in `docs/testing/e11-03-accessibility-audit.md`. The signup result and form-level error receive focus when they replace the focused submit control.
