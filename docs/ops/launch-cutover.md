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

**The trust pages are the reason this is a checklist.** They have accumulated ranking authority at their permanent URLs for three months; a cutover that breaks them throws that away silently.

---

## The route disposition

| Route | Before | After |
|---|---|---|
| `/` | Waitlist landing page | Storefront home — **same URL, new content** |
| `/legit`, `/guarantee`, `/about` | Trust content | Ported, same URLs; `200` |
| `/terms`, `/privacy`, `/privacy/storage` | Legal and storage inventory | Ported and revised in place; `200` |
| `/giveaway/rules`, `/giveaway/rules/<rules_version>` | The global rules page and all three immutable revisions (ADR-026) | **Kept live** with `200` for 12 months after the final award, then `410`; revisions kept internally for 6 years |
| `/waitlist`, `/leaderboard` | Campaign mechanics | `301` to storefront `/` |
| `/me` | Member status | `301` to the storefront account area |
| `/dsr` | Privacy-rights request | `301` to storefront privacy-rights page |
| `/unsubscribe`, `/api/unsubscribe` | Email preference and RFC 8058 one-click endpoint | Storefront handles every imported, unexpired token at these paths, hashing the presented token and applying marketing withdrawal; a transactional-origin token also suppresses non-essential mail. After the token expires, both paths `301` to storefront email preferences |
| `/giveaway/award` | Provisional award response | `410`, only after the draw is published and every award is terminal |
| `/verify`, all other `/api/*` | Campaign endpoints | `410` after the verification window. **Any live verification token becomes unusable — send the final reminder before the full freeze** |

Port the versioned Markdown sources from `src/content/giveaway-rules/` and preserve the recorded SHA-256 of each rendered rules article. The current revision is `VAL-GW-LAUNCH-20261009-r1`; the earlier `VAL-GW-LAUNCH-20260925-r1` and `VAL-GW-LAUNCH-20261001-r1` revisions remain directly served at their permanent URLs as archived records, with the E11-04 notice, `noindex`, and sitemap exclusion. The current URL and all three permanent URLs must remain directly served after cutover. The port-checklist reconciliation must assert that the revision named here equals `currentRules()`.

The retired API inventory is explicit: `/api/signup`, `/api/resend-verification`, `/api/survey`, `/api/leaderboard`, `/api/me/leave`, `/api/me/marketing`, `/api/dsr/export`, `/api/dsr/delete`, `/api/webhooks/<provider>`, `/api/admin/draw`, `/api/admin/export.csv`, `/api/admin/fraud`, `/api/admin/fraud/<id>` and `/api/admin/health` all return `410` after cutover. `/api/unsubscribe` is the sole retained campaign API path, transferred to the storefront under the token contract above. Every path in `src/pages/` is represented by the route table or this API inventory; the port-checklist test reconciles that set in both directions.

---

## The handoff sequence

Rehearsed twice against a scratch database before the day (E11-06). **A rehearsal that is not idempotent — running it twice produces duplicate customers — is a blocking finding.**

