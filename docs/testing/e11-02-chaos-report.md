# E11-02 local chaos drills

**Passed on 2026-10-08 UTC.** Drills 1–6 and 8 in [the fallback matrix](../architecture/fallbacks.md#chaos-drills) ran against an isolated local project based on `infra/compose/docker-compose.production.yml`, using image digest `sha256:26a63f27302df3e3a0a6c40f400f2b3b7010ad140856f75ef40284f1ec454ebd`. The machine-readable timings and assertions are in [e11-02-results.json](e11-02-results.json). Drills 7, 9 and 10 require real infrastructure and belong to E12-06. The local timings below are observations, not a production restore RTO; E12-04 owns the measured R2 restore RTO.

## Reproduction

Build the current application image and run the isolated, disposable drill harness:

```sh
docker build -t valstara-chaos:e11-02 .
node scripts/chaos/e11-02-run.mjs
```

The runner starts the production Compose services with `scripts/chaos/docker-compose.chaos.yml`, binds app and database ports to loopback, migrates a fresh database, executes the drills, records the result JSON, and removes its Compose project. The overlay mounts local server modules and a Node preload for controlled Cloudflare siteverify, Resend, and alert-webhook responses. These are simulated provider responses, while the application, PostgreSQL transactions, route handlers, email dispatcher, snapshot job, referral repair, flags, and webhooks are real local components. The preload prevents live provider sends. Drill 1 holds an after-insert trigger on a PostgreSQL advisory lock, observes the signup transaction waiting at that insert, and kills PostgreSQL before the transaction commits. All credentials and data are disposable; the result file contains no email addresses, raw IPs, tokens, or secrets.

## Recorded result

| Drill | Observed result | Elapsed |
|---|---|---:|
| 1. PostgreSQL stopped mid-signup | Subscriber insert reached; HTTP 503 `unavailable`; zero partial subscriber rows after database restart | 7,005 ms, including database restart |
| 2. Resend key revoked | Subscriber row committed; mail remained queued after failed send and reached `sent` on the second attempt after key restoration | 3,971 ms |
| 3. Turnstile invalid, replayed, then secret fault | Invalid and replayed tokens each rejected with zero rows. Under the broken secret, two signups passed the strict bucket and both carried one `challenge_timeout` flag; a third received HTTP 429. One sanitized P1 alert fired. Restored secret resumed ordinary verification without a flag | 1,604 ms |
| 4. Snapshot worker killed | Worker remained stopped for 301,100 ms, beyond the five-minute refresh interval. The database's latest row and the API response retained the same snapshot ID and `as_of` timestamp | 302,940 ms |
| 5. Referral counter corrupted | Repair restored the count from the edge, wrote an audit row, and raised one P2 alert | 1,514 ms |
| 6. `leaderboard.public` switched off | Section absent 1,735 ms after the flag update, inside the 5-second cache window, with no deploy; section returned after restoration | 6,940 ms including restoration |
| 8. Replays | Verification-token replay returned success without a second verification; Turnstile replay was rejected without a row; duplicate Brevo webhook delivery left one event and one suppression row | 639 ms |

Drill 4's regression check used a temporary application image that discarded snapshots older than 30 seconds. The strengthened drill failed at its HTTP status assertion (`503 !== 200`) after the five-minute hold. The cutoff was removed before the passing run above.

The original PostgreSQL attempt stopped the database during Turnstile verification and never reached the subscriber insert. The corrected failure point exposed an unhandled error event on a checked-out `pg` client: the app exited and reset the request. The database adapter now handles that event while the client is checked out and classifies the query failure as unavailable. Drill 1 then returned the matrix's HTTP 503 with no partial row after restart. No unresolved matrix deviation remained in the passing run.
