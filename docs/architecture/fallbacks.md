# Degradation and Fallback Matrix

Status: authoritative. **Every row is testable.** User-facing failure copy lives in the copy layer and follows the brand voice — plain, specific, no machinery terms, no apology theatre (`docs/brand/copy-rules.md`).

**Alert severities.** **P1** — act now · **P2** — within the hour · **P3** — daily digest.

The single authenticated alert webhook carries a `severity` field and delivers
both P1 and P2 notifications. Its `P1_ALERT_WEBHOOK_*` environment-variable
prefix is historical; the receiver owns paging-versus-within-the-hour routing.

**Two properties hold across every row, and they are why this matrix is short:**

- **A signup that reached PostgreSQL is safe.** Email, analytics, leaderboard and ESP sync are all downstream of the row. Losing any of them delays or degrades; none of them can lose a subscriber.
- **Nothing on this site is time-critical to a visitor.** There is no order to fulfil and no clock a person is waiting on. A queue that stalls for twenty minutes is invisible. The matrix exploits that slack rather than engineering around a latency budget that does not exist.

---

## The two silent failures

Everything else announces itself. These two look exactly like ordinary underperformance, which is why each has a dedicated guard.

| Failure | Why it is silent | The guard |
|---|---|---|
| **★ Verification mail stops being delivered** | The page still works, signups still arrive, the funnel simply stops converting. Indistinguishable from a bad landing page | **Alert on verification *rate*, not count**, hourly against a rolling baseline. The default compares the current 24-hour cohort with the preceding seven days, only after 50 signups; a 50% relative drop is P1. Plus weekly seed tests into Gmail, Outlook, GMX and Web.de. |
| **★ Referral attribution silently stops** | Signups keep arriving, referrers keep sharing, and nobody's counter moves. Discovered weeks later, unrecoverable | **Alert when the attributed-referral share of new signups drops below its baseline**, and assert in CI that a request carrying `?ref=` produces a signed field and an edge row |

---

## Signup and verification

| Failure | Detection | Fallback | Visitor sees | Alert |
|---|---|---|---|---|
| **★ PostgreSQL unavailable** | Connection errors, health probe | **No graceful degradation exists for writes** — the form states honestly that signups are paused and to try shortly. **It never pretends to have succeeded.** Static pages keep serving from Cloudflare | "We can't take signups right now — try again in a few minutes." | **P1** |
| **★ Resend unavailable or over quota** | Send errors, 4xx quota codes | **The subscriber row is already committed.** The send queues and retries with backoff, deduplicated on its business key. Permanent failure raises an operator task | "You're on the list — the confirmation email may take a few minutes." Never a false "check your inbox now" | **P1** |
| Turnstile unavailable | Verification endpoint errors or timeout | **Fail closed on hard failure; on provider timeout, fall through to strict rate limiting and flag the row for review.** Never fail open silently | A retry prompt, or a normal signup that is quietly flagged | **P2** |
| Turnstile token invalid or replayed | Server-side verification | Rejected, not recorded, counted as a bot event | "That didn't go through — please try again." | P3 |
| Verification token invalid or expired | Expiry check on token-authenticated POST | Both states render the identical generic failure and always offer the same request-new-link control through the enumeration-safe, Turnstile-protected resend route. Scanner/prefetch GETs only render confirmation and never consume | "This verification link is not available." | P3 |
| Verification-token retention sweep fails | Daily maintenance result | Retry the same batch-capped purge next scheduler cycle; tokens remain unusable after expiry even while retained | Nothing | **P1** |
| Verification token replayed | `consumed_at` present | **Treated as success, not as an error** — an already-verified visitor clicking twice is not a failure | The normal success page | — |
| **Visitor never verifies** | Bounded-wait ladder | Reminders at +1h, +24h, +72h, then the row **expires** at the configured horizon and is excluded from every count and export | Three reminders, then silence | P3 |
| MX lookup times out | DNS timeout | **Accept the signup and flag it** — never block a real person on a slow resolver | Nothing | P3 |
| Rate limit hit by a real person | Counter | Honest message with a wait time. **Never a silent no-op that looks like success** | "Too many attempts — try again in a few minutes." | P3 |

