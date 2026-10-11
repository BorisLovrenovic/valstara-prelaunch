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

**The trust pages are the reason this is a checklist.** They have accumulated ranking authority at their permanent URLs for three months; a cutover that breaks them throws that away silently.

---

## The route disposition

| Route | Before | After |
|---|---|---|
| `/` | Waitlist landing page | Storefront home — **same URL, new content** |
| `/legit`, `/guarantee`, `/about` | Trust content | Ported, same URLs |
| `/terms`, `/privacy` | Legal | Ported and revised in place |
| `/giveaway/rules`, `/giveaway/rules/<rules_version>` | The global rules page and its immutable revisions (ADR-026) | **Kept live** for 12 months after the final award, then `410`; revisions kept internally for 6 years |
| `/waitlist`, `/leaderboard`, `/me` | Campaign mechanics | `301` to `/` and the account area |
| `/verify`, `/api/*` | Campaign endpoints | Gone. **Any live verification token becomes unusable — send the final reminder before this** |

Port the versioned Markdown sources from `src/content/giveaway-rules/` and preserve the recorded SHA-256 of each rendered rules article. The first published revision is `VAL-GW-LAUNCH-20260925-r1`; the current revision is `VAL-GW-LAUNCH-20261001-r1`. Both permanent URLs and the current URL must remain directly served after cutover.

---

## The handoff sequence

Rehearsed twice against a scratch database before the day (E11-06). **A rehearsal that is not idempotent — running it twice produces duplicate customers — is a blocking finding.**

1. **Freeze waitlist writes.** `signup.enabled` off; record the freeze in the audit log.
2. **Send the final reminder** to unverified rows *before* the freeze, so nobody is left holding a token that will stop working.
3. **pgBackRest snapshot.** The point-in-time everything else references.
4. **Export**: verified, unsuppressed, not disqualified.
5. **Idempotent import keyed on `email_normalised`** → `createCustomersWorkflow` with metadata (`referral_tier`, `referral_code`, `confirmed_referrals`, `category_preference`, `access_window`, `source`, `subslush_customer`, and the marketing-consent state). **The storefront sends marketing only to customers whose consent is present** (ADR-027). The E11-06 scratch import proves the contract; the Medusa-side implementation lives in the storefront repository.
6. **Assign customer groups** `wave-1`…`wave-4` and `subslush-legacy`. **Groups, not metadata, are what promotions and price lists target** — the metadata carries provenance, the group carries the access it grants.
7. **Import confirmed referral pairs and eligible held-discount records.** Both people in each pair and every discount owner must be in the customer import set. The discount's owner `email_normalised` is its customer import key.
8. **Carry eligible held discounts to the storefront** with state `held`, audited `carried_to_storefront` outcome and `qualification_deadline` set from the supplied store-launch instant plus 90 days. The storefront settles a discount when any one of its owner's confirmed referred people places a first order before the deadline, then voids still-held discounts afterward. Before export, void disqualified owners' discounts with reason `owner_disqualified`, and suppressed or departed owners' with `owner_not_in_handoff`; audit every outcome. E9-05 erasure leaves no award to export. Marketing withdrawal alone does not block a verified, unsuppressed owner. Void any legacy bonus-entry milestone awards in bounded batches with an audited reason. No bonus-entry award is imported.
9. **DNS/proxy cutover.**
10. **Set the waitlist database read-only for 90 days** as the audit trail.

---

E11-06's handoff file is NDJSON. `customer` records contain the twelve customer fields above plus their assigned groups; `held_discount` records carry the owner key, held award and qualification deadline; `confirmed_referral` records carry the two normalised email keys. The export command requires `--store-launch-at=<RFC3339 UTC>`, `--actor=<operator>` and `--output=<new private path>` with `DATABASE_URL` set to the frozen waitlist database. The import rehearsal requires `--input=<handoff NDJSON>` and `--evidence=<new path>` with `HANDOFF_REHEARSAL_ADMIN_URL` set to a PostgreSQL owner URL. It creates two scratch databases, imports the same file twice into each, rejects any additional customer, group, discount or referral pair on the second pass, and drops both databases. The synthetic pre-launch rehearsal evidence is in `docs/ops/e11-06-rehearsals.json`; the launch-day run uses the real export and retains only aggregate evidence in the repository.

The exporter audits `carried_to_storefront` outcomes only after the NDJSON file finishes writing, and commits those carry audits together. A write failure removes the partial file without recording any carry outcome. If auditing fails after the file finishes, the complete file remains for diagnosis; a nonzero command exit is not an approved handoff and must not be imported.

## Verification after the swap

Not "the site loads". Specifically:

- Each of `/legit`, `/guarantee`, `/about`, `/terms`, `/privacy` returns `200` **with its content**, from a cold client.
- Every `/giveaway/rules/*` URL still returns `200`.
- `/waitlist`, `/leaderboard`, `/me` return `301` to their documented targets.
- A spot sample of imported customers carries the right group **and** the right metadata.
- Re-running the import produces **zero** new customers.
- The waitlist database rejects a write.

---

## Rollback

**Point DNS back.** The pre-launch container is not torn down on the day — it stays running and serving until the storefront has been verified on the live domain for a full business day. Keeping it warm costs nothing and is the only rollback that exists for a host swap.
