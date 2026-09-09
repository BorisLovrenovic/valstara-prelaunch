# Threat Model

Status: authoritative. Scope: the pre-launch site for the duration of the campaign.

**What this system holds is smaller than a storefront's and more exposed.** No payment data, no credentials in custody, no order history — but a public write endpoint on the root domain of a brand whose entire proposition is trustworthiness, a prize draw with real money behind it, and an email list that is the campaign's only durable asset.

---

## T1 — The email list leaks

**The highest-consequence outcome.** Not because the data is sensitive in isolation, but because a leaked pre-launch list is a story that follows the brand into launch, and the audience is already suspicious.

**Controls:** No route returns another person's data — `/me` returns only the bearer's row, and the leaderboard is anonymised. **Resend-verification returns an identical response for known and unknown addresses, padded to a 250 ms post-challenge minimum**, so the endpoint is not an enumeration oracle. Exports are admin-only, audited with a row count, and batch-capped. The database is not exposed on a host port in production. **A generated test asserts that no public response shape can carry an email address** except the bearer's own on `/me`.

---

## T2 — Referral fraud discredits the leaderboard

Reputational, not financial. A leaderboard that visibly rewards a cheat is worse than no leaderboard.

**Controls:** Structural first — **cheap rewards on verification, high-value rewards held until a post-launch first order** (ADR-012). Then normalisation before uniqueness, blocklist and MX, self-referral and velocity flags, and **manual review of the top 20 before any award**. Flagged accounts are excluded from the snapshot. The disqualification rule is **published**, because an unpublished rule cannot be enforced fairly. `leaderboard.public` is the incident lever, and it works without a deploy.

---

## T3 — The sending reputation is destroyed

The campaign's single unrecoverable technical failure. It has two shapes.

**Shape one: the migration send lands in spam.** Unrepeatable — those ~100 recipients get one announcement. **Controls:** send from `subslush.com`, full authentication per domain, validate the addresses first, **stage by recency and stop between batches**.

**Shape two: verification mail quietly stops arriving.** It looks exactly like poor conversion. **Controls:** transactional and broadcast are split across providers and domains so a marketing complaint cannot touch verification; **verification *rate* is alerted on hourly**; weekly seed tests round-trip into Gmail, Outlook, GMX and Web.de.

---

## T4 — A privacy failure forces a consent banner

The site operates with no banner because it sets no non-essential cookie and makes no unsanctioned third-party request. The only off-origin requests a rendered page may make are two consent-free, Cloudflare-adjacent exceptions on the third-party gate's allowlist — the flagged Trustpilot widget and the Cloudflare Turnstile challenge (ADR-006, Option A, founder-authorised 2026-09-08) — neither of which sets a cookie or fingerprints. **One careless dependency reverses that**, and the cost is not a banner — it is the conversion the banner takes and the measurement it corrupts.

**Controls:** three CI gates — the cookie/storage rule, the fingerprinting rule and the third-party request rule — each with a planted fixture. Referral attribution is server-side and signed. Analytics is cookieless and its event registry is asserted free of personal data. **A new dependency that reaches the browser requires an explicit note in the PR describing what it loads.**

---

## T5 — Bots inflate the list

A waitlist full of fake addresses corrupts every metric, burns email quota, and makes the handoff worthless.

**Controls:** Turnstile verified **server-side** on every write route, before any other work; **fail closed on invalid, accept-and-flag on provider timeout**. Rate limits per IP prefix and per identity. Blocklist and MX. **Double opt-in is the real filter** — a bot-created row that never verifies is never counted, never exported, and expires.

---

## T6 — Giveaway non-compliance

Several target jurisdictions regulate prize draws directly: Italy requires local data hosting and a ministry notification, Poland permits and bank guarantees, Spain requires the draw to occur in Spain plus a 10% prize tax, and Quebec has its own regime.

**Controls:** exclusion **at point of entry**, enforced in code and table-tested per jurisdiction. Per-jurisdiction rules pages with all required sections, schema-validated. `rules_version` stamped on every accrual. **A reproducible draw** — seed and snapshot hash recorded, result unpublished until it reproduces. AMOE wherever required, with equal weight.

---

## T7 — Admin compromise

One operator, one credential, and the ability to disqualify, export and draw.

**Controls:** MFA mandatory and verified, not assumed. **Every admin action is audited**, and the audit log is append-only by database permission — the application role has no `UPDATE` or `DELETE`. Admin routes are not linked from the public site and are excluded in `robots.txt`. A second draw execution is refused.

---

## T8 — The box goes down under a viral spike

**Controls:** static pages absorb the spike through Cloudflare, so the origin sees only writes. **The leaderboard — the one route a spike can hammer — serves from a cached snapshot and never runs a live query.** Hard memory limits with no swap, so contention produces a restart rather than slow degradation. Every sweep and export is batch-capped and streamed. **The signup endpoint is load-tested at 10× expected peak** before the campaign opens (E11-01).

---

## CI security gates

Each has a planted red-path fixture; **a gate that cannot be shown to fail is not a gate.**

| Gate | Asserts |
|---|---|
| Secret scan | No credential and no `.env` in the tree or the PR range |
| Dependency scan | No unallowlisted advisory; allowlist entries carry justification **and a future expiry** |
| Cookie and storage rule | No non-essential cookie or storage identifier |
| Fingerprinting rule | No browser-entropy API anywhere |
| Third-party request rule | No request off-origin from a rendered page, save the two allowlisted Cloudflare-adjacent exceptions (flagged Trustpilot, always-on Turnstile) |
| Vendor-boundary rule | No email SDK outside its provider module |
| Forbidden-copy scan | No never-use string ships |
| Inline-prose scan | No customer-visible prose is inline in an `.astro` component; it lives in the copy layer |
| Response-shape test | No public response carries another person's data |

## Secret handling

Never committed. Documented in `infra/ENV.md` by name and purpose. **A leaked secret means rotate, then purge** — committing over it is not remediation, and it is flagged to the founder immediately. The pgBackRest passphrase and the IP-prefix pepper have named procedures (`docs/engineering/ci-cd.md#secrets`).