---

## Referral, leaderboard and giveaway

| Failure | Detection | Fallback | Visitor sees | Alert |
|---|---|---|---|---|
| **★ Referral counters drift from edges** | Daily repair job reports a delta | **Edges are authoritative; counters are recomputed from them.** A non-zero delta is investigated, never silently corrected and forgotten | Correct numbers after the repair | **P2** on any non-zero delta |
| Verified referral edge remains `attributed` after a legacy flag-off completion | Daily bounded stranded-edge reconciliation | Run normal confirmation/reward logic transactionally; the flag gates new attribution/display only | Correct tier/reward state after repair | P3 |
| Signed ref field invalid or expired | Signature check | **Signup proceeds without attribution.** Never rejected — the visitor did nothing wrong | Normal signup | P3 |
| Referrer disqualified after edges exist | Disqualification action | Edges move to `rejected`; the referred subscribers stay on the list. **A referred person is never punished for their referrer** | Nothing | P2 |
| Leaderboard snapshot job stops | Snapshot age exceeds threshold | **Last good snapshot keeps serving with its timestamp shown.** Stale is fine; a live query during a spike is not | A visible "as of" timestamp | P2 |
| Leaderboard credibility incident | Operator judgement, flag review | **Flag `leaderboard.public` off — the board disappears without a deploy.** The top-10 block in the weekly email is the fallback surface | The section is absent, not broken | **P1** decision |
| Giveaway rules change mid-campaign | Deliberate action | **Entries already accrued keep the rules version in force when they accrued.** Every revision is immutable at its own URL | Both versions published | P2 |
| Giveaway entry reconciliation fails | Hourly job reports failure | Verification and confirmed-edge timestamps remain authoritative; retry the batch-capped reconciliation while `giveaway.open` is on before the draw | Existing entries remain; missing entries are restored on retry | P2 |
| Target drand round is unavailable, invalid, or relays disagree | Draw worker's two-relay fetch and signature check | Keep the committed draw pending; retry with exponential backoff capped at one hour. **Never generate a local seed or choose another round.** | Nothing yet | **P1** |
| Provisional winner fails an award-time check (sanctioned country, under 18, Canadian skill question) or misses the deadline | Award-time checks (E7-06) | **The prize moves to the next reserve from the same draw** — never a new draw | Plain notice to the provisional winner | P3 |
| **Draw cannot be reproduced from its record** | Draw verification step | **Blocking. The draw is not published until it reproduces from the recorded seed and entry snapshot** | Nothing yet | **P1** |

---

## Email

| Failure | Detection | Fallback | Visitor sees | Alert |
|---|---|---|---|---|
| **★ Deliverability degrades on `send.`** | Bounce and complaint rates; verification rate | **A domain reputation problem is a business emergency, not a technical one.** Pause non-essential sends, investigate immediately | Missing confirmation mail | **P1** |
| SPF, DKIM or DMARC check fails on `send.valstara.com` | E8-02 maintenance-startup DNS check and exported health result | Boot continues; emit a sanitized code and investigate the record before campaign open. E10-05 later displays the result (founder-authorised 2026-09-28) | Nothing directly | **P1** |
| Weekly seed lands in spam, is absent after two hours, or the seed check fails | E8-04 records one placement per Gmail, Outlook, GMX and Web.de mailbox per UTC week; maintenance checks hourly and exports a health result | Investigate the affected mailbox and domain authentication; maintain the recorded outcome, retry polling without another send that week, and pause non-essential sends while deliverability is suspect. First live run is E12-07 | Nothing directly | **P1** |
| Brevo unavailable or over quota | API errors | Broadcast delays; **transactional mail is unaffected, which is the entire reason the providers are split** | A late weekly update | P2 |
| Free-tier cliff hit mid-campaign | Quota warnings; a daily projection against the cap | **Pre-empted, not handled** — the upgrade happens before the giveaway opens, and the projection alerts a week ahead | Nothing, if pre-empted | **P1** if hit |
| Contact sync to Brevo fails | Sync job result | **PostgreSQL is the source of truth**; the sync is resumable and idempotent on the normalised email | Nothing | P2 |
| Bounce/complaint webhook missed | Hourly reconciliation against provider state | Suppression lags by up to an hour; **a suppressed address could receive one more send.** Documented, accepted, reconciled | Possibly one extra email | P2 |
| Unsubscribe fails to apply | Suppression or consent-withdrawal transaction error | Token consumption, preference and explicit-leave status write, and audit roll back together; the unsubscribe token stays usable for retry. The P1 alert itself is the operator task, carrying the token hash and request action even if database lookup fails; use the CLI in `docs/ops/runbook.md#unsubscribe-failed-to-apply` if the person does not retry. A database outage also stops dispatch because its suppression lookup fails closed | An honest retry message; the page keeps the action available | **P1** |

