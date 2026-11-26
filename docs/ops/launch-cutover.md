# Launch Cutover

Status: authoritative. This describes the **store launch**, which happens after the campaign ends. It is documented here because the pre-launch repository owns half of it.

**Because the repositories are separate, launch is a host swap at the DNS/proxy layer on `valstara.com` — not a deploy.** A swap is riskier than a deploy, which is why it is a rehearsed checklist rather than a decision made on the day (ADR-021).

---

## What must be true before cutover day

| Item | Owner | Verified by |
|---|---|---|
| Trust pages ported into the storefront at **identical URLs** | Storefront | Port checklist, `docs/brand/tokens.md#port-checklist` |
| Legal pages ported **and revised** for the store's processing | Storefront + counsel | Manual |
| `tokens.css` copied verbatim; no drift from this repository | Storefront | Diff against this repo — **any difference is reconciled here first** |
| Storefront verified on a staging host serving those URLs | Storefront | Manual |
| The handoff import **rehearsed twice against a scratch database** | This repository | E11-06 |
| Redirects configured: `/waitlist`, `/leaderboard`, `/me` → `301` | Storefront | Manual |
| Giveaway rules pages **retained**, not redirected | Both | Manual |
| Draw published; every giveaway award `confirmed`, `delivered` or `exhausted` | This repository | Export preflight refuses otherwise |
| Unexpired unsubscribe tokens imported, with hash, owner, origin and expiry; one-click POST tested | Storefront | Scratch import and `scripts/cutover-check.ts` |
| Storefront privacy-rights and email-preferences destinations serve `200` | Storefront | `scripts/cutover-check.ts` |
| The attribution export imported, and `/r/{CODE}` served under the [URL contract](#the-rcode-url-contract) with the imported partner codes | Storefront | Manual: an imported `active` partner code redirects to `/?ref={CODE}`; a `paused` one, a member code and an unknown code redirect to `/` |

**The trust pages are the reason this is a checklist.** They have accumulated ranking authority at their permanent URLs for three months; a cutover that breaks them throws that away silently.

---

## The route disposition

| Route | Before | After |
|---|---|---|
| `/` | Waitlist landing page | Storefront home — **same URL, new content** |
| `/legit`, `/guarantee`, `/about` | Trust content | Ported, same URLs; `200` |
| `/trust-ledger` (E11.8-01) | The Trust Ledger and every past entry, rendered on request from the entries in `src/content/trust-ledger/` and `src/content/trust-ledger-how-we-count.md`, behind `trust_ledger.page` (`404` while the flag is off or no entry is committed) | A permanent URL the storefront keeps: ported, same URL; `200`; past entries never edited |
| `/sitemaps/trust-ledger.xml` (E11.8-01) | The Trust Ledger's child sitemap, rendered on request: `/trust-ledger` while `trust_ledger.page` is on and an entry is committed, else an empty `<urlset>`. `/sitemap.xml` and the other `/sitemaps/*.xml` are static files, not routes | Not ported as a file; the storefront's own sitemap lists `/trust-ledger` |
| `/terms`, `/privacy`, `/privacy/storage` | Legal and storage inventory | Ported and revised in place; `200` |
| `/giveaway/rules`, `/giveaway/rules/<rules_version>` | The global rules page and all four immutable revisions (ADR-026) | **Kept live** with `200` for 12 months after the final award, then `410`; revisions kept internally for 6 years |
| `/waitlist`, `/leaderboard` | Campaign mechanics | `301` to storefront `/` |
| `/me` | Member status | `301` to the storefront account area |
| `/partners`, `/partners/apply` | The pre-launch partner programme page and its application (E11.7-05), behind `partners.enabled` | Campaign mechanics: applications close at the freeze, then both `301` to storefront `/`. Partner attribution and codes are handed over through E11.7-14's export, not through these pages |
| `/partners/dashboard` | Private pre-launch dashboard with expiring links (E11.7-09), behind `partners.enabled` | The host swap ends access to the waitlist dashboard and its signed settings form. E11.7-14 hands partner attribution over to the storefront |
| `/partners/dashboard/flyer` | The partner's print flyer behind the same private link (E11.7-11), behind `partners.enabled` | The host swap ends access with the dashboard. Printed flyers carry only the permanent `/r/{CODE}` link and its QR code, which the storefront must serve identically |
| `/r/[code]` | Permanent partner short link (E11.7-07) | Storefront serves the same URL with the [existing redirect behaviour](../features/partner-programme.md#links-and-codes) |
| `/dsr` | Privacy-rights request | `301` to storefront privacy-rights page |
| `/unsubscribe`, `/api/unsubscribe` | Email preference and RFC 8058 one-click endpoint | Storefront handles every imported, unexpired token at these paths, hashing the presented token and applying marketing withdrawal; a transactional-origin token also suppresses non-essential mail. After the token expires, both paths `301` to storefront email preferences |
| `/giveaway/award` | Provisional award response | `410`, only after the draw is published and every award is terminal |
| `/verify`, all other `/api/*` | Campaign endpoints | `410` after the verification window. **Any live verification token becomes unusable — send the final reminder before the full freeze** |
| `/prices/[service]/[country]` | Service × market price page (E11.6-10), behind `prices.pages`. A URL the founder has retired answers `301` to its recorded hub (E11.6-12) | Permanent URL that survives into the storefront (Epic E11.6): ported at the same URL; `200`, and each retirement in `data/price-index/published-urls.json` ported as the same `301` |
| `/prices`, `/prices/[service]`, `/prices/countries/[country]` | The price index and the service and market hubs (E11.6-12), behind `prices.pages` | Permanent URLs that survive into the storefront (Epic E11.6): ported at the same URLs; `200` |
| `/price-index`, `/price-index/[month]` | The price index's methodology (`src/content/price-index-methodology.md`, `portTarget: /price-index`) and its monthly reports (E11.6-13), behind `prices.pages` | Permanent URLs that survive into the storefront (Epic E11.6): ported at the same URLs; `200`, one report per `data/price-index/monthly/YYYY-MM.json`, and a month with no report answering `404` |
| `/404`, `/500` | Branded error pages (E11.5-10) | Not ported; the storefront's own error pages answer |

Port the versioned Markdown sources from `src/content/giveaway-rules/` and preserve the recorded SHA-256 of each rendered rules article. The current revision is `VAL-GW-LAUNCH-20261126-r1` (E11.8-05: entries close at 23:59:59 UTC on 31 August 2027 and winners are drawn on 1 September 2027); the earlier `VAL-GW-LAUNCH-20260925-r1`, `VAL-GW-LAUNCH-20261001-r1` and `VAL-GW-LAUNCH-20261009-r1` revisions remain directly served at their permanent URLs as archived records, with the E11-04 notice, `noindex`, and sitemap exclusion. The current URL and all four permanent URLs must remain directly served after cutover. The port-checklist reconciliation must assert that the revision named here equals `currentRules()`.

The retired API inventory is explicit: `/api/signup`, `/api/resend-verification`, `/api/survey`, `/api/leaderboard`, `/api/me/leave`, `/api/me/marketing`, `/api/dsr/export`, `/api/dsr/delete`, `/api/webhooks/<provider>`, `/api/admin/draw`, `/api/admin/export.csv`, `/api/admin/fraud`, `/api/admin/fraud/<id>`, `/api/admin/health`, `/api/admin/referrals/void`, `/api/admin/referrals/unvoid`, `/api/admin/partners`, `/api/admin/partners/export.csv`, `/api/admin/partners/<id>`, `/api/admin/partners/<id>/approve`, `/api/admin/partners/<id>/reject`, `/api/admin/partners/<id>/contract-sent`, `/api/admin/partners/<id>/contract-signed`, `/api/admin/partners/<id>/pause`, `/api/admin/partners/<id>/terminate`, `/api/admin/partners/<id>/reactivate`, `/api/admin/partners/<id>/type`, `/api/admin/partners/<id>/note`, `/api/admin/partners/announce` (E11.7-16), `/api/admin/trust-ledger/waitlist` (E11.8-01) and `/api/admin/reports/sources` (E11.8-02) all return `410` after cutover. `/api/unsubscribe` is the sole retained campaign API path, transferred to the storefront under the token contract above. Every path in `src/pages/` is represented by the route table or this API inventory; the port-checklist test reconciles that set in both directions.

### The Trust Ledger (E11.8-01)

**At go-live, December 2026.** This repository commits no entry before then (founder decision D-076 Q2), so `/trust-ledger` answers `404` and no link to it renders. The founder publishes the first entry:

1. Run `npm run trust-ledger -- draft --month 2026-12` (the secret key and a fresh authenticator code, against the production admin API). It writes `src/content/trust-ledger/2026-12.json` with the month's waitlist counts and every other section empty.
2. Paste in the founder sections, P11 Part 2 (`docs/prerequisites/p11-trust-ledger-text.md`), as `docs/features/trust-ledger.md#the-monthly-entry` shows.
3. Confirm P11's three checks: the go-live date in the policy changes, the partner counts (`partners list`), and the giveaway line in build progress.
4. Merge it through the ordinary pull request, CI and deploy. The links from `/guarantee`, `/partners` and the footer appear with that deploy.
5. Turn `trust_ledger.page` on with the flag command (`node ./src/server/flags/cli.ts set trust_ledger.page on --actor <operator>`, audited, `docs/ops/runbook.md`). The page and its child sitemap follow within five seconds.

**At cutover**, the storefront ports `/trust-ledger` at the same URL with every entry unedited, and keeps publishing monthly entries there.

---

## The handoff sequence

Rehearsed twice against a scratch database before the day (E11-06). **A rehearsal that is not idempotent — running it twice produces duplicate customers — is a blocking finding.**

1. **Close signups.** Set `signup.enabled` off and record the change in the audit log.
2. **Send the final reminder** to every pending, unsuppressed subscriber with `scripts/send-final-reminder.ts --actor=<operator>`. The command is batch-capped and idempotent, and issues a fresh seven-day verify token. Drain the transactional queue before starting the window; record queued and delivered counts.
3. **Verification window.** Keep `/verify` live for a configurable 72 hours, within the seven-day verify-token expiry.
4. **Full freeze.** Block public write endpoints at the proxy and pause the maintenance process. Verify both controls, then run `tsx scripts/record-handoff-freeze.ts --actor=<operator> --proxy-blocked-confirmed --maintenance-paused-confirmed` to audit the freeze. Audited handoff operations remain permitted through export and import; this is not the database read-only transition.
5. **pgBackRest snapshot.** The point-in-time everything else references.
6. **Export**: verified, unsuppressed, not disqualified. The command refuses unless the draw is published and all awards are terminal. Its NDJSON also carries every unexpired, unconsumed unsubscribe token as `unsubscribe_token` with `token_sha256`, owner `email_normalised`, `origin_kind` and `expires_at`, including owners outside the customer export set. **Then run the attribution export** against the same frozen database, after the handoff export so it reads the coupons and waves the handoff recompute left: `npm run export:attribution -- --actor=<operator> --output=<new private directory>` ([the attribution hand-over](#the-attribution-hand-over-e117-14)). Run it twice into two directories and compare the files byte for byte; any difference means the database changed and the freeze did not hold.
7. **Idempotent import keyed on `email_normalised`** → `createCustomersWorkflow` with metadata (`referral_tier`, `referral_code`, `confirmed_referrals`, `category_preference`, `survey_version`, `access_window`, `source`, `subslush_customer`, and the marketing-consent state). The storefront interprets v1 and v2 category tokens using the paired survey version (ADR-031). **The storefront sends marketing only to customers whose consent is present** (ADR-027). The E11-06 scratch import proves the original contract; E11.5-02 tests the amended v1/v2 customer payload with two imports. The Medusa-side implementation lives in the storefront repository.
8. **Assign customer groups** `wave-1`…`wave-4` and `subslush-legacy`. **Groups, not metadata, are what promotions and price lists target** — the metadata carries provenance, the group carries the access it grants.
9. **Import confirmed referral pairs and held coupon records.** Both people in each pair and every coupon owner must be in the customer import set. The coupon's owner `email_normalised` is its customer import key. **Import the attribution export** into the main platform's affiliate system: partners by `partner_id`, referrals by `edge_id`, coupons by `coupon_id` (the same IDs as the `held_coupon` records, so a coupon imported from both files is one coupon) and welcome discounts by `subscriber_id`, each linked to its customer by `email_normalised`. Importing the same files twice must add nothing.
10. **Carry held coupons to the storefront** (E11.7-03). Every coupon of the referrer ladder whose owner is in the customer export set is exported as `held_coupon` with its coupon number, percent, state `held`, outcome `carried_to_storefront` and `expires_at`, five years after the configured public-launch date (`couponLadder.publicLaunchDate`, default 2027-10-01, so 2032-10-01T00:00:00.000Z). **Set the real launch date in that configuration before export**; it is not a command argument. Each carried coupon is audited as `handoff.coupon_carried` with its expiry. The storefront makes all of an owner's coupons usable once any one of that owner's confirmed referred people places a first order, until the expiry (ADR-012, as amended); nothing in this repository settles a coupon. A void coupon, and a coupon whose owner is disqualified, suppressed, departed or erased, is not exported. Marketing withdrawal alone does not block a verified, unsuppressed owner. The retired milestone awards were voided with `ladder_replaced` by migration 0061 and are never exported; the export still runs its E11-06 passes, voiding any held discount of an ineligible owner and any legacy bonus-entry award in bounded batches with an audited reason, and finds none. **It then recomputes every verified subscriber's coupons and wave** under the configured ladder, in batches of at most 1,000, before its snapshot, so the file follows the configuration even where the daily repair has not reached an owner. Each subscriber it changes is audited as `handoff.rewards_recomputed` with the operator and the coupons and access window before and after, and the command's printed counts carry the number changed as `recomputedRewards` (D-047).
11. **DNS/proxy cutover.** Run `tsx scripts/cutover-check.ts --base-url=<storefront-origin> --unsubscribe-token=<unexpired-test-token> --expired-unsubscribe-token=<expired-test-token> --account-path=<approved-account-path> --privacy-rights-path=<approved-privacy-rights-path> --email-preferences-path=<approved-email-preferences-path>` against the live storefront before changing DNS; any failed retained `200`, recorded rules hash, archived notice, `noindex` and sitemap exclusion, exact redirect-to-`200`, decided `410` or one-click unsubscribe POST aborts the cutover. Re-run after the swap. E11-07 runs the same probe against a local fixture server, without changing DNS. Use dedicated test tokens and retain them outside the repository. Confirm the imported test subscriber's marketing withdrawal and, for a transactional-origin test token, non-essential-mail suppression in the storefront after the probe. **Switching `/r/` routing is part of this swap:** from the moment it takes effect, the storefront answers `/r/{CODE}` under the [URL contract](#the-rcode-url-contract), and an active imported partner code must redirect exactly as it did here.
12. **Set the waitlist database read-only for 90 days** as the audit trail, except for named-operator erasure. Set the routine application role to `default_transaction_read_only=on` for the waitlist database, stop the app's write access, and test that a routine write fails. A request received through the storefront privacy-rights page requires verified identity evidence; the named operator uses a separate privileged `DATABASE_URL` and runs `scripts/request-erasure.ts --subscriber-id <uuid> --actor <name> --evidence-ref <opaque-reference>` against the waitlist database, deletes the Brevo contact, then runs `scripts/complete-erasure.ts --subscriber-id <uuid> --actor <name>`. Both actions are audited. Restrict that privileged connection to the erasure procedure and verify the routine role remains read-only afterward.

Record elapsed time for every rehearsal step. Record the verification-window duration as a configurable parameter, including its 72-hour launch value, in the total cutover timeline; do not wait 72 hours during the local rehearsal. Do not change DNS during the rehearsal.

The E11-07 local rehearsal runs with `tsx scripts/rehearse-cutover.ts --verification-window-hours=72 --evidence=<new-private-evidence-path>`. Its recorded 72-hour run is [e11-07-rehearsal.json](e11-07-rehearsal.json): all twelve steps passed on a disposable source database and local route fixture, including a pgBackRest snapshot containing that source, a two-database double import, and a routine-write denial after the read-only switch. The evidence records per-step elapsed time and the projected local timeline with the configured window. It identifies the local substitutes for external email delivery, proxy controls and the Medusa workflow; their real durations and the DNS propagation interval are measured on cutover day.

---

E11-06's handoff file is NDJSON. `customer` records contain the twelve original customer fields, `survey_version`, and assigned groups; `held_coupon` records carry the coupon ID, owner ID and key, coupon number, percent, `held` state, carry outcome and computed expiry; `confirmed_referral` records carry the two normalised email keys; `unsubscribe_token` records carry only the token hash, normalised owner email, origin kind and expiry. The export command requires `--actor=<operator>` and `--output=<new private path>` with `DATABASE_URL` set to the frozen waitlist database. The import rehearsal requires `--input=<handoff NDJSON>` and `--evidence=<new path>` with `HANDOFF_REHEARSAL_ADMIN_URL` set to a PostgreSQL owner URL. It creates two scratch databases, imports the same file twice into each, rejects any additional customer, group, coupon, referral pair or unsubscribe token on the second pass, and drops both databases. The synthetic pre-launch rehearsal evidence is in `docs/ops/e11-06-rehearsals.json`; the launch-day run uses the real export and retains only aggregate evidence in the repository.

The exporter audits `carried_to_storefront` outcomes only after the NDJSON file finishes writing, and commits those carry audits together. A write failure removes the partial file without recording any carry outcome. If auditing fails after the file finishes, the complete file remains for diagnosis; a nonzero command exit is not an approved handoff and must not be imported.

---

## The attribution hand-over (E11.7-14)

This is the contract the main platform's affiliate system imports the pre-launch partner programme under (Epic E11.7; [the programme](../features/partner-programme.md)). It covers what the customer handoff above does not: who referred whom, through which partner and how, what was voided, and every coupon and welcome discount. The export's file layout, types and encoding are in [`docs/data/attribution-export.md`](../data/attribution-export.md); `test/attribution-export.test.ts` checks that every field defined below exists in a real export and that the export holds no field this document leaves undefined.

**This repository calculates no commission, credit or payout, and settles no coupon.** It records who referred whom. The main platform pays and settles.

### The cutover steps

The attribution hand-over follows the [handoff sequence](#the-handoff-sequence):

1. **Sign or reject every unsigned partner** (D-073 Q2, before step 1). Only a partner with a signed contract (`active`, `paused` or `terminated`) is exported, so no partner may be left `approved` or `contract_sent` at the freeze. List them with `npm run admin -- partners list --status approved` and `npm run admin -- partners list --status contract_sent`. Record each signed contract with `partners contract-signed`, which activates the partner; it accepts only a `contract_sent` partner, so an `approved` partner whose contract was signed first needs `partners contract-sent`, then `partners contract-signed`. Close each one that will not go ahead with `partners reject` ([Reviewing partners](runbook.md#reviewing-partners-e117-06)). Both lists must be empty before writes are frozen; do not freeze while either holds a partner.
2. **Freeze writes** (steps 1–5): signups closed, the verification window run, public writes blocked, maintenance paused and the snapshot taken.
3. **Export** (step 6): `npm run export:attribution -- --actor=<operator> --output=<new private directory>`, after the handoff export. Two runs of an unchanged database are byte-identical.
4. **Import** (steps 7–9): customers first, then the attribution export, idempotently, by the keys in step 9.
5. **Switch `/r/` routing** (step 11): the storefront serves `/r/{CODE}` under the contract below from the moment of the swap.
6. **Keep this database read-only for 90 days** (step 12, ADR-022) as the record of how every attribution came about, then review it for deletion.

### The `/r/{CODE}` URL contract

`https://valstara.com/r/{CODE}` is permanent. It is printed on flyers and encoded in partners' QR codes, so **the main platform must serve it with identical behaviour** (`src/server/partner/short-link.ts` is the reference implementation):

- A `GET` upper-cases the lower-case letters of `{CODE}`.
- If the result is 4 to 16 of `A`–`Z` and `0`–`9` and is the partner code of a partner whose status is `active`, the response is `302` with `Location: /?ref={CODE}`, the code in upper case.
- Anything else answers `302` with `Location: /`, recording no referrer: an unknown or malformed code, a member code, the code of a `paused` or `terminated` partner, the programme switched off, or a failed lookup.
- Every response carries `Cache-Control: no-store`, an empty body and no cookie.
- The landing page reads `ref` on the server. Attribution is server-side and signed, with no cookie and no client-side path (ADR-008).

### The code rules

- **One namespace.** Member and partner codes share one registry, so a code identifies exactly one owner. Codes are case-insensitive, stored and exported in upper case, and two codes differing only in case never both exist.
- **Partner codes** are 4 to 16 of `A`–`Z` and `0`–`9`. A code is refused if it matches the blocklist (`config/partner-code-blocklist.json`: brand and provider names, reserved words and profanity, each term matching anywhere in a code or only as the whole code). The founder reviews every partner code at approval.
- **Member codes** are 12 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (E4-01).
- **A partner's own member code attributes to the same partner** while the partner is active, so `partner_code` and `member_code` both name one partner.
- **One referrer per person, fixed at signup.** A typed code beats the link's code (ADR-008, as amended by E11.7-08). Only a founder correction changes a referrer.
- **A retired code is never reissued.** The code of an erased member, or of a partner whose personal data was purged, stays taken, and the export does not list it.

### Field definitions

#### `partner` records

| Field | Definition |
|---|---|
| `partner_id` | The partner's identifier. A `referral` record's `partner_id` names it |
| `subscriber_id` | The partner's own member record. The partner's own referrals have it as `referrer_subscriber_id` |
| `legal_name` | The full name given in the application, as on the contract |
| `email` | The partner's address as entered |
| `email_normalised` | The partner's normalised address: the customer import key |
| `country` | The country of residence given for the contract (ISO 3166-1 alpha-2). The only country this repository holds outside a giveaway award (ADR-026) |
| `partner_type` | `standard`, `student_ambassador` or `creator` |
| `status` | `active`, `paused` or `terminated` at export. Only `active` codes redirect |
| `partner_code` | The partner's registered code, served at `/r/{CODE}` |
| `member_code` | The partner's own member referral code |
| `approved_at` | When the founder approved the application |
| `contract_signed_at` | The date the partner contract was signed |
| `contract_version` | The version of the contract signed |
| `founding_partner` | Always `true`: every exported partner was accepted during the pre-launch campaign, so the pre-launch commission terms below apply |
| `display_name` | The partner's optional display name from their dashboard, or null |

#### `referral` records

| Field | Definition |
|---|---|
| `edge_id` | The referral's identifier |
| `referred_subscriber_id` | The referred person's member record |
| `referred_email` | The referred person's address as entered |
| `referred_email_normalised` | The referred person's customer import key |
| `referrer_subscriber_id` | The referrer's member record |
| `referrer_email_normalised` | The referrer's customer import key |
| `referrer_type` | `partner` for a partner referral, credited to `partner_id`; `member` for a member referral |
| `partner_id` | The credited partner on a partner referral; null on a member referral |
| `partner_code` | The credited partner's code on a partner referral; null on a member referral |
| `attribution_method` | `link` (a referral link or `/r/` code), `code` (a code typed at signup) or `retroactive` (a confirmed referral the person made before becoming an active partner, credited to them at activation) |
| `signup_at` | When the referred person signed up. The pre-launch commission terms cover a customer whose partner referral exists in this export |
| `confirmed_at` | When the referred person confirmed their address, which made the referral count |
| `voided` | `true` when the founder voided the referral: it counts for nothing, earns no coupon, wave, commission, credit or welcome discount, and is kept only as a record |
| `voided_at` | When it was voided, or null |
| `void_reason` | The founder's reason for the void, or null |
| `referred_access_window` | The referred person's early-access wave, `wave-1` to `wave-4` |
| `referred_early_access` | Whether the referred person is in wave 1, early access from 1 September 2027 |
| `welcome_discount_pct` | The referred person's welcome discount on their first order: 10, 15 or 20, on a partner referral that is not voided; null otherwise |
| `welcome_discount_expires_at` | When that welcome discount expires, or null |

#### `coupon` records

| Field | Definition |
|---|---|
| `coupon_id` | The coupon's identifier, the same as in the customer handoff's `held_coupon` record |
| `subscriber_id` | The member who owns it, the referrer |
| `email_normalised` | The owner's customer import key |
| `coupon_number` | Its place in the ladder: 1, 2 or 3 |
| `percent` | Its discount, 5% to 30% |
| `state` | Always `held` |
| `expires_at` | When it expires |

#### `welcome_discount` records

| Field | Definition |
|---|---|
| `subscriber_id` | The member who owns the welcome discount |
| `email` | Their address as entered |
| `email_normalised` | Their customer import key |
| `welcome_discount_pct` | Their welcome discount on their first order: 10, 15 or 20 |
| `wave_one` | Always `true`: they keep the wave-1 place that came with it |
| `expires_at` | When it expires |

A `welcome_discount` record is the friend's own entitlement, kept where no exported referral carries it: their partner was erased (D-058), or their partner referral is not exported because the partner was disqualified, left the waitlist, or had their personal data purged (D-073 Q4). **It carries no partner attribution, referral credit or commission.** A friend's welcome discount appears exactly once, on their partner referral or in this record.

**Who is exported.** Partners with a signed contract (`active`, `paused`, `terminated`) whose member record is verified, and the referrals and coupons of people in the customer export set (D-073 Q1, Q2). A contracted partner whose address is suppressed is still exported, with their partner referrals to friends in the set, because the partner contract, not waitlist mail consent, is the basis for the commission attribution (D-073 Q3). A suppressed partner is not in the customer handoff, so their `email_normalised` matches no imported customer; the main platform links them by `partner_id` for commission, and must not treat the partner record as a customer account or a marketing permission. Their member referrals and coupons follow the customer export set and are not exported.

### Coupons and welcome discounts

- **Coupons are held, never usable on arrival** (ADR-012, as amended by E11.7-03). The main platform makes all of an owner's coupons usable once **any one** of the owner's confirmed referred friends places a first order: one of the `referral` records with the owner as referrer and `voided = false`. The pre-launch repository never settles a coupon, and generates no checkout code.
- **Each coupon is single-use** and usable on any order. Only one discount applies per order: coupons never stack with each other or with any other discount.
- **The welcome discount** is the referred friend's own discount on their first order, single-use. It was fixed when the friend signed up, from the partner's confirmed referrals at that moment: 10% below 21, 15% from 21 to 38, 20% from 39, and at least 15% for a student ambassador's friends. It exists only on partner referrals. It creates no reward for the partner. A person holding a welcome discount and coupons chooses one per order.
- **Both expire five years after the configured public-launch date**, as `expires_at` and `welcome_discount_expires_at` state. The date is `couponLadder.publicLaunchDate` in `src/server/referral/config.ts` (default 2027-10-01, so 2032-10-01T00:00:00.000Z). The founder sets the real date before export, and the export carries the computed expiry.

### The pre-launch commission window (epic decision 2, 2026-11-22)

A partner earns **10% commission only on orders placed by customers they referred during the pre-launch campaign**: the customers of the `referral` records with `referrer_type = partner` and `voided = false`, credited to that partner. It counts every order those customers place **from early access (1 September 2027) until one year after public launch (1 October 2028)**. After that, those customers are no longer attributed to the partner under these terms. The one-year founding rate lock is this window; there is no lifetime lock. **Customers a partner refers after public launch fall under the post-launch rates**, agreed separately. Commission is 10% of order value, on all products, one level only: nothing is earned for recruiting another partner. The main platform calculates and pays it.

### The $5 store credit (founder decision, 2026-11-17)

In the founder's words: "The $5 store credit per referrer is ONLY for referrals that completes a purchase once we have launched. The store credit should ONLY be available to normal users that refers friends, NOT to partnered users that are part of the partner programme. Parntered users does NOT receive $5 store credit for each purchase-confirmed referral, instead they receive 10% cash comission on each order placed by the referrals for the first year."

So a member referral (`referrer_type = member`, `voided = false`) earns its referrer $5 store credit once the referred customer completes a purchase after launch. A partner referral earns no store credit; it falls under the commission window above. A signup alone earns nothing. **Only the main platform pays it; this repository records no credit and calculates nothing.**

## Verification after the swap

Not "the site loads". Specifically:

- Each of `/legit`, `/guarantee`, `/about`, `/terms`, `/privacy` returns `200` **with its content**, from a cold client.
- Every `/giveaway/rules/*` URL still returns `200`.
- `/waitlist`, `/leaderboard`, `/me`, `/dsr` return `301` and each destination returns `200`.
- `/giveaway/award`, `/verify` and retired API routes return `410`.
- A test imported unsubscribe token works once through storefront `POST /api/unsubscribe`; replay is harmless. Expired tokens redirect to the email-preferences page.
- A spot sample of imported customers carries the right group **and** the right metadata.
- Re-running the import produces **zero** new customers.
- The waitlist database rejects a write.

---

## Rollback

**Point DNS back.** The pre-launch container is not torn down on the day — it stays running and serving until the storefront has been verified on the live domain for a full business day. Keeping it warm costs nothing and is the only rollback that exists for a host swap.
