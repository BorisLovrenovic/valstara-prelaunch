# ADR-007: Cookieless analytics and no consent banner

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
The site must measure a funnel it is optimising hard — a 20–35% signup target — and it operates in markets where analytics consent is strictly enforced. GA4 requires opt-in consent in Germany with no analytics exemption at all, and CNIL's French exemption is narrow and conditional.

## Decision
**Umami self-hosted plus Cloudflare Web Analytics. No GA4, no consent banner.** Cookieless by construction, and enforced by three CI gates rather than by intention: the cookie/storage rule, the fingerprinting rule, and the third-party request rule.

**E10-01 amendment, founder-authorised 2026-10-05:** Umami's stock 3.3.0 tracker reads `localStorage.getItem("umami.disabled")`. No stock or patched Umami tracker is served. A minimal static first-party script sends one pageview per page load to Umami's collector through `/analytics/api/send`. Its payload contains only the public website ID, hostname, URL path, referrer origin, page title and HTML language. The collector request suppresses the browser's `Referer` header so it cannot carry a query token. The emitter omits `/me`, `/verify`, `/unsubscribe` and admin routes; it reads or writes no browser storage and sends no screen or other device property. The proxy exposes only the collector endpoint, never Umami's `/script.js`.

Referral attribution is captured **server-side** (ADR-008) so the one mechanic that would otherwise need a cookie does not.

GA4 and a consent-management platform return at store launch, when ads and ecommerce attribution justify them.

## Alternatives rejected
- **GA4 with a CMP** — a banner costs conversion directly on a page whose only job is conversion, **and corrupts the measurement it was added for**: consented GA4 only ever sees a self-selected subset. Cookieless gives better numbers here, not worse.
- **Plausible or Fathom hosted** — fine products, a recurring line for something self-hostable on capacity that already exists.
- **No analytics** — funnel analytics is on the never-cut list. Flying blind on the campaign's single metric is not a saving.

## Consequences
**The banner-free property is a code property**, and one careless dependency reverses it — hence the three gates and the rendered-page checks (`docs/testing/strategy.md`). The funnel is computable from **server-side events alone**, which also makes it robust to ad blockers.

The cookie/storage gate permits exactly one source write, the theme preference. `/privacy/storage` publishes that one-entry inventory, links back to `/privacy`, and a reconciliation test compares the page, the allowlist and the source write.

The third-party-request gate permits exactly two off-origin rendered-page hosts: the flagged Trustpilot widget and Cloudflare Turnstile on protected forms (ADR-006, Option A, founder-authorised 2026-09-08). Turnstile's Article 5(3) basis is the probe-confirmed absence of device storage/access. The site runs no device-fingerprinting API; Cloudflare's server-side processing of IP, TLS and user-agent security signals under its processor role is disclosed separately. Every other off-origin request still fails the gate.

The Trustpilot exception is confined to `/legit` (founder-authorised 2026-10-05). The official loader is emitted with `async` only when `trustpilot.widget` is on, both public TrustBox IDs are configured and the founder-entered review count meets the configured minimum (default 50). The flag service audits refusal to enable below the minimum. With the flag off or eligibility unmet, the page has no Trustpilot request; its plain profile link does not prefetch or preconnect. There is no Trustpilot API, key, island or first-party widget script. If the loader fails, the page's own content and profile link still render.

Reopens at store launch, deliberately, as a different decision for a different site.
