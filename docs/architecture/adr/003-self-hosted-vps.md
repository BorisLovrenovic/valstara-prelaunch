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

Cloudflare Pages plus Workers is the recorded alternative if running the site on the box becomes unattractive; the Astro code is portable with an adapter swap.

## Alternatives rejected
- **Vercel Pro** — $20/month for capacity that already exists. Vercel returns at store launch for the Next.js storefront, as locked.
- **Cloudflare Pages now** — viable, and it means moving PostgreSQL access to a Worker-compatible path. That is a real cost for no gain while the VPS has headroom.

## Consequences
Removes the last recurring hosting line: 12-week spend drops to roughly $1 / $117 / $226 at 2k / 20k / 200k visitors.

**Spike behaviour is the interesting property.** Static pages served through Cloudflare absorb a viral moment without a bill; the VPS only ever sees writes, and ~30k signups on a peak day is nothing for PostgreSQL. Three rules follow and bind every ticket: **cache what a spike can read repeatedly** (the leaderboard, ADR-024), **cap every sweep and export**, and **never hold a result set in memory**. Load-test the signup endpoint at 10× expected peak regardless.

Note that this is not the "no Cloudflare proxy in front of Vercel" case. That rule is about Vercel, and Vercel is not involved.
