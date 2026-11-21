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
| **★ Referral attribution silently stops** | Signups keep arriving, referrers keep sharing, and nobody's counter moves. Discovered weeks later, unrecoverable | E10-05's hourly `ReferralService.attributionHealth()` compares the share of new signups with a referral edge in the preceding 24 hours against the preceding seven days. With at least 50 current signups and a nonzero baseline share, a relative drop of at least 50% raises P1. The windows, minimum and threshold are configurable. While `referral.enabled` is off, the result is `disabled` and no alert is sent. Assert in CI that a request carrying `?ref=` produces a signed field and an edge row. |

---

## Signup and verification

| Failure | Detection | Fallback | Visitor sees | Alert |
|---|---|---|---|---|
| **★ PostgreSQL unavailable** | Connection errors, health probe | **No graceful degradation exists for writes** — the form states honestly that signups are paused and to try shortly. **It never pretends to have succeeded.** Static pages keep serving from Cloudflare | "We can't take signups right now — try again in a few minutes." | **P1** |
| **★ Resend unavailable or over quota** | Send errors, 4xx quota codes | **The subscriber row is already committed.** The send queues and retries with backoff, deduplicated on its business key. Permanent failure raises an operator task | The same "Check your inbox" panel as on any accepted signup (E11.5-06): "If an email from Valstara arrives, open it and click the link to confirm your address. Nothing counts until you do." It is conditional and never says the email has been sent or has arrived, so it stays true while the send is queued. The panel cannot tell the visitor about a delay, because the response is identical whether or not the send has gone | **P1** |
| Turnstile unavailable | Siteverify secret error, provider error or timeout | Invalid or replayed tokens are rejected. On `missing-input-secret` or `invalid-input-secret`, accept only under strict rate limits, flag each accepted row `challenge_timeout`, and send a deduplicated, sanitized **P1** through the existing alert webhook. Other unavailable outcomes follow the same strict limit and flag path and raise **P2**. Never accept an unflagged row during the drill | A retry prompt, or a normal signup that is quietly flagged | **P1** for secret configuration; **P2** for timeout, network or internal error |
| Turnstile token invalid or replayed | Server-side verification | Rejected, not recorded, counted as a bot event | "We couldn't confirm that request. Please try again." | P3 |
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
| **★ Referral counters drift from edges** | Daily repair job reports a delta | **Edges are authoritative; counters, the coupon ladder and wave 1 are recomputed from them** (E11.7-03). A non-zero delta is investigated, never silently corrected and forgotten. Each run checks at most 1,000 verified subscribers, lowest IDs first, so a ladder configuration change reaches the rest at their next confirmation, void or un-void, or at the handoff, which first recomputes everyone before export (D-047); the first repair after a change reports the referrers it changes | Correct numbers after the repair | **P2** on any non-zero delta |
| Verified referral edge remains `attributed` after a legacy flag-off completion | Daily bounded stranded-edge reconciliation | Run normal confirmation/reward logic transactionally; the flag gates new attribution/display only | Correct tier/reward state after repair | P3 |
| Signed ref field invalid or expired | Signature check | **Signup proceeds without attribution.** Never rejected — the visitor did nothing wrong | Normal signup | P3 |
| Referrer disqualified after edges exist | Disqualification action | Edges move to `rejected`; the referred subscribers stay on the list. **A referred person is never punished for their referrer** | Nothing | P2 |
| Leaderboard snapshot job stops | Snapshot age exceeds threshold | **Last good snapshot keeps serving with its timestamp shown.** Stale is fine; a live query during a spike is not | A visible "as of" timestamp | P2 |
| Leaderboard credibility incident | Operator judgement, flag review | **Flag `leaderboard.public` off — the board disappears without a deploy.** The top-10 block in the weekly email is the fallback surface | The section is absent, not broken | **P1** decision |
| Weekly broadcast window missed | Hourly maintenance run after the configured send time plus 24 hours | Mark the week skipped, record it durably and alert; expired queued rows cannot dispatch. **No late send** | No update that week | P2 |
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
| Brevo broadcast seed has no plain-text MIME part, contains a tracking pixel or rewrites a link | Weekly raw-message inspection of the internal seed, independent of `email.broadcast` | Investigate and keep customer broadcasts paused until provider settings and delivered output are correct; the first live check is E12-07 | Nothing directly | **P1** |
| Bounce/complaint webhook missed | Hourly Brevo provider read; Resend two-hour missing-terminal-event gap check; non-2xx Resend webhook responses; weekly Resend dashboard review (founder-authorised 2026-09-30) | Brevo suppression can lag about one hour. A Resend gap can take about three hours to flag; one sanitized P2 task requests dashboard replay. Resend's own suppression list prevents its re-send to bounced or complaining addresses and it retries webhooks for roughly one day. A complaint or bounce lost after `delivered` has no gap and depends on webhook-failure alert and weekly review. **A suppressed address could receive one more Brevo send before local suppression is restored.** | Possibly one extra email | P1 for a signature-verified Resend webhook that fails ingestion; P2 for repeated Resend authentication failures or a detected gap; P2 for Brevo reconciliation failure |
| Unsubscribe fails to apply | Suppression or consent-withdrawal transaction error | Token consumption, preference and explicit-leave status write, and audit roll back together; the unsubscribe token stays usable for retry. The P1 alert itself is the operator task, carrying the token hash and request action even if database lookup fails; use the CLI in `docs/ops/runbook.md#unsubscribe-failed-to-apply` if the person does not retry. A database outage also stops dispatch because its suppression lookup fails closed | An honest retry message; the page keeps the action available | **P1** |

