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
**The banner-free property is a code property**, and one careless dependency reverses it — hence the three gates and the rendered-page checks (`docs/testing/strategy.md`). **Founder-authorised 2026-10-06:** submit → verify → refer is computable from server events alone. The view step uses the client `page_view` because the landing page is edge-cached; a server view event would undercount. Any view-based rate is labelled an estimate because ad-blocker loss inflates it.

The cookie/storage gate permits exactly one Valstara source write, the theme preference. `/privacy/storage` publishes the two-entry browser inventory: that preference and Cloudflare Turnstile's `cf.turnstile.u`, accessed only when a protected form runs. The reconciliation test checks the first entry against the unchanged source-code gate and the second against the rendered-page probe (founder-authorised 2026-10-10).

The third-party-request gate permits exactly one off-origin rendered-page host: Cloudflare Turnstile on protected forms (ADR-006, Option A, founder-authorised 2026-09-08). The stated Article 5(3) basis for its `cf.turnstile.u` access is the strictly-necessary exemption for security of the form the visitor submits; legal review was waived by the founder in ADR-030. The site runs no device-fingerprinting API; Cloudflare's server-side processing of IP, TLS and user-agent security signals under its processor role is disclosed separately. Every other off-origin request still fails the gate.

**Founder-authorised 2026-10-10:** The pre-launch Trustpilot widget and its exception are removed after the executing-loader audit found a follow-on request outside the two-host allowlist. `/legit` keeps the plain Trustpilot profile link with `rel="noopener"`, without prefetch or preconnect, and always shows the "not yet" Reviews paragraph. No Trustpilot host is requested by a rendered page. The widget may return with the storefront's consent management platform; that is a separate storefront decision.

Reopens at store launch, deliberately, as a different decision for a different site.
