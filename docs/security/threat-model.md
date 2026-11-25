# Threat Model

Status: authoritative. Scope: the pre-launch site for the duration of the campaign.

**What this system holds is smaller than a storefront's and more exposed.** No payment data, no credentials in custody, no order history — but a public write endpoint on the root domain of a brand whose entire proposition is trustworthiness, a prize draw with real money behind it, and an email list that is the campaign's only durable asset.

---

## T1 — The email list leaks

**The highest-consequence outcome.** Not because the data is sensitive in isolation, but because a leaked pre-launch list is a story that follows the brand into launch, and the audience is already suspicious.

**Controls:** No route returns another person's data — `/me` returns only the bearer's row, and the leaderboard is anonymised. **After rate limiting, resend-verification returns its identical accepted response at a fixed 500 ms deadline for known and unknown addresses; work that has not settled by then cannot change that response.** This prevents the endpoint from becoming an enumeration oracle. Exports are admin-only, audited with a row count, and batch-capped. The database is not exposed on a host port in production. **A generated test asserts that no public response shape can carry an email address** except the bearer's own on `/me`.

---

## T2 — Referral fraud discredits the leaderboard

Reputational, not financial. A leaderboard that visibly rewards a cheat is worse than no leaderboard.

**Controls:** Structural first — **cheap rewards on verification, milestone discounts held until any one of the owner's confirmed referred people places a first order within 90 days after store launch** (ADR-012). No milestone bonus draw entries are configured (founder-authorised 2026-10-11). Then normalisation before uniqueness, blocklist and MX, self-referral and velocity flags, and **manual review of the top 20 before any award**. Flagged accounts are excluded from the snapshot. The disqualification rule is **published**, because an unpublished rule cannot be enforced fairly. `leaderboard.public` is the incident lever, and it works without a deploy.

---

## T3 — The sending reputation is destroyed

The campaign's single unrecoverable technical failure. (The SubSlush announcement is a manual founder send outside this system, ADR-028, and is not a shape of this threat.)

**Verification mail quietly stops arriving.** It looks exactly like poor conversion. **Controls:** transactional and broadcast are split across providers and domains so a marketing complaint cannot touch verification; **verification *rate* is alerted on hourly**; weekly seed tests round-trip into Gmail, Outlook, GMX and Web.de.

---

## T4 — A privacy failure forces a consent banner

The site operates with no banner because its two documented browser-storage entries are the functional theme preference and Cloudflare Turnstile's `cf.turnstile.u`, which the widget reads and writes only on protected forms under the stated Article 5(3) strictly-necessary form-security basis (founder-authorised 2026-10-10; legal review waived in ADR-030). It makes no unsanctioned third-party request. The only off-origin host a rendered page may contact is Cloudflare Turnstile on protected forms (ADR-006, Option A, founder-authorised 2026-09-08). The site runs no device-fingerprinting API; Cloudflare processes IP, TLS and user-agent signals server-side as a security processor, as the privacy disclosure states. **One careless dependency reverses that**, and the cost is not a banner — it is the conversion the banner takes and the measurement it corrupts.

**Controls:** three CI gates — the cookie/storage rule, the fingerprinting rule and the third-party request rule — each with a planted fixture. Referral attribution is server-side and signed. Analytics is cookieless and its event registry is asserted free of personal data. **A new dependency that reaches the browser requires an explicit note in the PR describing what it loads.**

**E11-05 local audit, revised 2026-10-10:** The [complete rendered-page and route inventory](../testing/e11-05-privacy-audit.md) and executing-loader check exposed an unapproved Trustpilot follow-on request to `images-static.trustpilot.com`. The founder removed the pre-launch widget, and the browser check now permits only Turnstile on protected forms. The allowlist contains exactly that one host and the retired Trustpilot host has a red-path fixture. The same-origin Umami emitter remains; no `static.cloudflareinsights.com` request was seen. Production Cloudflare injection remains a separate E12-05 check; no host is pre-approved for it.

**E11-05 amendment, founder-authorised 2026-10-10:** The activated Turnstile widget's Cloudflare-origin `cf.turnstile.u` read and write are the second published inventory entry. The rendered-page probe checks every page for storage access and cookies, and requires a completed token from each protected form. Valstara's source-code storage gate still permits only the theme write. The [audit report](../testing/e11-05-privacy-audit.md) records the activation regression and its result.

