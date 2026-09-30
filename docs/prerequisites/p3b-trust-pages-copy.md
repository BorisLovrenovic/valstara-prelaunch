# P3b — Trust-page copy for /legit, /guarantee and /about

> **Status:** final copy, written 2026-09-30 for the founder prerequisite P3b. E9-02 transcribes it into content files under `src/content/`. Nothing on the pages below is a placeholder.
>
> **How to read this file.** Each page has its metadata, then the page copy exactly as it should ship, then numbered source notes. Every factual claim on a page has a note saying where it is written down. A claim without a source does not go on the page, and if you edit the copy, keep it that way.
>
> The wording avoids every term in `scripts/forbidden-copy.json` and follows the voice rules in `docs/brand/copy-rules.md`.

## Decisions applied to this copy

**Promise II wording (founder decision, 2026-09-30).** The brand guidelines, section 2.1, gave promise II as "Your data is never shared or sold." That is not strictly true, because email addresses have to reach the email providers (Resend and Brevo) for mail to be delivered, and `docs/brand/copy-rules.md` forbids the "never share" claim for exactly that reason. The promise now reads "Your data is never sold." The guidelines were amended to the same wording on 2026-10-01 with the founder's authorisation, so the two documents agree.

**Contact address, founder name and SubSlush (founder decision, 2026-10-01).** Every contact route on these pages and in the current giveaway rules is support@valstara.com. The founder is named as Boris Lovrenovic. The historical giveaway rules revision remains available at its permanent URL with its original contact addresses; current pre-launch copy makes no mention of SubSlush.

**No dependency on E9-03 or E9-08 (founder decision, 2026-10-01).** E9-02 ships this copy without waiting for either ticket. The representatives paragraph on /legit states the rule the build enforces instead of pointing at a privacy notice that does not exist yet. The Trustpilot paragraph says only that no rating is shown, so the profile link stays in E9-08's scope. /guarantee no longer refers to the privacy notice.

**Warranty cover per category (founder decision, 2026-09-30).** The brand guidelines, section 2.4, require warranty cover to be stated for each category and never as "varies". No per-category terms exist yet. The pre-launch /guarantee page therefore shows the three promises and the price commitment only, and says that per-category terms will be published when the store opens. The section 2.4 rule applies in full from store launch.

---

## /legit

**Title:** Who runs Valstara
**Description:** Valstara is a trading brand of 3NITY Digital Limited, registered in Hong Kong. Our company details, how to reach us, and how to check us for yourself.

### Page copy

# Who runs Valstara

Valstara was founded by Boris Lovrenovic and is a trading brand of 3NITY Digital Limited, a company registered in Hong Kong. Valstara is the name you see on this site and in the emails we send you. 3NITY Digital Limited is the company behind it. It runs this waitlist and the launch giveaway, it is responsible for the personal data you give us, and it will be the seller when the store opens.

This page sets out the company's details, how to reach us, and the records you can check without relying on anything we say about ourselves.

## Company details

| | |
|---|---|
| Registered name | 3NITY DIGITAL LIMITED |
| Business Registration No. | 79886556 |
| Registered address | Unit B, 12/F, Hang Seng Causeway Bay Building, 28 Yee Wo Street, Causeway Bay, Hong Kong |
| Place of registration | Hong Kong |

## Checking us for yourself

Every limited company in Hong Kong is entered on the public register kept by the Hong Kong Companies Registry. You can search that register for 3NITY DIGITAL LIMITED and compare what it shows with the details above. The company's Business Registration No. is 79886556, the number shown on the Business Registration Certificate that the Hong Kong Inland Revenue Department issues to every business operating in Hong Kong. If anything differs, please tell us, and treat the difference as a reason for caution until we have explained it.

The same company details appear in section 1 of the official rules for our launch giveaway, published at valstara.com/giveaway/rules. Every version of those rules stays online at its own permanent address, so no change to them can happen quietly.

Before we accept a single signup, we appoint representatives for data protection in the European Union and in the United Kingdom, and we name them in our privacy notice. They act as our point of contact in those regions, both for you and for data protection authorities.

