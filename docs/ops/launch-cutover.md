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
| `/giveaway/rules/*` | Per-jurisdiction rules | **Kept live** for the statutory retention period, then `410` |
| `/waitlist`, `/leaderboard`, `/me` | Campaign mechanics | `301` to `/` and the account area |
| `/verify`, `/api/*` | Campaign endpoints | Gone. **Any live verification token becomes unusable — send the final reminder before this** |

---

## The handoff sequence

Rehearsed twice against a scratch database before the day (E11-06). **A rehearsal that is not idempotent — running it twice produces duplicate customers — is a blocking finding.**

1. **Freeze waitlist writes.** `signup.enabled` off; record the freeze in the audit log.
2. **Send the final reminder** to unverified rows *before* the freeze, so nobody is left holding a token that will stop working.
3. **pgBackRest snapshot.** The point-in-time everything else references.
4. **Export**: verified, unsuppressed, not disqualified.
5. **Idempotent import keyed on `email_normalised`** → `createCustomersWorkflow` with metadata (`referral_tier`, `referral_code`, `confirmed_referrals`, `country`, `category_preference`, `access_window`, `source`, `subslush_customer`).
6. **Assign customer groups** `wave-1`…`wave-4` and `subslush-legacy`. **Groups, not metadata, are what promotions and price lists target** — the metadata carries provenance, the group carries the access it grants.
7. **Generate per-customer discount codes.**
8. **Settle or void held referral rewards** per the published rule, and record the outcome for every held edge.
9. **DNS/proxy cutover.**
10. **Set the waitlist database read-only for 90 days** as the audit trail.

---

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