---

## T5 — Bots inflate the list

A waitlist full of fake addresses corrupts every metric, burns email quota, and makes the handoff worthless.

**Controls:** Turnstile verified **server-side first** on public, unauthenticated write routes; writes authenticated by a single-use signed token consume that token in place of Turnstile (founder-authorised 2026-09-28). Both kinds are rate-limited. Invalid challenges fail closed; provider timeouts accept under strict limits and flag. Cross-origin form writes are rejected in middleware except the RFC 8058 `/api/unsubscribe` route, whose signed single-use token is the authenticator. Same-origin means the `Origin` header equals the request's scheme plus its own `Host` header; a missing or unparseable `Host` or `Origin` is rejected. The guard does not compare with Astro's `context.url`, because from Astro 7.4 that keeps the `Host` only when it matches `security.allowedDomains` and otherwise reads `localhost:<port>` (founder decision D-010, 2026-11-17). Blocklist and MX. **Double opt-in is the real filter** — a bot-created row that never verifies is never counted, never exported, and expires.

---

## T6 — Giveaway non-compliance

**Founder decision, 2026-09-25 (ADR-026): this risk is accepted, not engineered away.** The giveaway is one global draw under Hong Kong law with no country excluded. Some countries regulate or prohibit free chance draws open to their residents (the P4 research found Belgium prohibits them, and Portugal, Italy, Spain and Poland require authorisation or charge prize taxes), and a governing-law clause does not remove a consumer's home-country protections. The most likely enforcement comes through vendors rather than regulators.

**Controls that reduce the accepted risk at no cost to reach:** small prizes (each ≤ €449, pool below US$5,000), which keep several regimes from being triggered at all · no purchase necessary, with the ordinary verified signup as the free route · 18+ and one registration per person · honest odds wording · one schema-validated global rules page, prize limits enforced at build time, and every revision immutable with its hash · `rules_version` and hash stamped on every accrual · **a reproducible draw** — hash committed before the seed, reserve list, result unpublished until it reproduces · award-time **sanctions screening**, 18+ confirmation and the Canadian skill-testing question, collected from provisional winners only.

---

## T7 — Admin compromise

One operator, one credential, and the ability to disqualify, export and draw.

**Controls:** E5-03a's fail-closed middleware requires both a server-held bearer credential and a TOTP on every `/api/admin/*` request. A generated registry/filesystem assertion prevents a new admin route from being added outside that boundary. Successful authentication supplies the fixed single-operator actor; **every admin action is audited**, and the audit log is append-only by database permission — the application role has no `UPDATE` or `DELETE`. There is no user system, permission matrix, password or session. Admin routes are not linked from the public site and are excluded in `robots.txt`. Authentication responses echo no secret, token or raw IP. A second draw execution is refused. Authentication split founder-authorised 2026-09-16.

The E10-05 admin health response projects only aggregate metrics and sanitized purge run results. It carries no subscriber ID, referral code, token or raw IP address, and uses `no-store`.

---

## T8 — The box goes down under a viral spike

