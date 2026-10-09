# E11-05 — Privacy audit

Date: 2026-10-09; revised 2026-10-10. Scope: the built local site and repository at this ticket. Production Cloudflare injection is verified again by E12-05 and E12-07; this local audit does not claim to inspect a future production response.

## Rendered-page inventory

`test/e11-05-page-inventory.test.mjs` discovers every `.astro` file under `src/pages` and expands the three published rules revisions from `src/content/giveaway-rules`. It crawls these **17 URLs** in a real browser: `/`, `/about`, `/dsr`, `/giveaway/award`, `/giveaway/rules`, `/giveaway/rules/VAL-GW-LAUNCH-20260925-r1`, `/giveaway/rules/VAL-GW-LAUNCH-20261001-r1`, `/giveaway/rules/VAL-GW-LAUNCH-20261009-r1`, `/guarantee`, `/leaderboard`, `/legit`, `/me`, `/privacy`, `/privacy/storage`, `/terms`, `/unsubscribe`, `/verify`.

The same crawl includes ten emailed-link variants: invalid and valid `/verify`, `/me`, `/unsubscribe` and provisional-award links, plus both export and delete DSR confirmations. It also includes the generic 404 and an unknown rules revision. That is **29 browser navigations**. Every navigation checks attempted off-origin requests, cookies, local and session storage, Turnstile form placement and the page-view script. A controlled browser check also executes the approved Turnstile loader, records its follow-on requests, and checks cookie state and storage method access across frames. `/legit` always renders the "not yet" Reviews paragraph and plain profile link.

The executing-loader check previously found that the Trustpilot widget requested `images-static.trustpilot.com` outside the then two-host allowlist. The founder removed the widget on 2026-10-10. The current allowlist contains only Turnstile; the full page inventory and executing-loader check enforce that limit. No navigation attempted `static.cloudflareinsights.com`. The local page-view script loads from `/page-view.js` and sends to same-origin `/analytics/api/send`; the proxy forwards that collector path to self-hosted Umami. The theme control's deliberate `valstara-theme` write is separately tested by `test/theme-toggle-rendered-page.test.mjs`.

| Approved host | Scope and basis | Evidence |
|---|---|---|
| `challenges.cloudflare.com` | Turnstile on protected signup, recovery, member and provisional-winner forms only. ADR-006's Article 5(3) basis is the documented rendered probe result: no device storage or access. Cloudflare's server-side IP, TLS and user-agent processing is disclosed separately. | Form-scoped allowlist; full route crawl; ADR-006; compliance §3. The award form appears only for an authenticated provisional winner. |

The allowlist assertion checks that its host set is **exactly** this one name; a second entry fails the test. Source gates inspect cookie/storage calls, fingerprinting APIs and browser-reaching URLs, and each has a planted red-path fixture (`test/security-gates.test.mjs`), including the retired Trustpilot host. The browser dependencies are first-party Astro assets, fonts, images and page-view emitter plus Turnstile on protected forms. No new browser dependency was added in this ticket.

Mutation check: adding a second host to `privacy-allowlist.json` fails the exact-set assertion; rendering the retired Trustpilot loader fails the third-party gate and browser crawl; rendering the full client address on `/verify` or in signup's `message` field fails the strengthened route response test. The previous route test passed both deliberate leaks.

## Route response inventory

`test/e11-05-route-shapes.test.mjs` generates its inventory from every `src/pages/api/**/*.ts` and `src/pages/**/*.astro` route and checks API exports and the four Astro POST handlers. It reconciles all five admin files and methods with the authenticated admin registry. For the public API files it inspects constructed JSON response fields against the closed safe set and rejects personal values in approved fields, including direct and aliased client addresses. For Astro routes it checks rendered expressions for personal values, including the raw client address. The DSR routes delegate to a purpose-bound, subject-scoped handler. Existing route and module tests exercise the success cases; this generated test is the addition/removal guard.

| Registered method | Response shape / boundary |
|---|---|
| `POST /api/signup` | Accepted `status` and copy or closed error envelope; unknown and known identities receive the same acknowledgement. |
| `POST /api/resend-verification` | Accepted `status` and copy or closed error envelope, independent of address membership. |
| `GET /api/leaderboard` | Snapshot metadata and anonymised `display_handle`, `rank`, `confirmed_referrals`; no subscriber ID, address or referral code. |
| `POST /api/survey` | Saved/skipped status and copy or closed error envelope. |
| `POST /api/unsubscribe` | Accepted status and copy or closed error envelope. |
| `POST /api/me/marketing` | Accepted status and copy or closed error envelope. |
| `POST /api/me/leave` | Accepted status and copy or closed error envelope. |
| `POST /api/dsr/export` | Generic request acknowledgement; a valid purpose-bound bearer receives only the requester's subject-scoped NDJSON, with other people's fields redacted. |
| `POST /api/dsr/delete` | Generic request or pending-erasure acknowledgement, or closed error envelope. |
| `POST /api/webhooks/[provider]` | Empty success or closed error envelope after provider authentication. |
| `POST /api/admin/draw` | MFA-protected draw metadata or closed error envelope. |
| `GET /api/admin/export.csv` | MFA-protected, audited subscriber CSV; intentionally not a public response. |
| `GET /api/admin/fraud` | MFA-protected review queue; intentionally not a public response. |
| `POST /api/admin/fraud/[id]` | MFA-protected decision result or closed error envelope. |
| `GET /api/admin/health` | MFA-protected aggregate health result or closed error envelope. |

