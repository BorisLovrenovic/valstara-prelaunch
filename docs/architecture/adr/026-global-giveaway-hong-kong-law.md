# ADR-026: One global giveaway under Hong Kong law, with no jurisdiction gating

- Status: Accepted
- Date: 2026-09-25
- Deciders: founder
- Supersedes: ADR-018

## Context
ADR-018 excluded Italy, Poland, Spain, the Nordics and Quebec at point of entry, and required a counsel-reviewed rules page for every remaining jurisdiction. To support it, signup collected a confirmed country (and a province for Canada), prefilled from `CF-IPCountry`.

Two research reports on prerequisite P4 (`docs/prerequisites/`) showed the per-jurisdiction route would mean several rules pages, local translations and local counsel review, plus a growing exclusion list (Belgium and Portugal were missing). Every excluded country is also a country where the referral loop stops working.

Valstara is incorporated and operates in Hong Kong, and so does its payment service provider. The pre-launch giveaway is a one-time campaign that ends at launch.

## Decision
**One global giveaway, promoted by the Hong Kong company and governed by Hong Kong law.** The founder accepts the residual foreign promotion-law risk as a business cost for a one-time campaign.

- **No country or region is collected at signup.** The application does not read `CF-IPCountry`, and the geo module is removed. Nothing decides eligibility from location.
- **One rules page at `/giveaway/rules`**, one global `rules_version`, with no per-country pages, no jurisdiction table and no exclusions.
- **Eligibility:** a person aged 18 or over, with one registration per natural person and a verified email address. The rules and the signup form state the age requirement, and it is confirmed with each provisional winner at award time.
- **No purchase is necessary.** The ordinary verified signup is the free entry route. Entry never requires a referral, a purchase or marketing consent (ADR-027). Every entry carries equal weight.
- **Prize limits:** each prize has an approximate retail value of **€449 or less**, and the total prize pool stays **below US$5,000**, checked at a conservative euro-to-dollar rate recorded in the rules content. Values are stated in euros.
- **Substitution (founder decision, 2026-09-25):** the prize is a Valstara product bundle. Products available now may not be available months later, so if a product in the bundle is unavailable at award time, **the winner chooses replacement products so the bundle keeps at least its stated retail value**. If the winner wants no replacement, **the promoter pays that unavailable product's retail value in cash**, as a last resort.
- **Bundle contents and the sanctions list are not blockers (founder decision, 2026-09-25).** Until the bundle is chosen, the rules page states the prize by value and says the products will be listed before the draw. Dummy products appear only in test fixtures, never on the public page, and the draw refuses to run until the contents are published. The sanctioned-jurisdiction list is configuration that may be empty until the founder adds it.
- **One prize per person.** Once a person is selected, their remaining entries leave the pool for the following selections, and the rules say so.
- **Honest odds wording:** each eligible entry has equal weight, and a person's odds depend on their number of entries relative to the total number of eligible entries when entries close.
- **Winners pay any local taxes** on the prize. Prizes are Valstara's digital goods, delivered electronically at no cost to the winner.
- **Location is collected only from provisional winners, at award time,** and it is only their **country of residence**. It is used for a sanctions check (a winner in a sanctioned jurisdiction is replaced from the reserve list), for regional availability of the digital goods (a product that isn't available in the winner's region is handled by the substitution rule), and to require a skill-testing question from a winner resident in Canada. **No postal address is collected**, because prizes are delivered electronically (data minimisation).
- **No Hong Kong Trade Promotion Competition Licence is required** for this free-entry draw. This is a founder determination made on 2026-09-25.

Data protection is unchanged. GDPR and UK GDPR still apply, the Article 27 representatives are still required (ADR-019), and entry is separated from marketing consent (ADR-027).

## Alternatives rejected
- **Per-jurisdiction exclusions and pages (ADR-018)** — several pages, translations and local reviews, and an exclusion list that suppresses referrals in every excluded market.
- **A narrow launch in seven countries** (research report 1) — lowest legal exposure, but it blocks the referral loop almost everywhere.
- **A broad launch across 23 EU states with local sign-off** (research report 2) — around 16 countries would still need local confirmation, which defeats the purpose of the change.

## Consequences
- The giveaway epic becomes simpler: one rules page, one rules version, and no eligibility table.
- **The accepted risk is real, and it is recorded here so it isn't forgotten.** Some countries regulate or prohibit free chance draws open to their residents (the research found Belgium prohibits them, and Portugal, Italy, Spain and Poland require authorisation or charge taxes). A Hong Kong governing-law clause does not remove consumers' mandatory protections in their home country. The most likely enforcement comes through vendors (email providers, payment provider, Cloudflare) rather than regulators.
- The prize limits keep several regimes from being triggered at all: the Netherlands' €449-per-prize gaming-tax line, the US$5,000 registration thresholds in New York and Florida, and Austria's duty exemption.
- The country selector, the region field, `country`, `country_detected`, `region`, `giveaway_eligible` and `giveaway_entry.jurisdiction` are removed by ticket S-01. Without a country header, the landing-page cache key is the flag generation alone.
- **What would reopen this decision:** a regulator or vendor action, a prize pool that needs to exceed the limits above, or a decision to run giveaways after launch.
