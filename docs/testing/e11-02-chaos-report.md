# E11-02 local chaos drills

**Passed on 2026-10-08 UTC.** Drills 1–6 and 8 in [the fallback matrix](../architecture/fallbacks.md#chaos-drills) ran against an isolated local project based on `infra/compose/docker-compose.production.yml`, using image digest `sha256:c2544e54928ca23cb9a34b0a4ddd17cfb43210affc487490033a8e03792f4c7a`. The machine-readable timings and assertions are in [e11-02-results.json](e11-02-results.json). Drills 7, 9 and 10 require real infrastructure and belong to E12-06. The local timings below are observations, not a production restore RTO; E12-04 owns the measured R2 restore RTO.

## Reproduction

Build the current application image and run the isolated, disposable drill harness:

```sh
docker build -t valstara-chaos:e11-02 .
node scripts/chaos/e11-02-run.mjs
```

The runner starts the production Compose services with `scripts/chaos/docker-compose.chaos.yml`, binds app and database ports to loopback, migrates a fresh database, executes the drills, records the result JSON, and removes its Compose project. The overlay mounts local server modules and a Node preload for controlled Cloudflare siteverify, Resend, and alert-webhook responses. These are simulated provider responses, while the application, PostgreSQL transactions, route handlers, email dispatcher, snapshot job, referral repair, flags, and webhooks are real local components. The preload prevents live provider sends. All credentials and data are disposable; the result file contains no email addresses, raw IPs, tokens, or secrets.

## Recorded result

| Drill | Observed result | Elapsed |
|---|---|---:|
| 1. PostgreSQL stopped mid-signup | HTTP 503 `unavailable`; zero partial subscriber rows after database restart | 12,606 ms, including database restart |
| 2. Resend key revoked | Subscriber row committed; mail remained queued after failed send and reached `sent` on the second attempt after key restoration | 4,833 ms |
| 3. Turnstile invalid, replayed, then secret fault | Invalid and replayed tokens each rejected with zero rows. Under the broken secret, two signups passed the strict bucket and both carried one `challenge_timeout` flag; a third received HTTP 429. One sanitized P1 alert fired. Restored secret resumed ordinary verification without a flag | 1,588 ms |
| 4. Snapshot worker killed | The site served the same snapshot ID and `as_of` timestamp after the worker stopped | 1,766 ms |
| 5. Referral counter corrupted | Repair restored the count from the edge, wrote an audit row, and raised one P2 alert | 2,094 ms |
| 6. `leaderboard.public` switched off | Section absent 2,204 ms after the flag update, inside the 5-second cache window, with no deploy; section returned after restoration | 7,291 ms including restoration |
| 8. Replays | Verification-token replay returned success without a second verification; Turnstile replay was rejected without a row; duplicate Brevo webhook delivery left one event and one suppression row | 620 ms |

The first PostgreSQL attempt exposed an uncoded `pg` connection-termination error that had produced HTTP 500 `internal`. The database adapter now classifies that driver error as unavailable; drill 1 then returned the matrix's HTTP 503 and left no partial row. No unresolved matrix deviation remained in the passing run.
