# E11-01 local load exercise

This is the local correctness exercise authorised on 2026-10-07. Capacity on the production host belongs to E12-06. The load runner is `scripts/load/e11-01-run.mjs`; its rates and durations are inputs in `scripts/load/e11-01-profile.json`. `scripts/load/docker-compose.load.yml` adds local loopback ports, `pg_stat_statements`, a healthy Umami collector, and a read-only mount of the fake mail sink to the production Compose definition. The disposable database and credentials are kept outside the repository.

## Reproduction

Build the current application image, then start a fresh, isolated production-Compose project with the load overlay. Set `VALSTARA_LOAD_SCRIPTS_DIR` to the absolute `scripts/load` directory, `VALSTARA_IMAGE` to that image, and the production-Compose secrets to disposable values. The app must use Cloudflare's always-pass Turnstile test secret; the runner sends the matching dummy token. Start Umami before traffic so best-effort signup analytics has its normal local collector. Do not start the maintenance sender. The mail drain runs `scripts/load/drain-email.ts`, which invokes the real dispatcher and renderer with an in-process sink provider.

```sh
docker compose -p valstara-e1101-load -f infra/compose/docker-compose.production.yml -f scripts/load/docker-compose.load.yml up -d --wait postgres migrate umami app
LOAD_BASE_URL=http://127.0.0.1:54321 \
LOAD_REQUEST_ORIGIN=http://valstara.com \
LOAD_DATABASE_URL="$DISPOSABLE_LOAD_DATABASE_URL" \
LOAD_APP_CONTAINER=valstara-e1101-load-app-1 \
LOAD_POSTGRES_CONTAINER=valstara-e1101-load-postgres-1 \
LOAD_UMAMI_CONTAINER=valstara-e1101-load-umami-1 \
LOAD_ADMIN_CREDENTIAL="$DISPOSABLE_ADMIN_CREDENTIAL" \
LOAD_ADMIN_TOTP_SECRET="$DISPOSABLE_ADMIN_TOTP_SECRET" \
node scripts/load/e11-01-run.mjs scripts/load/e11-01-profile.json docs/testing/e11-01-results.json
```

