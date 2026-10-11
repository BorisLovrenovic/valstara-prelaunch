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

The site operates with no banner because its two documented browser-storage entries are the functional theme preference and Cloudflare Turnstile's `cf.turnstile.u`, which the widget reads and writes only on protected forms under the Article 5(3) strictly-necessary form-security basis (founder-authorised 2026-10-10, pending legal sign-off). It makes no unsanctioned third-party request. The only off-origin host a rendered page may contact is Cloudflare Turnstile on protected forms (ADR-006, Option A, founder-authorised 2026-09-08). The site runs no device-fingerprinting API; Cloudflare processes IP, TLS and user-agent signals server-side as a security processor, as the privacy disclosure states. **One careless dependency reverses that**, and the cost is not a banner — it is the conversion the banner takes and the measurement it corrupts.

**Controls:** three CI gates — the cookie/storage rule, the fingerprinting rule and the third-party request rule — each with a planted fixture. Referral attribution is server-side and signed. Analytics is cookieless and its event registry is asserted free of personal data. **A new dependency that reaches the browser requires an explicit note in the PR describing what it loads.**

**E11-05 local audit, revised 2026-10-10:** The [complete rendered-page and route inventory](../testing/e11-05-privacy-audit.md) and executing-loader check exposed an unapproved Trustpilot follow-on request to `images-static.trustpilot.com`. The founder removed the pre-launch widget, and the browser check now permits only Turnstile on protected forms. The allowlist contains exactly that one host and the retired Trustpilot host has a red-path fixture. The same-origin Umami emitter remains; no `static.cloudflareinsights.com` request was seen. Production Cloudflare injection remains a separate E12-05 check; no host is pre-approved for it.

**E11-05 amendment, founder-authorised 2026-10-10:** The activated Turnstile widget's Cloudflare-origin `cf.turnstile.u` read and write are the second published inventory entry. The rendered-page probe checks every page for storage access and cookies, and requires a completed token from each protected form. Valstara's source-code storage gate still permits only the theme write. The [audit report](../testing/e11-05-privacy-audit.md) records the activation regression and its result.

---

## T5 — Bots inflate the list

A waitlist full of fake addresses corrupts every metric, burns email quota, and makes the handoff worthless.

**Controls:** Turnstile verified **server-side first** on public, unauthenticated write routes; writes authenticated by a single-use signed token consume that token in place of Turnstile (founder-authorised 2026-09-28). Both kinds are rate-limited. Invalid challenges fail closed; provider timeouts accept under strict limits and flag. Cross-origin form writes are rejected in middleware except the RFC 8058 `/api/unsubscribe` route, whose signed single-use token is the authenticator. Blocklist and MX. **Double opt-in is the real filter** — a bot-created row that never verifies is never counted, never exported, and expires.

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

**Controls:** static pages absorb the spike through Cloudflare, so the origin sees only writes. **The leaderboard — the one route a spike can hammer — serves from a cached snapshot and never runs a live query.** Hard memory limits with no swap, so contention produces a restart rather than slow degradation. Every sweep and export is batch-capped and streamed. **The signup endpoint is load-tested at 10× expected peak** before the campaign opens (E11-01).

E11-01's local correctness exercise uses the founder-authorised 20/s sustained, 50/s burst and 200/s leaderboard profile, plus a deliberately large streamed export. The reproducible script, capped-query inventory, memory samples and measured result are recorded in [`docs/testing/e11-01-load-report.md`](../testing/e11-01-load-report.md). Capacity on the actual host remains E12-06.

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
| Response-shape test | No public response carries another person's data |

The `http-cache-semantics` advisory GHSA-ch52-4w7c-c8xp is excepted through 2026-10-18 because its vulnerable shared-cache reuse method is not called by the pinned Astro consumer. Astro uses the package only to calculate remote-image cache lifetime, and this site has no remote-image pipeline. A test checks the installed Astro call path; the exception must be removed when a patched release is available.

## Secret handling

Never committed. Documented in `infra/ENV.md` by name and purpose. **A leaked secret means rotate, then purge** — committing over it is not remediation, and it is flagged to the founder immediately. The pgBackRest passphrase and the IP-prefix pepper have named procedures (`docs/engineering/ci-cd.md#secrets`).