---

## Infrastructure and third parties

| Failure | Detection | Fallback | Visitor sees | Alert |
|---|---|---|---|---|
| **★ VPS or container down** | Uptime probe, health check | **Static pages continue to serve from Cloudflare's cache**; writes fail honestly. Trust and legal pages stay readable, which matters more than the form during an outage | Content yes, signup no | **P1** |
| Box OOM-kills the container | Restart, memory metric | Compose restarts it. **Recurrence is a capacity signal, not a restart loop to tolerate** | Brief unavailability | **P1** on recurrence |
| Cloudflare proxy or DNS down | Uptime probe | Nothing to fall back to | Site unreachable | **P1** |
| Umami unavailable | Ingest errors | **Analytics is lost; nothing else is.** No page ever blocks on an analytics call | Nothing | P3 |
| Unhandled server error on a page render | Astro writes the error to the app's log; the response status is 500. E11.5-10's induced render error proves the page | The prerendered branded 500 page, served from disk with no database, configuration or middleware, and carrying no stack trace or internal detail. If `/` itself keeps failing, Caddy's health check (`health_uri /`) takes the backend out and the "VPS or container down" row applies | "Something went wrong on our side" and "Please try again in a few minutes.", with links to the home page and to "Is Valstara legit?" | P3 (the log); **P1** through the container-down row if `/` fails |
| **★ Maintenance worker stopped or hung** | **A database heartbeat with an outside watchdog** (QA gate 7, G7-1-I2; founder decision 2026-11-13). After each completed pass the worker upserts its loop's `maintenance_heartbeat` row (the hourly scheduler cycle and the one-minute email dispatch pass) and touches a heartbeat file. The app process reads the rows every 30 seconds: a loop whose last beat is older than twice its interval, or that has never beaten twice its interval after the app started, is stale. Compose restarts a worker that exits (`restart: unless-stopped`); the production health check fails once the heartbeat file is over two minutes old, but Compose does not restart an unhealthy container, so **the P1 is the recovery signal**. The E10-05 health view shows each loop's last beat, age and stale state, and the main-image workflow refuses to push an image whose worker does not start | **Late, never lost.** Every job reads durable rows, so mail, reminders, snapshots, purges, erasures and the weekly send wait and resume when the worker runs again — drills 2, 4, 5 and 11 run through this container. While it is down, verification mail is not sent and **both silent-failure guards stop**, which is why this row is starred. Restart the worker (`docker compose restart maintenance`); its next pass clears the episode | A leaderboard "as of" timestamp that grows old; a verification email that arrives late | **P1** `maintenance_heartbeat_stale`, through the existing alert webhook, carrying only the loop key and its age in seconds; one per stale episode, deduplicated in the database across app restarts, until a fresh beat clears it |
| Backup fails, or a restore drill fails | Job result, monthly drill | Investigate immediately. **A backup that has never been restored is a hypothesis** | Nothing | **P1** |
| Deploy health check fails | Deploy gate | Roll out aborts; the previous image keeps serving | Nothing | **P2** |
| **Token file drifts from the storefront's** | Comparison at each port checkpoint | **Reconcile in this repository first**, then re-port. The token file is canonical during pre-launch | Nothing yet — the cost lands at store launch | P2 |

---

## Price pages (E11.6-10)

