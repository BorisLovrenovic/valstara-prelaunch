# Compliance

Status: authoritative for **what the code must do**. It is not legal advice, and the reviewed wording of the policy, terms and rules pages is a founder input from qualified counsel.

Three regimes bind this campaign: **GDPR/UK GDPR** on the data, **ePrivacy** on what may be stored on a visitor's device, and **national promotion law** on the giveaway.

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
| Email address | Operating the waitlist; the launch announcement | Consent (the double opt-in **is** the consent record) | Until handoff or withdrawal |
| Country, region | Giveaway eligibility, VAT story, access wave | Consent | As above |
| Category preference | Launch segmentation | Consent | As above |
| Referral edges | Running the referral mechanic | Consent | As above; anonymised on erasure |
| UTM and source | Attribution | Legitimate interest | 12 months |
| **Truncated hashed IP prefix** | **Fraud prevention on a prize giveaway** | **Legitimate interest** | **90 days, purged daily** |
| Email delivery events | Deliverability and suppression | Legitimate interest / legal obligation | Campaign + statutory |

**The double opt-in is the consent record**: timestamp, the token that was consumed, and the address it was sent to. That is what makes consent demonstrable rather than asserted.

**Withdrawal is one click** and is as easy as giving it — RFC 8058 one-click unsubscribe in every mail, plus the page.

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

## 4. Giveaway — jurisdiction exclusions

Excluded **at point of entry**, from the confirmed country, and for Canada from the province:

| Jurisdiction | Reason |
|---|---|
| **Italy** | Local data hosting and a ministry notification are required for promotional draws |
| **Poland** | Permits and bank guarantees |
| **Spain** | The draw must occur in Spain, plus a 10% prize tax |
| **Nordics** (Denmark, Finland, Iceland, Norway, Sweden) | Restrictive promotion regimes |
| **Quebec** | Its own regime, distinct from the rest of Canada — **which is why Canada is the one country where a region is collected** |

**An excluded visitor still joins the waitlist.** The giveaway declines, the reason is stated plainly at that point, and nothing else about their signup changes.

**Every remaining jurisdiction has a rules page** at `/giveaway/rules/*` carrying: eligibility, entry methods **including AMOE**, the entry period, the draw date and method, odds basis, prize description and **substitution clause**, the disqualification rule, and the promoter's identity. **A jurisdiction without a published rules page is excluded** — never served a generic page.

Rules pages stay live for the statutory retention period after the campaign, then return `410`.

---

## 5. Marketing consent and the SubSlush list

The ~100 SubSlush addresses are **existing customers of the predecessor business**. The migration announcement is sent under that relationship, from `subslush.com`, and it **asks them to opt in to the Valstara list rather than assuming it**. An address that does not opt in is not migrated.

That is a stricter reading than the soft-opt-in rules of some jurisdictions require. It is the right one for a brand whose entire proposition is trustworthiness, and it costs perhaps a few dozen addresses.

---

## 6. Accessibility

The EU Accessibility Act applies to the store, not straightforwardly to a pre-launch page — but the standard is met anyway: **WCAG 2.2 AA**, verified by an automated pass in CI and a manual audit before the campaign opens (E11-03). It is cheaper to build than to retrofit, and the same components are being ported into the storefront where it will apply.
