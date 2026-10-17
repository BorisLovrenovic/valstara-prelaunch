# ADR-021: Launch is a host cutover at the DNS layer, not a deploy

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
The pre-launch site occupies `valstara.com` for twelve weeks. With a shared repository, launch would have been deleting a route group and deploying. With separate repositories (ADR-002), it is two different applications wanting the same hostname.

## Decision
**Launch is a host swap at the DNS/proxy layer on `valstara.com`**, executed as a rehearsed checklist with the trust-page port completed and verified beforehand (`docs/ops/launch-cutover.md`).

**The pre-launch container stays running and serving until the storefront has been verified on the live domain for a full business day.** Keeping it warm costs nothing and is the only rollback a host swap has.

## Alternatives rejected
- **Treat it as an ordinary deploy** — it is not one, and treating it as one is how the trust pages break silently.
- **Launch the store on a different hostname first** — throws away the accumulated authority on the exact URLs that convert a suspicious visitor.
- **Tear down the pre-launch site at cutover** — removes the only rollback path on the highest-risk change of the year.

## Consequences
**A named risk (7), because a host swap is riskier than a deploy.** The mitigations are all preparation rather than cleverness: port the trust pages, verify on a staging host, rehearse the sequence, and keep the old host warm.

Two consequences that are easy to miss and are therefore checklisted:

- **`/verify` and `/api/*` disappear at cutover**, so any live verification token stops working. Under the founder-authorised 2026-10-12 sequence, signups close first, the final reminder goes out before the full freeze, and `/verify` stays live through a configurable 72-hour verification window before that freeze.
- **`/giveaway/rules` and its immutable revisions must be retained, not redirected**, for 12 months after the final award (ADR-026; Valstara policy rather than a statute).

The founder's 2026-10-12 route amendment keeps `/unsubscribe` and `/api/unsubscribe` on the storefront for unexpired imported tokens, redirects `/dsr` to storefront privacy rights, and retires `/giveaway/award` only after publication and terminal awards. The waitlist database is read-only for routine access after handoff; a named operator may record and complete verified erasure requests during the 90-day retention period. The exact route and token contract is in `docs/ops/launch-cutover.md` and `docs/data/model.md`.