| Failure | Detection | Fallback | Visitor sees | Alert |
|---|---|---|---|---|
| **A wrong price has gone live** | Founder review, a report | **Flag `prices.pages` off** — every price route answers `503` with `Retry-After` and `noindex`, without a deploy, and keeps its index status. The fix ships as a data pull request | A plain "prices are temporarily unavailable" card | **P1** decision |
| A published page loses all its publishable data, or its service or market leaves the configuration | The build's generation rule | **The page never answers 404.** Its ledger URL renders "temporarily unavailable" with no price and `noindex`, and leaves the sitemap until data returns or the founder retires it with `price-index retire-url`, after which it answers `301` to the recorded hub (D2, E11.6-12) for as long as it generates no page; if its data returns, its page is served again (D-037 Q2). A hub with no live page left answers 404, because it lists nothing | The page's heading and an honest unavailable note, and the waitlist form | — |
| A price data file is invalid at build | The prebuild sitemap step validates every file the pages read | **The build fails and nothing is deployed**; the last good build keeps serving | The last deployed prices | — (CI red) |

## Chaos drills

Executed and recorded before the campaign opens (E11). **A drill that does not behave as this matrix claims is a blocking finding — fix the system or fix the matrix, never neither.** E11-02 local results: [chaos report](../testing/e11-02-chaos-report.md) and [machine-readable timings](../testing/e11-02-results.json).

1. Stop PostgreSQL mid-signup; confirm the form fails honestly and no partial row exists.
2. Revoke the Resend key; confirm signups still commit and the queue drains after restoration — through the running maintenance worker's own dispatch loop.
3. (a) Submit invalid and replayed Turnstile tokens; confirm each is rejected and no row is written. (b) Break the Turnstile secret; confirm signups are accepted only under strict rate limits, every resulting row carries a `challenge_timeout` flag (no unflagged write), and a P1 alert fires. Restore the secret; confirm normal verification resumes. Record the timings.
4. Stop the maintenance worker, which runs the leaderboard snapshot job; confirm the stale snapshot serves with its timestamp, and that a fresh snapshot follows when the worker restarts.
5. Corrupt a referral counter directly in the database; confirm the maintenance worker's scheduled repair restores it from the edges and alerts.
6. Flip `leaderboard.public` off; confirm the section disappears within the cache window with no deploy.
7. Restore the waitlist database into a scratch container and verify against known rows; record the timing.
8. Replay a verification token, a Turnstile token and an email webhook; confirm each is idempotent.
9. **Fill the box until a service is OOM-killed**; confirm Compose restarts it, the kill is visible, and recurrence is recorded as a capacity signal rather than tolerated.
10. **Take Cloudflare out of the path**; confirm the origin refuses a direct connection rather than serving around the proxy.
11. **Pause the maintenance container** (`docker compose pause maintenance`); confirm exactly one `maintenance_heartbeat_stale` P1 for the email dispatch loop once its last beat is over two minutes old, and no second one while the pause lasts. Unpause it; confirm the next pass's beat clears the episode (QA gate 7, G7-1-I2).

**Drills 2, 4, 5 and 11 run through the production maintenance container** — the `maintenance` service from `infra/compose/docker-compose.production.yml`, running the image's own source with no source mount — never through a one-shot script that calls the job code. This holds for every run, including E12-06's re-run on the host (QA gate 7, G7-1-I3: the original E11-02 run drove those jobs through one-shot scripts with the source mounted, so it never noticed that the image's worker could not start).

**Where each runs.** Drills 1–6 and 8 run against the local production-Compose stack in **E11-02**; drill 11 joined them on the QA gate 7 fix branch, and **E12-06 re-runs drills 1–6, 8 and 11 on the host**. Drills 7, 9 and 10 need real infrastructure — an R2 remote, real memory limits and a real proxy — and run on the host in **E12-06**. None is optional, and a drill deferred to E12 is named there rather than quietly skipped.

## Data-subject erasure (E9-05)

| Failure | Behaviour | Operator fallback |
|---|---|---|
| Rights-link request cannot be stored | Return the same bounded acknowledgement to known and unknown addresses; emit a sanitized P1 without an address. | Restore request storage and verify a fresh request can queue a purpose-bound link. |
| Brevo deletion unavailable | Keep the constrained pending request and original subscriber identity; processing remains stopped. Retry DELETE with bounded backoff for up to seven days. Success or 404 permits atomic local fulfilment. | Day seven raises P1 with only the opaque subscriber ID. Delete in the Brevo dashboard, then run the actor-audited completion CLI. Re-alert P1 from day 28; complete within the 30-day hard deadline. |
| Local transaction fails after Brevo deletion | Roll back local erasure, ledger and fulfilment audit together. Restart from the pending row and repeat DELETE; 404 is success. | Maintenance failure raises sanitized P1; restore database health and resume the job. |
| Restore lacks newest ledger or re-application fails | Keep the restored database isolated from traffic and outbound workers. | Obtain the newest ledger and successfully run the idempotent re-apply command before reopening service. |
