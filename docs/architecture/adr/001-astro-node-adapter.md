# ADR-001: Astro with the Node adapter, and only three islands

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
The v1 recommendation was Next.js, and its only real argument was component reuse with the storefront. ADR-002 decouples the repositories, which removes that argument entirely. What is left is a site that is mostly static content with a handful of interactive elements and a public write endpoint.

## Decision
**Astro with the Node adapter.** Three interactive islands and no more: the signup form, the theme toggle, and the leaderboard. Everything else ships zero client JavaScript.

A fourth island requires an ADR. This is not ceremony — the payload discipline is the whole reason for the choice, and island count is the metric that erodes first.

## Alternatives rejected
- **Next.js App Router** — led only on reuse, which no longer exists. Larger payload, heavier model for a page that is mostly prose.
- **A static generator with a separate API** — two deploy units and a CORS boundary for a site with one write path.
- **Plain HTML plus a form service** — cannot express referral attribution, eligibility gating or the survey write-back.

## Consequences
Smaller payload and Core Web Vitals headroom on a page whose job is to convert a suspicious visitor. **The storefront cannot reuse these components** — that cost is priced in ADR-002. The Node adapter keeps API routes same-origin (ADR-005) and makes the Cloudflare Pages alternative an adapter swap rather than a rewrite (ADR-003).

Reopens if the campaign needs genuinely application-like interactivity — which would be a sign the scope has drifted, not that the framework was wrong.
