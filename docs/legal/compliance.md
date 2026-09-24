# Compliance

Status: authoritative for **what the code must do**. It is not legal advice, and the reviewed wording of the policy, terms and rules pages is a founder input from qualified counsel.

Three regimes bind this campaign: **GDPR/UK GDPR** on the data, **ePrivacy** on what may be stored on a visitor's device, and **Hong Kong law** on the giveaway. Valstara is incorporated in Hong Kong and runs one global giveaway under Hong Kong law; the founder accepts residual foreign promotion-law risk as a business cost (ADR-026, 2026-09-25). Data protection is **not** part of that trade-off: GDPR and UK GDPR apply in full to people in the EU and UK.

---

## 1. Article 27 representatives — the hard gate

An Article 27 representative is a **natural or legal person established in the EU**, designated in writing, acting as the contact point for supervisory authorities and data subjects.

- It is **not** a subsidiary and creates **no taxable presence**.
- Bought as a service — Prighter, DataRep, EDPO and similar — at roughly **€200–500/year**.
- Must be established in a member state where the data subjects are.
- Holds a copy of the records of processing and **must be named in the privacy policy**.
- **UK GDPR requires a separate UK representative.** Two appointments, two fees.

**This gates the privacy policy, which gates the first signup.** It is procurement, not engineering, and it has the longest lead time of any prerequisite — which is why the build enforces it: `E9-03` adds a **build-time assertion that neither representative field is a placeholder**, and the signup route is unreachable while that assertion fails. A checklist item would have been forgotten; a failing build cannot be.

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
| **Provisional winners' country of residence** | Sanctions check, regional availability of the digital goods, Canadian skill-testing question | Contract; legal obligation for the sanctions check | Collected **only from provisional winners, at award time**; 6 years with the award record, or longer if tax law requires. **No postal address** — prizes are delivered electronically |
| UTM and source | Attribution | Legitimate interest | 12 months |
| **Truncated hashed IP prefix** | **Fraud prevention on a prize giveaway** | **Legitimate interest** | **90 days, purged daily** |
| Email delivery events | Deliverability and suppression | Legitimate interest / legal obligation | Campaign + statutory |

**No country or region is collected at signup** (ADR-026). The only location data the campaign holds is a provisional winner's country of residence, collected at award time.

**Joining and entering never depend on marketing consent** (ADR-027, GDPR Art. 7(4)). The ICO states in terms that consenting to a prize draw is not consenting to marketing. The signup form therefore carries a **separate, optional, unticked** marketing opt-in with versioned wording.

**The double opt-in proves ownership of the address in every case, and confirms marketing consent where it was given.** The marketing-consent record holds the wording version, the source (`signup` or `member_status`), the request, the confirming verification, and every later withdrawal or re-grant as an audited event. That is what makes consent demonstrable rather than asserted.

**To confirm in the privacy audit (E11-05):** that the single launch-access notification is a message the person requested by joining the waitlist, not marketing.

**Withdrawal is one click** and is as easy as giving it. Every marketing mail carries an RFC 8058 one-click unsubscribe that withdraws marketing consent, and `/me` has a marketing on/off control. **Withdrawing marketing consent never removes a person from the waitlist or the giveaway.** Leaving the waitlist entirely is a separate, explicit action that suppresses all mail.

**Erasure anonymises referral edges rather than dropping them.** The edge survives with its subject nulled, so counts stay defensible and no personal data remains. The reasoning is recorded here because it is the kind of decision a supervisory authority would ask about.

---

## 3. ePrivacy — why there is no banner

Article 5(3) applies to **storing information on, or accessing information already stored on, a visitor's device**. This site does neither for any non-essential purpose:

