# ADR-003: Self-hosted on the existing VPS, behind Cloudflare

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
v1 assumed Vercel Pro at $20/month. With Astro and a Node adapter, the site can run in Docker Compose beside the services already on the €15 VPS, and the Cloudflare zone already exists.

## Decision
**Self-host on the existing VPS**, under Docker Compose with hard memory limits and no swap, behind a Caddy reverse proxy, with **Cloudflare proxying and caching in front**. Turnstile and Web Analytics come from the same zone.

Caddy is the only service that publishes origin ports. It terminates TLS with
a Cloudflare Origin CA certificate, rejects socket peers outside Cloudflare's
published IPv4 and IPv6 ranges before proxying, and actively health-checks the
application upstream. This application-layer source check remains effective
across Docker's host-port forwarding; forwarding headers are not accepted as
proof that a request came through Cloudflare.

The app joins the internal database network and an outbound network for
server-side Turnstile verification. Astro accepts the forwarded client address
only for the allowed `valstara.com` Host, which Caddy forwards; the origin still
has no public app port. E11-01's local proxy-header run exposed the missing
Host validation and outbound path (corrected 2026-10-07).

Cloudflare Pages plus Workers is the recorded alternative if running the site on the box becomes unattractive; the Astro code is portable with an adapter swap.

## Alternatives rejected
- **Vercel Pro** — $20/month for capacity that already exists. Vercel returns at store launch for the Next.js storefront, as locked.
- **Cloudflare Pages now** — viable, and it means moving PostgreSQL access to a Worker-compatible path. That is a real cost for no gain while the VPS has headroom.

## Consequences
Removes the last recurring hosting line: 12-week spend drops to roughly $1 / $117 / $226 at 2k / 20k / 200k visitors.

**Spike behaviour is the interesting property.** Static pages served through Cloudflare absorb a viral moment without a bill; the VPS only ever sees writes, and ~30k signups on a peak day is nothing for PostgreSQL. Three rules follow and bind every ticket: **cache what a spike can read repeatedly** (the leaderboard, ADR-024), **cap every sweep and export**, and **never hold a result set in memory**. Load-test the signup endpoint at 10× expected peak regardless.

**E11-01 local correctness profile (founder-authorised 2026-10-07).** Model expected peak as 20% of that 30k-signup day arriving in one hour, about 1.7 signups/s; round 10× to 20 signups/s. Sustain that rate for 10 minutes, then burst at 50/s for one minute. Use roughly 90% unique addresses across many simulated client prefixes, 10% repeats, and a separately hostile prefix. Turnstile uses always-pass test keys, and mail dispatch uses a fake/sink provider with no live sending. Assert the unique-normalised-address row count, zero duplicates, one queued verification mail per business key, a fully drained queue, isolated 429s with honest wait times for the hostile prefix, and 5xx against a recorded tolerance targeting zero. Record p95 latency and container memory. During the signup run, stream a deliberately large export and keep memory within limits. Then load the leaderboard at 200 requests/s for two minutes and prove every response came from the snapshot cache with zero `subscriber` queries using `pg_stat_statements` or the query log. Enumerate caps on every sweep, export and bulk query. Keep rates configurable in the exercise script and record its parameters and results. This local run tests correctness; E12-06 measures capacity on the real host.

The completed local run, its full memory series and the bounded-query inventory are recorded in [`docs/testing/e11-01-load-report.md`](../../testing/e11-01-load-report.md).

Note that this is not the "no Cloudflare proxy in front of Vercel" case. That rule is about Vercel, and Vercel is not involved.