**Controls:** static pages absorb the spike through Cloudflare, so the origin sees writes **and the two page renders Cloudflare cannot cache**. A referral-link landing (`/?ref=<code>`) is rendered on every view, because it carries a freshly signed referral field, and is served `private, no-store` (E12-05's landing-cache contract keeps it a miss). The `/leaderboard` page is also `private, no-store`, so the `leaderboard.public` kill switch takes effect without a purge. **A viral share is a referral link, so the biggest spike reaches the box as origin requests, not cached pages.** **Any non-default flag state also leaves every landing uncached at Cloudflare**, including once `giveaway.open` or `email.broadcast` is on, so from then on even a plain `/` reaches the origin. **The origin render cache carries all of these** (founder decision 2026-11-14, `src/server/cache/render.ts`): each page is rendered once per flag generation, and each request is served the stored body with its own freshly signed referral field substituted, so a spike costs the box a cache lookup and an HMAC, not a render. Headers are unchanged, the cache holds no visitor data, is capped at 16 entries (the price pages of E11.6-10 have their own bound of 64, keyed by path, so they never evict the landing) and never grows with referral codes, and a flag change re-renders, so the kill switch still lands within five seconds. Neither page runs a `subscriber` query: the landing signs the code without a lookup, and the leaderboard page reads only the cached flags while its board comes from `/api/leaderboard`. **The leaderboard API — the one data route a spike can hammer — serves from a cached snapshot and never runs a live query.** Hard memory limits with no swap, so contention produces a restart rather than slow degradation. Every sweep and export is batch-capped and streamed. **The signup endpoint is load-tested at 10× expected peak** before the campaign opens (E11-01).

E11-01's local correctness exercise uses the founder-authorised 20/s sustained, 50/s burst and 200/s leaderboard profile, plus a deliberately large streamed export. The reproducible script, capped-query inventory, memory samples and measured result are recorded in [`docs/testing/e11-01-load-report.md`](../testing/e11-01-load-report.md). Capacity on the actual host remains E12-06.

**The two pages were measured locally for QA gate 7, and with the render cache they hold the spike rate.** Before the cache (2026-11-13), both pages at 200 requests/s together with 20 signups/s failed in all three full runs: 4–34% of page requests had no response within 30 seconds, and 552 to 1,880 of the 2,400 signups in the spike failed with HTTP 503 and 500, because one Node process's CPU could not render 400 pages a second. With the cache, run `bf3d83cc` passed the full authorised profile ([load report](../testing/e11-01-load-report.md#qa-gate-7-the-uncacheable-page-renders)): referral landings and the `/leaderboard` page at 200/s each, together with 20 signups/s for two minutes, returned 48,000 page responses and 2,400 signups, all HTTP 200, with a page p95 of 28 ms and a signup p95 of 657 ms. The row, business-key and drained-queue invariants held, the original leaderboard-API phase passed again, and the app peaked at 135 MiB of its 768 MiB. These are laptop figures: E12-06 re-runs the same phases on the host (founder decision 2026-11-13) and records its figures here.

---

## CI security gates

Each has a planted red-path fixture; **a gate that cannot be shown to fail is not a gate.**

| Gate | Asserts |
|---|---|
| Secret scan | No credential and no `.env` in the tree or the PR range |
| Dependency scan | No unallowlisted advisory; allowlist entries carry justification **and a future expiry** |
| Cookie and storage rule | No non-essential cookie or storage identifier |
| Fingerprinting rule | No browser-entropy API anywhere |
| Third-party request rule | No request off-origin from a rendered page, save Turnstile on protected forms; the retired Trustpilot host is a planted red path |
| Vendor-boundary rule | No email SDK outside its provider module |
| Forbidden-copy scan | No never-use string ships |
| Inline-prose scan | No customer-visible prose is inline in an `.astro` component; it lives in the copy layer |
| Price-index isolation scan | The site imports only the price-index tool's `src/publish` and `src/schema`, the tool imports nothing from `src/`, and nothing that builds, starts or deploys the site references or copies the tool (ADR-033) |
| Response-shape test | No public response carries another person's data |

The dependency allowlist holds one exception, `picomatch` advisory 1247710 (GHSA-fc5q-39xc-vjpf), which expires on 2026-12-18 (founder decision D-022, 2026-11-18). The advisory is a ReDoS through repeated extglobs in picomatch 4.0.7 and earlier. It affects both installed copies: 4.0.7, and 2.3.2 under `anymatch`. No patched npm release exists. picomatch ships in the production image as a dependency of `astro` and `@astrojs/node`, but the built server never imports it. It runs only in build, lint and typecheck tooling, on glob patterns written in this repository, and none of them uses extglobs. A test in `test/security-gates.test.mjs` walks every import reachable from `dist/server/entry.mjs`. It fails if the walk reaches `picomatch`, `anymatch`, `tinyglobby`, `fdir` or `@astrojs/internal-helpers/dist/create-filter.js`, and a planted red path proves that it fails. Remove the entry once patched releases cover both the 4.x and 2.x lines. When the entry expires, the dependency gate fails on every branch. Upgrade if a patch exists by then. Otherwise bring a new decision to the founder, and never extend the date without one. The `http-cache-semantics` advisory GHSA-ch52-4w7c-c8xp was excepted until 2026-10-18. That day the founder authorised a lockfile-only update of the transitive package from 4.2.0 to the patched 4.3.0, and E11-08 removed the expired exception. Astro uses the package only to calculate remote-image cache lifetime, and this site has no remote-image pipeline. A test still checks that the installed Astro calls only the package's `storable` and `timeToLive` methods. The test pins the Astro version, so any Astro upgrade must re-run that check. The pin is now Astro 7.4.12. On 2026-11-17 the 2026-11 advisories GHSA-mh32-jxcr-mh9f and GHSA-r3h5-4585-7x3w were fixed by upgrade, to `astro` 7.4.12 and `@astrojs/node` 11.1.13, with the Node runtime moved to 22.23.5 because every patched Astro release requires Node 22.23.4 or later. The `http-cache-semantics` check was re-run at 7.4.12: `assets/build/remote.js` is still the only consumer, through `storable()` and `timeToLive()` (founder decision D-009).

`package.json` overrides two development-only transitive packages, because no parent release allows the patched versions yet: `minimatch` to 11.0.4 (advisory GHSA-g3hv-75wg-m249, fixed in 11.0.1) and `glob` to 14.0.3 (GHSA-3g3m-2fjr-6pw4, fixed in 14.0.2). ESLint, `@eslint/config-array`, `typescript-estree` and `test-exclude` all declare `minimatch` `^10`, and `test-exclude` declares `glob` `^13`. Neither package reaches the production image, which prunes development dependencies. Remove each override once those parents' own ranges include the patched line.

## Secret handling

Never committed. Documented in `infra/ENV.md` by name and purpose. **A leaked secret means rotate, then purge** — committing over it is not remediation, and it is flagged to the founder immediately. The pgBackRest passphrase and the IP-prefix pepper have named procedures (`docs/engineering/ci-cd.md#secrets`).

## Partner dashboard bearer and native settings form

E11.7-09 puts the 30-day bearer in the emailed URL. It authorises one partner's contract, settings and aggregate referrals. A replacement invalidates the prior link, and termination blocks access and issuance. The dashboard sends `no-referrer` and `no-store`, with no page-view request or widget. The recovery form takes only an address and runs on the existing Turnstile-enabled application route. Eligible and ineligible addresses get one conditional acknowledgement and timing policy. Rate limits apply to both a keyed digest of the normalised address and the hashed IP prefix.

D-064 uses the normal exact-origin check first. Only the dashboard settings POST can then pass for a valid Host, the literal `Origin: null` and browser-supplied `Sec-Fetch-Site: same-origin`. Native form submission under `no-referrer` emits those headers. A missing Origin, foreign Origin or non-same-origin metadata does not pass this fallback. The fallback does not authenticate any write. The signed, purpose-bound nonce is required and is consumed in the same transaction as the settings change, after checking the partner's current link and eligibility. Replays, expired nonces and tokens derived from a replaced or terminated link cannot change settings.

## The auto-invite's address in its own link (E11.7-12, D-070)

The E11.7-12 auto-invite links to `/partners/apply?email=<the member's own address>`, so the address shows in the visitor's own URL and fills in the application form. The address is added only when the email is rendered for sending; the queued payload holds no address. No other emailed link carries an address.

This is acceptable because the address goes back only to the person who already holds the link, and nothing along the way keeps it:

- **No storage.** On a GET with no `token`, `partnerApplyPrefillEmail` accepts only a well-formed address of at most 254 characters and passes it to the form's email field. It fills no other field, looks nothing up, stores nothing and authenticates nothing. Anything else leaves the field empty. A submitted application still goes through Turnstile and double opt-in, the same as one typed by hand.
- **No access log.** The Caddyfile has no access-log directive, and the application logs no request URL ([E11-05 privacy audit](../testing/e11-05-privacy-audit.md)).
- **Path-only beacon.** The page-view emitter and the canonical URL use `Astro.url.pathname`, so the query value reaches no analytics event. The page sends `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`.
- **Provider link tracking off.** Open and click tracking stay off in both provider accounts ([email module](../modules/email.md)), so the link is not rewritten through a provider redirect that would record it.

The remaining exposure is the visitor's own browser history and their mailbox, which already hold the address. The E11-05 route-shape guard exempts only this one exact call on this one page; any other email-bearing value rendered there still fails it.