---

## Infrastructure and third parties

| Failure | Detection | Fallback | Visitor sees | Alert |
|---|---|---|---|---|
| **★ VPS or container down** | Uptime probe, health check | **Static pages continue to serve from Cloudflare's cache**; writes fail honestly. Trust and legal pages stay readable, which matters more than the form during an outage | Content yes, signup no | **P1** |
| Box OOM-kills the container | Restart, memory metric | Compose restarts it. **Recurrence is a capacity signal, not a restart loop to tolerate** | Brief unavailability | **P1** on recurrence |
| Cloudflare proxy or DNS down | Uptime probe | Nothing to fall back to | Site unreachable | **P1** |
| Umami unavailable | Ingest errors | **Analytics is lost; nothing else is.** No page ever blocks on an analytics call | Nothing | P3 |
| Trustpilot widget fails | Script error | **Page renders without it.** Content never blocks on a third-party script | Missing widget | P3 |
| Backup fails, or a restore drill fails | Job result, monthly drill | Investigate immediately. **A backup that has never been restored is a hypothesis** | Nothing | **P1** |
| Deploy health check fails | Deploy gate | Roll out aborts; the previous image keeps serving | Nothing | **P2** |
| **Token file drifts from the storefront's** | Comparison at each port checkpoint | **Reconcile in this repository first**, then re-port. The token file is canonical during pre-launch | Nothing yet — the cost lands at store launch | P2 |

---

## Chaos drills

Executed and recorded before the campaign opens (E11). **A drill that does not behave as this matrix claims is a blocking finding — fix the system or fix the matrix, never neither.**

1. Stop PostgreSQL mid-signup; confirm the form fails honestly and no partial row exists.
2. Revoke the Resend key; confirm signups still commit and the queue drains after restoration.
3. Break the Turnstile secret; confirm fail-closed behaviour and that no unverified write slips through.
4. Kill the leaderboard snapshot job; confirm the stale snapshot serves with its timestamp.
5. Corrupt a referral counter directly in the database; confirm the repair job restores it from the edges and alerts.
6. Flip `leaderboard.public` off; confirm the section disappears within the cache window with no deploy.
7. Restore the waitlist database into a scratch container and verify against known rows; record the timing.
8. Replay a verification token, a Turnstile token and an email webhook; confirm each is idempotent.
9. **Fill the box until a service is OOM-killed**; confirm Compose restarts it, the kill is visible, and recurrence is recorded as a capacity signal rather than tolerated.
10. **Take Cloudflare out of the path**; confirm the origin refuses a direct connection rather than serving around the proxy.

**Where each runs.** Drills 1–6 and 8 run against the local production-Compose stack in **E11-02**. Drills 7, 9 and 10 need real infrastructure — an R2 remote, real memory limits and a real proxy — and run on the host in **E12-06**. None is optional, and a drill deferred to E12 is named there rather than quietly skipped.
