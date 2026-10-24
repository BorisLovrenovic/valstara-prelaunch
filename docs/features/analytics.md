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

**No property may carry an email address, referral code, IP address, or any value that identifies one person.** A schema test asserts this over every registered event, including `page_view`. Server properties are finite categories or booleans; raw UTM values never become event properties. The source buckets are `direct`, `referral`, `email`, `social`, `paid`, `organic`, `other`; a request without a medium, ref or other UTM yields `direct`. The verification-time buckets are `under_1`, `1_to_24`, `24_to_72`, `over_72` hours. The referral-tier buckets are `none`, `tier_1`, `tier_2_or_higher`. `survey_completed.question_set_version` accepts `2026-09-08` and `2026-10-19`; no category answer is sent. A test compares the emitter payload keys against the registry's six `page_view` keys.

**E10-03 founder decision, 2026-10-06 — source classification.** Apply these rules in order to the signed server capture. A present `utm_medium`, lower-cased and trimmed, takes precedence: `email` or `newsletter` → `email`; `social` → `social`; `cpc`, `ppc`, `paid`, `paid_social` or `display` → `paid`; `organic` → `organic`; `referral` → `referral`; every other medium → `other`. Without a medium, a valid signed ref → `referral`; without a medium or ref, any other UTM → `other`; with none of those → `direct`. `signup_had_ref` preserves the validated capture's ref-presence bit for the later verification event, including when referral attribution is flag-off. `utm_source` never classifies an event and no raw UTM value is emitted. A table-driven test covers every mapping and precedence.

**E10-03 founder decision, 2026-10-06 — transition timing.** `signup_submitted` is emitted once for a newly committed pending row; accepted repeats do not emit it. `signup_rejected` carries the closed signup reason code. `verified` fires once for the pending-to-verified transition, and `referral_confirmed` once per newly confirmed edge, including an edge repaired later. `giveaway_entered` fires once per inserted ledger entry, including bounded reconciliation, and only while the giveaway flag permits accrual. `survey_completed` fires only on the first saved submission with an answer; all-skip, later replacements and replays do not fire it, while a skip followed by an answer does. The survey row retains the first-answered marker through replacements. `unsubscribed` fires once per person-initiated effective marketing-consent withdrawal or waitlist leave; a leave emits one event even when it also suppresses and withdraws consent. Replays, no-ops and provider bounce/complaint suppressions emit none. Its `source_template` is the server-resolved originating template, or `member_status` for `/me`, restricted to the registry values. Transactional events are emitted after commit; collector loss cannot roll a transition back.

The server-only funnel reconstructs aggregate `signup_submitted` → `verified` → `referral_confirmed` counts. These events contain no person identifier and therefore do not join individual journeys. The view step uses client `page_view`; every view-based rate is labelled **estimate** because ad-blocker loss inflates it.

The static `/page-view.js` loads with `defer` and sends one `event` payload per page load to the same-origin `/analytics/api/send` proxy. The `url` field is only `location.pathname`; search and fragment never enter the payload. The referrer is reduced to its origin, and the collector request suppresses the browser's `Referer` header so a query token cannot reach Umami that way. The other fields are the fixed public Umami website ID, hostname, page title and HTML language. The emitter reads no cookie, Web Storage or IndexedDB, and uses no screen size or other device property. It is omitted and inert on `/me`, `/verify`, `/unsubscribe` and admin routes. It is also omitted from the prerendered 404 and 500 pages (E11.5-10): they answer for any failing URL, whose path is arbitrary visitor input, so an error page sends no view, as before those pages existed. Umami's `/script.js` is not exposed through the proxy. The website must be created in Umami with the public ID in `src/layouts/page-view-emitter.astro` before collecting views; E12-07 provisions that record on the production host.

## Edge cases and error states
Umami unavailable → **events are lost and nothing else is.** The emitter ignores fetch failures, no page blocks on analytics, and no request is retried into a failing collector. **Submit → verify → refer is computable from server events alone.** The view step uses client `page_view`; any view-based rate is documented and labelled **estimate**, because ad-blocker loss inflates it. No medium, ref or other UTM → the source bucket is `direct`, never null. Any view-based rate in the E10-05 admin health view is labelled **estimate**.

## Acceptance criteria
- [ ] **No cookie and no browser-storage identifier is set** — asserted by an automated check over a rendered page
- [ ] **No third-party request leaves the page** except Turnstile on protected forms; the collector is same-origin — asserted by a network-inventory test
- [ ] Every event validates against the registered schema; an unregistered event **throws in development and is dropped in production**
- [ ] **No event property carries personal data** — asserted over the whole registry
- [ ] Submit → verify → refer is computable **from server events alone**; the view step uses client `page_view`, and any view-based rate is labelled **estimate**
- [ ] An analytics failure never affects a response
- [ ] UTM capture is server-side on the rendering request, consistent with referral capture

## Telemetry
This feature is the telemetry. Its own health signal is event volume against page views, which catches a broken collector.