The HTML GET routes in the page inventory return public content or bearer-specific content. `POST /verify` returns the current token's verification outcome; `POST /me` returns a generic recovery acknowledgement; `POST /unsubscribe` returns the requested preference/leave outcome; `POST /giveaway/award` returns the current provisional winner's award outcome. `/me` is the documented own-bearer exception. `/giveaway/award` similarly shows only an authenticated provisional winner's own award, and `/dsr` renders only its own signed confirmation; valid and invalid award links and the 404 states were crawled. No public response is designed to reveal another person's row.

## Personal-data and consent checks

- **Storage:** `/privacy` and `/privacy/storage` each list only `valstara-theme`. `scripts/ci/privacy-allowlist.json` permits that key only in the theme toggle; `test/legal-pages.test.mjs` reconciles the notice, allowlist and source. No analytics/referral identifier is written.
- **IP:** The application receives a raw client address transiently at route boundaries. `src/pages/api/signup.ts#hashIpPrefix` and `src/server/ratelimit/ip-prefix.ts` truncate IPv4 to `/24` or IPv6 to `/64` before a peppered HMAC. Inspection of route, data-layer, alert and logging call sites found no full-address write, log or public return; `test/ip-velocity.test.ts` exercises the downstream/log boundary. The Caddyfile has no access-log directive. An information-schema query against the migrated local database found only `subscriber.signup_ip_prefix_hash` and `giveaway_award.country_of_residence` among IP/location fields; the unrelated `top_twenty_review_batch.membership_hash` also matched the broad `ip` column-name search. The 90-day hash purge is batch-capped and its failure is a compliance alert. A full address is not retained by the application.
- **Location:** Migration `0023` drops signup `country`, `country_detected` and `region`; `test/geo-header-scan.test.mjs` rejects a `CF-IPCountry` reader. The only live location field is `giveaway_award.country_of_residence`, written after a provisional winner responds at award time. Signup and giveaway entry tests verify that consent and location are not eligibility gates.
- **Analytics:** The event registry uses finite categories and booleans for server events; the client `page_view` carries public context only. Its URL is the path, not query tokens; the referrer is reduced to origin, and the collector request uses `no-referrer`. `test/analytics.test.ts`, `test/analytics-collector.test.ts` and `test/page-view-rendered.test.mjs` cover the registry and emitter.
- **ADR-027:** `test/s01-alignment.test.ts` verifies an unticked signup still verifies and receives access without marketing consent; `test/giveaway-entry.test.ts` verifies that the same no-consent path accrues its base entry when the giveaway is open. A later grant/withdrawal leaves status, referral edges and entries intact. `test/email-service.test.ts` and `test/weekly-campaign.test.ts` re-check current consent at dispatch so a queued broadcast cannot reach a withdrawn subscriber. `test/unsubscribe.test.ts` covers one-click withdrawal and preserved entries.

**Launch-access notification classification confirmed for the defined message:** the one factual message telling a verified, unsuppressed waitlist member that the promised launch access is ready is fulfilment of the service requested by joining. The landing copy promises that message; ADR-027 and the privacy processing table assign it to the waitlist contract. [ICO guidance on service messages](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-guidance/identify-direct-marketing/) supports this only while the content remains administrative and non-promotional: an added promotion makes even a service message direct marketing. Weekly updates, product news and any further promotional send require current consent. This classification does not authorise a sequence of promotional “launch” messages to the no-consent audience. No launch-access send or final message content is implemented by E11-05; its eventual text must stay within this boundary.

## Findings and limits

The founder-authorised 2026-10-10 removal closes the Trustpilot follow-on-host blocker without widening the allowlist. **Open launch input:** the customer-facing privacy notice remains the founder-authorised draft described in `docs/legal/compliance.md`, and the Turnstile processor wording there still carries an explicit legal sign-off requirement. This audit does not supply legal sign-off. E11-08 cannot call the privacy gate clean for launch until that input is resolved. E12-05 must repeat the rendered-page gate behind production Cloudflare and treat `static.cloudflareinsights.com`, or any host beyond Turnstile, as a blocking finding.

Plan wording observation: E11-05 calls `/me` the single own-bearer exception, while the already-approved DSR export and provisional-winner award routes also return only their authenticated requester's data. Their specific contracts are in `docs/api/README.md`. The no-other-person rule holds; the exception wording should be reconciled by the founder if it is meant to exclude those routes.