1. **Close signups.** Set `signup.enabled` off and record the change in the audit log.
2. **Send the final reminder** to every pending, unsuppressed subscriber with `scripts/send-final-reminder.ts --actor=<operator>`. The command is batch-capped and idempotent, and issues a fresh seven-day verify token. Drain the transactional queue before starting the window; record queued and delivered counts.
3. **Verification window.** Keep `/verify` live for a configurable 72 hours, within the seven-day verify-token expiry.
4. **Full freeze.** Block public write endpoints at the proxy and pause the maintenance process. Verify both controls, then run `tsx scripts/record-handoff-freeze.ts --actor=<operator> --proxy-blocked-confirmed --maintenance-paused-confirmed` to audit the freeze. Audited handoff operations remain permitted through export and import; this is not the database read-only transition.
5. **pgBackRest snapshot.** The point-in-time everything else references.
6. **Export**: verified, unsuppressed, not disqualified. The command refuses unless the draw is published and all awards are terminal. Its NDJSON also carries every unexpired, unconsumed unsubscribe token as `unsubscribe_token` with `token_sha256`, owner `email_normalised`, `origin_kind` and `expires_at`, including owners outside the customer export set.
7. **Idempotent import keyed on `email_normalised`** → `createCustomersWorkflow` with metadata (`referral_tier`, `referral_code`, `confirmed_referrals`, `category_preference`, `access_window`, `source`, `subslush_customer`, and the marketing-consent state). **The storefront sends marketing only to customers whose consent is present** (ADR-027). The E11-06 scratch import proves the contract; the Medusa-side implementation lives in the storefront repository.
8. **Assign customer groups** `wave-1`…`wave-4` and `subslush-legacy`. **Groups, not metadata, are what promotions and price lists target** — the metadata carries provenance, the group carries the access it grants.
9. **Import confirmed referral pairs and eligible held-discount records.** Both people in each pair and every discount owner must be in the customer import set. The discount's owner `email_normalised` is its customer import key.
10. **Carry eligible held discounts to the storefront** with state `held`, audited `carried_to_storefront` outcome and `qualification_deadline` set from the supplied store-launch instant plus 90 days. The storefront settles a discount when any one of its owner's confirmed referred people places a first order before the deadline, then voids still-held discounts afterward. Before export, void disqualified owners' discounts with reason `owner_disqualified`, and suppressed or departed owners' with `owner_not_in_handoff`; audit every outcome. E9-05 erasure leaves no award to export. Marketing withdrawal alone does not block a verified, unsuppressed owner. Void any legacy bonus-entry milestone awards in bounded batches with an audited reason. No bonus-entry award is imported.
11. **DNS/proxy cutover.** Run `tsx scripts/cutover-check.ts --base-url=<storefront-origin> --unsubscribe-token=<unexpired-test-token> --expired-unsubscribe-token=<expired-test-token> --account-path=<approved-account-path> --privacy-rights-path=<approved-privacy-rights-path> --email-preferences-path=<approved-email-preferences-path>` against the live storefront before changing DNS; any failed retained `200`, recorded rules hash, archived notice, `noindex` and sitemap exclusion, exact redirect-to-`200`, decided `410` or one-click unsubscribe POST aborts the cutover. Re-run after the swap. E11-07 runs the same probe against a local fixture server, without changing DNS. Use dedicated test tokens and retain them outside the repository. Confirm the imported test subscriber's marketing withdrawal and, for a transactional-origin test token, non-essential-mail suppression in the storefront after the probe.
12. **Set the waitlist database read-only for 90 days** as the audit trail, except for named-operator erasure. Set the routine application role to `default_transaction_read_only=on` for the waitlist database, stop the app's write access, and test that a routine write fails. A request received through the storefront privacy-rights page requires verified identity evidence; the named operator uses a separate privileged `DATABASE_URL` and runs `scripts/request-erasure.ts --subscriber-id <uuid> --actor <name> --evidence-ref <opaque-reference>` against the waitlist database, deletes the Brevo contact, then runs `scripts/complete-erasure.ts --subscriber-id <uuid> --actor <name>`. Both actions are audited. Restrict that privileged connection to the erasure procedure and verify the routine role remains read-only afterward.

Record elapsed time for every rehearsal step. Record the verification-window duration as a configurable parameter, including its 72-hour launch value, in the total cutover timeline; do not wait 72 hours during the local rehearsal. Do not change DNS during the rehearsal.

The E11-07 local rehearsal runs with `tsx scripts/rehearse-cutover.ts --verification-window-hours=72 --evidence=<new-private-evidence-path>`. Its recorded 72-hour run is [e11-07-rehearsal.json](e11-07-rehearsal.json): all twelve steps passed on a disposable source database and local route fixture, including a pgBackRest snapshot containing that source, a two-database double import, and a routine-write denial after the read-only switch. The evidence records per-step elapsed time and the projected local timeline with the configured window. It identifies the local substitutes for external email delivery, proxy controls and the Medusa workflow; their real durations and the DNS propagation interval are measured on cutover day.

---

E11-06's handoff file is NDJSON. `customer` records contain the twelve customer fields above plus their assigned groups; `held_discount` records carry the owner key, held award and qualification deadline; `confirmed_referral` records carry the two normalised email keys; `unsubscribe_token` records carry only the token hash, normalised owner email, origin kind and expiry. The export command requires `--store-launch-at=<RFC3339 UTC>`, `--actor=<operator>` and `--output=<new private path>` with `DATABASE_URL` set to the frozen waitlist database. The import rehearsal requires `--input=<handoff NDJSON>` and `--evidence=<new path>` with `HANDOFF_REHEARSAL_ADMIN_URL` set to a PostgreSQL owner URL. It creates two scratch databases, imports the same file twice into each, rejects any additional customer, group, discount, referral pair or unsubscribe token on the second pass, and drops both databases. The synthetic pre-launch rehearsal evidence is in `docs/ops/e11-06-rehearsals.json`; the launch-day run uses the real export and retains only aggregate evidence in the repository.

The exporter audits `carried_to_storefront` outcomes only after the NDJSON file finishes writing, and commits those carry audits together. A write failure removes the partial file without recording any carry outcome. If auditing fails after the file finishes, the complete file remains for diagnosis; a nonzero command exit is not an approved handoff and must not be imported.

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
