# Feature: Analytics

## Summary
**Umami self-hosted** plus Cloudflare Web Analytics. Page views use Valstara's minimal first-party emitter, not Umami's tracker (founder-authorised 2026-10-05). Cookieless by construction, which means no consent banner — and on a page targeting 20–35% signup, that is better measurement, not worse: a banner costs conversion directly and corrupts the numbers it was added for, since consented analytics only ever sees a self-selected subset (ADR-007).

GA4 and a consent-management platform return at store launch, when ads and ecommerce attribution matter.

## Feature flag
None. Analytics that can be switched off silently is analytics you cannot trust.

## The event schema
One registry defines every event and tags its source `client` or `server`. There is no server view event: the landing page is edge-cached for 300 seconds, so a server render count would undercount visits. Caching is retained. Server `track()` throws for client-sourced or unregistered events in development and drops them in production.

| Event | Emitted from | Properties |
|---|---|---|
| `page_view` | client | `website`, `hostname`, `url`, `referrer`, `title`, `language` — exactly these six emitter fields |
| `signup_submitted` | server | `source_bucket`, `had_ref`, `marketing_opt_in` |
| `signup_rejected` | server | `reason_code` |
| `verified` | server | `hours_to_verify_bucket`, `source_bucket` |
| `referral_confirmed` | server | `referrer_tier_bucket` |
| `survey_completed` | server | `question_set_version` |
| `giveaway_entered` | server | `method` |
| `unsubscribed` | server | `source_template` |

**No property may carry an email address, referral code, IP address, or any value that identifies one person.** A schema test asserts this over every registered event, including `page_view`. Server properties are finite categories or booleans; raw UTM values never become event properties. The source buckets are `direct`, `referral`, `email`, `social`, `paid`, `organic`, `other`; absent UTMs yield `direct`. The verification-time buckets are `under_1`, `1_to_24`, `24_to_72`, `over_72` hours. The referral-tier buckets are `none`, `tier_1`, `tier_2_or_higher`. A test compares the emitter payload keys against the registry's six `page_view` keys.

The static `/page-view.js` loads with `defer` and sends one `event` payload per page load to the same-origin `/analytics/api/send` proxy. The `url` field is only `location.pathname`; search and fragment never enter the payload. The referrer is reduced to its origin, and the collector request suppresses the browser's `Referer` header so a query token cannot reach Umami that way. The other fields are the fixed public Umami website ID, hostname, page title and HTML language. The emitter reads no cookie, Web Storage or IndexedDB, and uses no screen size or other device property. It is omitted and inert on `/me`, `/verify`, `/unsubscribe` and admin routes. Umami's `/script.js` is not exposed through the proxy. The website must be created in Umami with the public ID in `src/layouts/page-view-emitter.astro` before collecting views; E12-07 provisions that record on the production host.

## Edge cases and error states
Umami unavailable → **events are lost and nothing else is.** The emitter ignores fetch failures, no page blocks on analytics, and no request is retried into a failing collector. **Submit → verify → refer is computable from server events alone.** The view step uses client `page_view`; any view-based rate is documented and labelled **estimate**, because ad-blocker loss inflates it. UTM parameters absent → the source bucket is `direct`, never null. Any view-based rate in the E10-05 admin health view is labelled **estimate**.

## Acceptance criteria
- [ ] **No cookie and no browser-storage identifier is set** — asserted by an automated check over a rendered page
- [ ] **No third-party request leaves the page** except to the self-hosted collector — asserted by a network-inventory test
- [ ] Every event validates against the registered schema; an unregistered event **throws in development and is dropped in production**
- [ ] **No event property carries personal data** — asserted over the whole registry
- [ ] Submit → verify → refer is computable **from server events alone**; the view step uses client `page_view`, and any view-based rate is labelled **estimate**
- [ ] An analytics failure never affects a response
- [ ] UTM capture is server-side on the rendering request, consistent with referral capture

## Telemetry
This feature is the telemetry. Its own health signal is event volume against page views, which catches a broken collector.