## Reviews

We do not show a Trustpilot star rating on this site yet. A score built on a handful of reviews tells you very little, so we will display ours once enough customers have reviewed us for the number to mean something. We will never buy reviews.

## How to reach us

Write to support@valstara.com with any question about Valstara, the waitlist or the giveaway. The same address handles legal matters, payment enquiries and requests to review a decision we have made about you.

The emails we send you about the waitlist also come from addresses on valstara.com.

## What this site does with your visit

This site sets no tracking cookies and runs no advertising trackers, which is why you will not see a cookie banner. There is nothing to ask your consent for. The only thing it stores on your device is your choice of light or dark theme.

### Source notes

1. That Valstara was founded by Boris Lovrenovic comes from the founder's instruction of 2026-10-01, recorded under "Decisions applied" above. That Valstara is a trading brand of 3NITY Digital Limited, registered in Hong Kong, comes from the brand guidelines, section 1.1 and the legal footer in section 3.4. The guidelines keep the entity name to places where it is legally required. This page names it anyway, because the question the page answers cannot be answered without it.
2. That the company runs the waitlist and the giveaway comes from the approved giveaway rules, section 1 (`docs/prerequisites/p4-rules-page-draft.md`), and `docs/legal/compliance.md`, section 4. That it is responsible for the personal data comes from `docs/legal/compliance.md`, sections 1 and 2, where the Hong Kong company appoints Article 27 representatives as the controller established outside the EU and UK. That it will be the seller comes from the brand guidelines, sections 1.4 and 1.7.
3. The registered name, Business Registration No. 79886556 and the registered address come from the founder's P4 submission of 2026-09-25 in `docs/prerequisites/founder-prerequisites.md`, and match section 1 of the published giveaway rules (`src/content/giveaway-rules/VAL-GW-LAUNCH-20260925-r1.md`).
4. That a Hong Kong limited company is entered on the public Companies Registry register, and that the Business Registration Certificate is issued by the Inland Revenue Department, is public-record fact about Hong Kong law, not a repository document. The founder confirmed this paragraph on 2026-10-01. The number 79886556 comes from the same P4 submission as note 3.
5. That the giveaway rules live at /giveaway/rules and that every version stays online at its own permanent address comes from `docs/legal/compliance.md`, section 4 ("Every published version is immutable at `/giveaway/rules/<rules_version>`").
6. The representatives paragraph comes from `docs/legal/compliance.md`, section 1, and ADR-019. It states the rule the build enforces rather than a present fact: the signup route is unreachable until the privacy notice names both representatives (E9-03). The sentence is therefore true before and after E9-03 ships, and E9-02 does not depend on it (founder decision, 2026-10-01).
7. The Trustpilot paragraph comes from `docs/brand/copy-rules.md`, "Claims that must stay true" ("No rating is displayed until the review count justifies it."), and ADR-024. It makes no claim about a link, so it is true before and after E9-08 adds the profile link (founder decision, 2026-10-01). "We will never buy reviews" comes from the brand guidelines, section 8.3.
8. The contact address support@valstara.com, and its use for every kind of enquiry, comes from the founder's instruction of 2026-10-01 and the current giveaway rules revision `VAL-GW-LAUNCH-20261001-r1`. The kinds of enquiry listed (the waitlist, the giveaway, legal matters, payment enquiries, requests to review a decision) are the ones section 1 of the current rules provides a contact for.
9. That waitlist email comes from valstara.com comes from the development plan, P1 (`send.valstara.com` and `mail.valstara.com`).
10. No tracking cookies, no advertising trackers, no banner and the single theme-preference storage value come from `docs/legal/compliance.md`, section 3, and the permanently-out-of-scope list in `AGENTS.md` (no GA4 or Meta pixels, no consent banner). CI gates enforce all of it.

---

## /guarantee

**Title:** The Triple Guarantee
**Description:** Every Valstara order is covered by three promises. Delivered within 24 hours, protected start to finish, and resolved, replaced or refunded.

### Page copy