Since QA gate 7 the profile also carries `referralLandingRate`, `leaderboardPageRate`, `pageSeconds` and `referralCodes` for the uncacheable page renders described [below](#qa-gate-7-the-uncacheable-page-renders). E12-06 reuses the same script and profile on the host (founder decision 2026-11-13).

The runner accepts only a loopback HTTP target. It sets `Host` and `Origin` to `valstara.com` so Astro trusts the simulated client prefix supplied in `X-Forwarded-For`. It seeds and warms the leaderboard snapshot before timed traffic, then resets `pg_stat_statements` immediately before the leaderboard phase. It streams the admin CSV during signup traffic, samples the app, PostgreSQL and Umami containers throughout, drains verification mail through the fake sink, and asserts row, business-key, response, and cache invariants. The result JSON holds every memory sample; it contains no credentials, real addresses, or raw client IPs.

For hostile 429s, the runner reads the current run's rate-limit bucket `window_start` after the traffic phase and checks every `Retry-After` against that recorded start plus the signup route's 15-minute window. It bounds the expected header by each request's start and response end times. The bucket count must equal the hostile request count, proving the phase stayed within one window; a fixed 900-second header fails as the window ages.

## Bounded query inventory

`DatabaseConnection.list` appends a SQL `LIMIT` for every list result, and `readOne` uses `LIMIT 1` (`src/server/db/pool.ts`). The following are the sweep, export, and bulk operations, including effective call-site caps where a repository accepts a smaller caller-selected limit. Scalar counts and keyed point reads return one row.

| Operation and query location | Maximum rows per batch |
|---|---:|
| E11-01 test-only verified-row seed (`scripts/load/e11-01-run.mjs`) | Configured `exportRows`, 50,000 in the authorised profile |
| Admin CSV snapshot page (`src/server/db/admin-export.ts`), emitted by a `ReadableStream` | 500 |
| DSR subject export per table, due erasures, erasure ledger, draw/snapshot cleanup, and each erasure `UPDATE`/`DELETE` subquery (`src/server/db/dsr-export.ts`, `dsr.ts`) | 100 |
| Pending subscriber expiry and reminder candidates (`src/server/db/subscriber-maintenance.ts`) | 1,000 from the maintenance scheduler |
| Expired verification tokens, rate-limit buckets, and IP-velocity hashes (`src/server/db/verification-token.ts`, `rate-limit-bucket.ts`, `ip-velocity.ts`) | 1,000 from the maintenance scheduler |
| Stranded referral confirmation and referral-counter repair (`src/server/db/referral.ts`, `src/server/referral/service.ts`) | 1,000 |
| Milestone backfill and campaign-close held reward/edge void (`src/server/db/referral.ts`, `src/server/referral/service.ts`) | 100 |
| Referral-status reward lookup (`src/server/db/referral.ts`, `src/server/referral/service.ts`) | 101, including one overflow sentinel |
| Giveaway entry entitlement reconciliation (`src/server/db/giveaway-entry.ts`, `src/server/giveaway/reconcile.ts`) | 1,000 |
| Draw ledger, snapshot, score, selection, and reproducibility pages; array-driven writes use those pages (`src/server/db/giveaway-draw.ts`) | 1,000 |
| Award winner, provisional-subject, response-deadline, and substitution-deadline pages (`src/server/db/giveaway-award.ts`) | 100 |
| Queued email dispatch (`src/server/db/email.ts`, `src/server/email/service.ts`) | 100 effective; repository ceiling 1,000 |
| Weekly broadcast audience (`src/server/db/weekly-campaign.ts`, `src/server/email/weekly-campaign.ts`) | 100 per page, at most 100 pages per run |
| Brevo contact sync (`src/server/db/brevo-contact-sync.ts`) | 100 |
| Resend gap and Brevo event reconciliation (`src/server/db/email-webhook.ts`, `src/server/email/reconcile.ts`) | 100 per page, at most 1,000 per run |
| Leaderboard snapshot retention (`src/server/db/leaderboard-snapshot.ts`) | 100 |
| Ranking candidates (`src/server/db/ranking.ts`, `src/server/referral/ranking.ts`); published snapshot reads the top 10 | 1,000 API ceiling; 10 for the snapshot |
| Fraud review, duplicate identity evidence, and top-twenty review (`src/server/db/fraud-review.ts`, `duplicate-identity.ts`, `top-twenty-review.ts`) | 50, 20, and 20 respectively |
| Audit query, seed-test status, email quota daily totals, verification provider rates, flag list, and purge-run status (`src/server/db/audit-log.ts`, `seed-test.ts`, `email-quota.ts`, `verification-rate.ts`, `campaign-flags.ts`, `purge-job-run.ts`) | 100, 4, 16, 5, registry length, and job-key count respectively |

The large CSV is a repeatable-read snapshot with an audited scalar row count, then 500-row keyset pages. Neither the CSV route nor its `ReadableStream` collects the full export in application memory. The draw and DSR loops likewise consume bounded pages; the per-subject DSR mutations use 100-row subqueries.

## Measured result

**Passed, 2026-10-07 UTC.** Run `9e95a428` used `scripts/load/e11-01-profile.json` against the isolated Compose project, with image digest `sha256:7618a62ca8b1af0a0af0a968132a0b220c5bcf286a50c0ec05014603274910a5`. The complete machine-readable result, including all 166 memory samples and 7 samples labeled `export`, is [`e11-01-results.json`](e11-01-results.json). The 5xx tolerance was **0** and the observed 5xx count was **0**.

| Check | Result |
|---|---|
| Sustained signup | 12,000 scheduled at 20/s over 600 seconds; phase completed in 600.47 seconds |
| Burst signup | 3,000 scheduled at 50/s over 60 seconds; phase completed in 60.50 seconds |
| Ordinary signup responses | 15,000/15,000 HTTP 200; 0 transport errors and 0 HTTP 429 |
| Signup p95 | 532 ms overall; 529 ms sustained and 541 ms burst, informational for E12-06 |
| Hostile prefix | 5 HTTP 200, then 195 HTTP 429 out of 200 requests; every 429 carried a `Retry-After` in the old 1–900-second range check. The later reset-time probe below adds the database-backed assertion |
| Subscriber rows | 13,505 rows, all 13,505 normalised addresses distinct: 13,500 unique ordinary addresses plus 5 accepted hostile addresses |
| Verification mail | 13,505 rows and 13,505 distinct business keys, all sent by the fake sink; 0 queued and 0 failed. The sink sent 13,515 total, including 10 warm-up addresses, in 136 batches; the entire `email_send` queue ended empty |
| Large export during signup | 50,000 verified fixture rows streamed; 50,001 CSV lines and 4,677,991 bytes including the header |
| Leaderboard spike | 24,000/24,000 HTTP 200 at 200/s over 120 seconds, p95 3 ms, every response carrying the seeded snapshot ID |
| Query evidence | `pg_stat_statements` reset immediately before the leaderboard phase; 0 `subscriber` calls and 0 `leaderboard_snapshot` calls during that phase |

| Container | Peak sampled memory | Limit | Peak during export | Headroom at overall peak |
|---|---:|---:|---:|---:|
| App | 125.4 MiB | 768 MiB | 65.3 MiB | 642.6 MiB |
| PostgreSQL | 147.7 MiB | 512 MiB | 123.5 MiB | 364.3 MiB |
| Umami | 191.9 MiB | 768 MiB | 188.1 MiB | 576.1 MiB |

An initial full attempt was invalid because the test stack omitted Umami, although the production app sends best-effort signup events to `umami:3000`. That attempt had 99 signup 5xx, 13,421 `challenge_timeout` flags, and rising app memory. A fresh process in the same container could verify 200 Turnstile test tokens at 20/s; instrumenting the running app showed Turnstile timeout errors. The missing collector is the inferred cause of the failed app-process behaviour. The overlay now requires a healthy Umami container before app startup. A corrected short probe passed, followed by the fresh-database full pass above. No live email was sent in either attempt.

**Reset-time verification probe, 2026-10-07 UTC.** With the same local stack, run `eb52b8a2` used a short profile: 20 signups/s for 10 seconds, 50/s for one second, hostile traffic at 20/s for 10 seconds, 10 leaderboard requests/s for one second, and 1,000 additional export rows. It returned 250/250 ordinary HTTP 200s, 5 hostile HTTP 200s, and 195 hostile HTTP 429s. The runner read hostile bucket `window_start = 2026-10-07T19:37:29.844Z`, confirmed its count was 200, and matched **195/195** `Retry-After` headers to that window's reset; `invalidWait = 0`. The queue drained, the export streamed 51,001 lines including the prior run's 50,000 rows, and the leaderboard's 10 responses used the snapshot cache with no `subscriber` query. The probe's result is in `/tmp/valstara-e1101-wait-result.json` on the local machine; the command above reproduces it by supplying a shorter copy of the profile. The full-profile figures above remain the original measured run.

## QA gate 7: the uncacheable page renders

QA gate 7 (finding G7-1-I4) found that the two page renders a viral spike reaches the origin through had never been load-tested: referral-link landings (`/?ref=<code>`) and the `/leaderboard` page. Both are served `private, no-store` on every view (`src/pages/index.astro`, `src/pages/leaderboard.astro`), so Cloudflare cannot absorb them. The runner now adds three phases after the burst, once the hostile phase and the export have finished:

1. **Referral landings alone** at `referralLandingRate` for `pageSeconds`, cycling through `referralCodes` valid 12-character codes seeded onto the verified fixture rows. Each response must be HTTP 200 with `Cache-Control: private, no-store` and the landing heading. `pg_stat_statements` is reset before the phase and read after it.
2. **The `/leaderboard` page alone** at `leaderboardPageRate` for `pageSeconds`, with the same checks plus the leaderboard section, and **zero `subscriber` queries** asserted from `pg_stat_statements`.
3. **Both together with signups** at `signupRate` for `pageSeconds` — the combined profile E12-06 runs on the host. These signups join the row, business-key and drained-queue invariants, and every one must be HTTP 200.

A page request that has no response within 30 seconds counts as a transport error, and any transport error or 5xx fails the run. The authorised profile sets 200/s for each page for 120 seconds, the leaderboard spike rate the founder authorised for E11-01 on 2026-10-07, across 200 referral codes.

**The origin render cache (founder decision 2026-11-14 on E11-01).** Both renders now go through a bounded in-process cache (`src/server/cache/render.ts`, wired in `src/middleware.ts`). The landing is rendered once per flag generation, with and without the signed referral field, and the `/leaderboard` page once per flag generation. Each request gets the stored body with its own freshly signed referral field substituted, so a referral spike costs the box a cache lookup and an HMAC, not a page render. Responses and headers are unchanged: `?ref=` and any non-default flag state stay `private, no-store`, and E12-05's landing-cache contract is untouched. A flag change changes the generation, so the `leaderboard.public` kill switch still takes effect within the flag cache's five seconds (ADR-023). The cache holds no visitor data, keys on route, field presence, the `ref` parameter's presence and the flag generation, and is capped at 16 entries; it never grows with distinct referral codes.

**Any non-default flag state leaves every landing uncached at Cloudflare**, including the state the campaign reaches once `giveaway.open` or `email.broadcast` is turned on. From then on even a plain `/` reaches the origin on every view. The render cache carries that case too, because its key is the flag generation, not the default state.

**Result, 2026-11-13 UTC (2026-11-14 local): passed.** Run `bf3d83cc` used the unchanged authorised profile `scripts/load/e11-01-profile.json` against an isolated production-Compose project with image ID `sha256:ea65519908345109f501b5437cb7ed8c83be01b55030f147f64ca60e109d430c`, built from the QA gate 7 branch with the render cache and the maintenance heartbeat. The machine-readable result, including 243 memory samples, is [`e11-01-gate-7-results.json`](e11-01-gate-7-results.json). Every phase ran, including the original leaderboard-API phase, and the 5xx count was **0**.

| Phase | Requests | Outcome | p95 |
|---|---:|---|---:|
| Sustained and burst signups (20/s for 600 s, then 50/s for 60 s) | 15,000 | 15,000 HTTP 200 | 590 ms sustained, 605 ms burst |
| Hostile prefix | 200 | 5 HTTP 200, then 195 HTTP 429; all 195 `Retry-After` headers match the recorded window | — |
| Large export during signup | 50,000 rows | 50,001 CSV lines, 4,680,391 bytes | — |
| Referral landings alone, 200/s for 120 s | 24,000 | 24,000 HTTP 200, all `private, no-store`; no `subscriber` or `leaderboard_snapshot` query | 27 ms |
| `/leaderboard` page alone, 200/s for 120 s | 24,000 | 24,000 HTTP 200; **0 `subscriber` queries**, one `leaderboard_snapshot` read by the API's background cache refresh | 9 ms |
| Combined: referral landings at 200/s | 24,000 | **24,000 HTTP 200**, 0 transport errors | 28 ms |
| Combined: `/leaderboard` page at 200/s | 24,000 | **24,000 HTTP 200**, 0 transport errors | 28 ms |
| Combined: signups at 20/s | 2,400 | **2,400 HTTP 200** | 657 ms |
| Leaderboard API spike, 200/s for 120 s (the original phase) | 24,000 | 24,000 HTTP 200, every response carrying the seeded snapshot; 0 `subscriber` calls and one `leaderboard_snapshot` read by the background refresh | 12 ms |

The row, business-key and drained-queue invariants held across all 17,400 timed signups and the warm-up: 15,665 subscriber rows, all distinct; 15,665 `email_send` rows with 15,665 distinct business keys, all sent by the fake sink in 157 batches; 0 queued and 0 failed.

| Container | Peak sampled memory | Limit |
|---|---:|---:|
| App | 134.9 MiB | 768 MiB |
| PostgreSQL | 168.8 MiB | 512 MiB |
| Umami | 210.3 MiB | 768 MiB |

An earlier full run the same evening, `7e5b897a`, on a build of the same branch taken before a type-only change to how the cache copies response headers (image `sha256:389b6a9b…`), also passed every phase: combined page p95 8 ms, combined signup p95 545 ms, leaderboard-API p95 4 ms, app peak 145.1 MiB. The run above is the record because its image matches the committed code.

**Before the render cache, the same profile failed (2026-11-13 UTC).** Run `5feacafc` (image `sha256:0db76e52…`) stopped at the combined phase: 895 referral landings and 1,623 `/leaderboard` page requests had no response within 30 seconds, and only 520 of the 2,400 signups succeeded (1,604 HTTP 503, 276 HTTP 500, signup p95 69,384 ms). Two earlier full runs that day, `446a2f00` and `e18d3f8b`, lost 1,163 and 552 signups in their combined phases, with 21–34% of page requests unanswered. Memory was never the limit: one Node process's CPU was. Short probes then held at 100/s per page combined with signups and saturated at 150–200/s. Those figures are kept in git history in the earlier version of `e11-01-gate-7-results.json`.

This laptop's numbers do not predict the host's; E12-06 re-runs these phases there with the same script and profile.