- **No analytics cookie.** Umami and Cloudflare Web Analytics are cookieless.
- **No referral cookie.** `?ref=` is read **server-side on the rendering request** and carried as a signed hidden field — a mechanic that is both more reliable and entirely outside Article 5(3).
- **No site-run device fingerprinting API.** The site invokes no canvas, font-enumeration, WebGL or timing-entropy API. Cloudflare's server-side security processing is disclosed separately below.
- **No third-party script** on any page, except two sanctioned exceptions: the deliberately-flagged Trustpilot widget, which stays off until a rating is worth showing, and Cloudflare Turnstile on the signup and verification-recovery forms (ADR-006). The no-banner basis for Turnstile is specifically Article 5(3): the rendered-page probe confirms that it neither stores information on nor accesses information already stored on the visitor's device. Both exceptions are enforced by the third-party-request CI gate's allowlist; nothing else off-origin loads.
- **One storage write exists**: the theme preference. Functional, non-identifying, and documented in the cookie and storage inventory.

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
| **No purchase necessary** | The ordinary verified signup is the free entry route. Entry never requires a purchase, a referral or marketing consent. Every entry carries equal weight |
| **18 or over** | Stated on the signup form and in the rules; confirmed with each provisional winner at award time |
| **One registration per natural person** | One base entry on verification, plus entries for unique referred people who themselves verify. Multiple identities, self-referral and automation are grounds for disqualification |
| **One prize per person** | Once a person is selected, their remaining entries leave the pool for later selections |
| **Small prizes** | Each prize **≤ €449** approximate retail value; the total pool **below US$5,000**, checked at a conservative euro-to-dollar rate recorded in the rules content. Values are stated in euros. **Current prize (P4, 2026-09-25): 5 Valstara product bundles at €300 each, €1,500 in total** |
| **Honest odds** | Each eligible entry has equal weight; a person's odds are their eligible entries divided by all eligible entries when entries close, subject to one prize per person |
| **Taxes and delivery** | Winners pay any local taxes on their prize. Prizes are digital goods delivered electronically, at no cost to the winner |
| **Award-time checks** | Only provisional winners give their **country of residence** (no postal address): for a **sanctions check** against a configured list, which may be empty until the founder adds it (a winner in a listed jurisdiction is replaced from the reserve list), for regional availability of the products (an unavailable product follows the substitution rule), and so a winner resident in **Canada** answers a skill-testing question |
| **Substitution** | Bundle first; if a product in it is unavailable at award time, the winner picks replacement products so the bundle keeps at least its stated retail value; if the winner wants no replacement, the promoter pays that unavailable product's retail value in cash, as a last resort. Used only when a product becomes unavailable for reasons outside the promoter's control |
| **Bundle contents** | May be "to be announced": the page then states the prize by value and promises the products will be listed before the draw. Never dummy products on the public page; the draw refuses to run until they are listed |

**One rules page, at `/giveaway/rules`.** It carries these sections: eligibility (age, one person, excluded persons) · entry methods including the free route and how referral entries work · the entry period in UTC · the draw date and method · the odds basis · the prize description, approximate retail value and substitution clause · taxes and delivery · award-time verification (age, sanctions, address, the Canadian skill-testing question, and the response deadline) · the disqualification rule · winner publicity · governing law (Hong Kong) · the promoter's identity. Every published version is immutable at `/giveaway/rules/<rules_version>` and is stored with a SHA-256 of its rendered content.

**Why the prize limits are what they are.** Staying at €449 or less per prize and below US$5,000 in total keeps several foreign regimes from being triggered at all: the Netherlands' gaming-tax line, the New York and Florida registration thresholds, and Austria's duty exemption. They are the zero-cost risk reduction that goes with accepting foreign promotion-law risk.

**Winner publicity is minimal.** Information showing a valid award took place (for example first name and initial of the surname) is published or made available only to the extent needed. Any photograph, testimonial or likeness needs separate, optional permission and is never a condition of the prize.

**Accepted risk, recorded so it is not forgotten.** Some countries regulate or prohibit free chance draws open to their residents; the P4 research (`docs/prerequisites/`) found, for example, that Belgium prohibits them and that Portugal, Italy, Spain and Poland require authorisation or charge prize taxes. A Hong Kong governing-law clause does not remove a consumer's mandatory home-country protections. The founder accepts this for a one-time, pre-launch campaign.

**Retention.** The current rules page stays public for 12 months after the final award. Every rules version, the entry snapshot, seed, reserve list and award records are kept internally for 6 years. Neither period is presented as a statutory requirement; both are Valstara policy.

---

## 5. Marketing consent and the SubSlush list

The ~100 SubSlush addresses are **existing customers of the predecessor business**. The migration announcement is sent under that relationship, from `subslush.com`, and it **asks them to opt in to the Valstara list rather than assuming it**. An address that does not opt in is not migrated.

That is a stricter reading than the soft-opt-in rules of some jurisdictions require. It is the right one for a brand whose entire proposition is trustworthiness, and it costs perhaps a few dozen addresses.

---

## 6. Accessibility

The EU Accessibility Act applies to the store, not straightforwardly to a pre-launch page — but the standard is met anyway: **WCAG 2.2 AA**, verified by an automated pass in CI and a manual audit before the campaign opens (E11-03). It is cheaper to build than to retrofit, and the same components are being ported into the storefront where it will apply.