# The Triple Guarantee

Every Valstara order is covered by three promises. They answer the three questions a careful buyer asks before paying for anything online, in the order people ask them. Will I actually get it? Are my money and my data safe? What happens if it stops working?

*Pre-launch paragraph, removed at the storefront port:* The store is not open yet. We are publishing the guarantee in full before we take a single order, so you can read exactly what we are committing to before you decide whether to trust us with one.

## I. Delivered within 24 hours.

Every order is fulfilled by hand, Monday to Friday, within 24 hours of purchase.

We state the real number because a timeframe we keep every weekday is worth more to you than a faster one you have reason to doubt.

## II. Protected, start to finish.

256-bit encryption throughout. PCI-compliant payment handling. Your data is never sold.

We chose those words with care. To send you email at all, we have to pass your address to the companies that deliver it for us, and we would rather tell you so than claim otherwise.

## III. Resolved, replaced, or refunded.

If anything goes wrong at any point during your subscription period, we resolve it. If it cannot be resolved, we replace it. If it cannot be replaced, we refund you. In that order, without argument.

The order is the promise. Plenty of sellers offer a replacement or a refund and then make you fight for it. We set out the sequence now so that you never have to argue for it later.

## The price you see is the price you pay

This is not one of the three promises, but we hold ourselves to it in the same way. There are no currency conversion tricks and no fees introduced at checkout. There are no mandatory service charges and no bait listings.

## Cover for each kind of product

Each category in the store will state its warranty cover in plain language, and we will publish those terms when the store opens. No category goes on sale until we can state its delivery time and a warranty we are able to honour.

## Why we can promise this

Valstara is the seller, not a marketplace. Every order is sold under our name at our prices, and we carry full responsibility for fulfilment and support. When something goes wrong there is no third party to point at, so honouring the guarantee falls to us, and we set its terms at a level we can keep even when supply is under strain.

You can find out who we are and how to reach us at valstara.com/legit.

### Source notes

1. The three questions and their order come from the brand guidelines, section 2.2.
2. Publishing the guarantee in full before taking orders comes from the brand guidelines, section 12, item 4 ("Publish the Triple Guarantee page before any paid traffic runs"). The italic label is an instruction to E9-02 and the storefront port, not page copy.
3. Promise I, its heading and its sentence are transcribed word for word from the brand guidelines, section 2.1. The explanation after it comes from section 2.2 ("A specific, honest, honoured timeframe outperforms a fast one that is doubted").
4. Promise II is transcribed from the brand guidelines, section 2.1, with the final sentence amended by founder decision on 2026-09-30 (see "Decisions applied" above). The explanation comes from `docs/brand/copy-rules.md`, "Claims that must stay true" (data "necessarily reaches the email providers"), and the processor list in `docs/prelaunch-stack-decisions.md` (Resend and Brevo).
5. Promise III is transcribed word for word from the brand guidelines, section 2.1. The explanation comes from section 2.2 ("The escalation order is the promise... Stating the sequence up front removes the fight").
6. The price commitment, and that it sits on the guarantee page without being one of the three promises, comes from the brand guidelines, section 2.3. Its four exclusions are the same four listed there.
7. The per-category paragraph follows the founder decision of 2026-09-30, the brand guidelines, section 2.4 ("Warranty coverage stated per category in plain language"), and section 9 ("no category launches without a stated delivery timeframe and warranty we can honour").
8. The final section comes from the brand guidelines, section 1.4 ("we are the seller, not a listing board... there is no third party to point at"), section 1.7 ("Valstara carrying full responsibility for fulfilment and support"), and section 2.4 ("Set terms at what can be honoured under supply stress").
9. The numbering I, II, III, the use of exactly three promises and headings in sentence case follow the brand guidelines, sections 2.4 and 3.1.

---

## /about

**Title:** About Valstara
**Description:** Valstara sells digital goods well below list price, with a guarantee on every order. Why we exist, how we work and who is behind us.

### Page copy

# About Valstara

