# ADR-007: Cookieless analytics and no consent banner

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
The site must measure a funnel it is optimising hard — a 20–35% signup target — and it operates in markets where analytics consent is strictly enforced. GA4 requires opt-in consent in Germany with no analytics exemption at all, and CNIL's French exemption is narrow and conditional.

## Decision
**Umami self-hosted plus Cloudflare Web Analytics. No GA4, no consent banner.** Cookieless by construction, and enforced by three CI gates rather than by intention: the cookie/storage rule, the fingerprinting rule, and the third-party request rule.

Referral attribution is captured **server-side** (ADR-008) so the one mechanic that would otherwise need a cookie does not.

GA4 and a consent-management platform return at store launch, when ads and ecommerce attribution justify them.

## Alternatives rejected
- **GA4 with a CMP** — a banner costs conversion directly on a page whose only job is conversion, **and corrupts the measurement it was added for**: consented GA4 only ever sees a self-selected subset. Cookieless gives better numbers here, not worse.
- **Plausible or Fathom hosted** — fine products, a recurring line for something self-hostable on capacity that already exists.
- **No analytics** — funnel analytics is on the never-cut list. Flying blind on the campaign's single metric is not a saving.

## Consequences
**The banner-free property is a code property**, and one careless dependency reverses it — hence the three gates and the rendered-page checks (`docs/testing/strategy.md`). The funnel is computable from **server-side events alone**, which also makes it robust to ad blockers.

Reopens at store launch, deliberately, as a different decision for a different site.