Valstara sells digital goods with a guarantee. We sell subscriptions, software licences, gift cards, game keys and in-game currency at prices well below list, and every order is covered by the Triple Guarantee.

## Why we exist

Most people who buy digital goods below list price do it through marketplaces. A marketplace connects buyers with sellers and disclaims everything in between, so when something goes wrong the buyer is left chasing a stranger. People who shop in this category have learned to expect the worst, and the category has given them reasons to.

Valstara works differently. We are the seller, not a listing board. The goods we sell are sourced from verified suppliers or acquired directly, then sold under our own name at our own prices, and we carry full responsibility for fulfilment and support. When something goes wrong, we put it right, because there is nobody else to point at.

## What we are, and what we are not

We will not always have the lowest price on the internet. On marketplaces where sellers undercut each other down to nothing, someone will sometimes beat us. What we offer is a price well below list from a seller that states its terms and keeps them.

We sell every product under its provider's own name, so you always know exactly what you are buying. We start with subscriptions for entertainment and for AI tools, and we will add further categories over time. A category goes on sale only when we can state its delivery time and a warranty we are able to honour.

We will not rush you. You will not find countdown timers on this site, or invented scarcity, or figures inflated to look bigger than they are. When we tell you where you stand on the waitlist, it is the real figure from our records.

## The name

Val comes from the Latin valere, to be worth. It is the root of value, and everything we do is about worth, meaning real goods well below list price and the assurance that what you bought is what you get.

The star sits inside the name, VAL·STAR·A. It is the symbol people already look for when deciding whether to trust a shop, and it is what travellers once steered by when nothing else could be relied on. Valstara is meant to be that fixed point, the mark you steer by to find real value.

## Who is behind Valstara

Valstara was founded by Boris Lovrenovic and is run by 3NITY Digital Limited, a company registered in Hong Kong.

The company's registration details, how to reach us, and how to check us for yourself are at valstara.com/legit.

## When we open

The store is not open yet. Join the waitlist and we will email you when it is. We will not name a launch date until we are sure we can keep it.

Premium for less.

### Source notes

1. The opening line is the one-line boilerplate from the brand guidelines, section 3.4. The list of what Valstara sells comes from the short boilerplate in the same section.
2. The marketplace problem and the expectation of a scam come from the brand guidelines, section 1.2 ("anonymous marketplaces that connect buyers to sellers and disclaim everything in between") and section 1.4 ("Buyers in this category are conditioned to expect a scam").
3. Being the seller rather than a listing board, sourcing from verified suppliers or direct acquisition, selling under the Valstara name at Valstara's prices, and full responsibility for fulfilment and support come from the brand guidelines, sections 1.4, 1.5 and 1.7.
4. Not always being the lowest price comes from the brand guidelines, section 1.5 ("We do not win on price against marketplaces whose sellers undercut each other to zero margin... We win on price-to-trust ratio").
5. Selling products under the provider's own name comes from the brand guidelines, section 3.3.
6. Starting with subscriptions for entertainment and AI, and adding categories over time, comes from the brand guidelines, section 9, which names subscriptions for entertainment and AI as the current wedge, and section 1.5 ("Category-broad over time"). The rule that a category launches only with a stated delivery time and warranty is from section 9.
7. No countdown timers, no invented scarcity and no inflated figures come from `docs/brand/copy-rules.md`, "Never build", and the brand guidelines, section 3.1. That the waitlist position is the real database figure comes from copy-rules, "Claims that must stay true" ("The count shown is the count in the database").
8. The meaning of the name comes from the brand guidelines, section 1.2 (locked).
9. That Valstara was founded by Boris Lovrenovic comes from the founder's instruction of 2026-10-01. That 3NITY Digital Limited runs Valstara comes from the brand guidelines, section 1.1.
10. The launch-timing paragraph comes from `docs/brand/copy-rules.md`, "Claims that must stay true" ("Never a date the campaign cannot hold"), and matches the landing-page FAQ in `src/copy/landing.ts`.
11. "Premium for less." is the tagline from the brand guidelines, section 1.3, set in sentence case with a full stop as that section requires.
