# ADR-016: Self-hosted OFL fonts; Söhne deferred to store launch

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
The brand's intended display face is Söhne, from Klim. Klim's web licences are perpetual and **tiered on traffic** — and a viral giveaway is precisely an event that pushes past the tier you just bought.

## Decision
**Ship on Instrument Sans and JetBrains Mono**, both OFL, both **self-hosted as WOFF2**. Buy Söhne at store launch, when traffic is predictable.

**Build metric-matched fallbacks with `size-adjust` and `ascent-override` from the first commit**, so the eventual swap is one `@font-face` change plus a QA pass rather than a re-layout.

**Always self-host.** Never the Google Fonts CDN — the Munich ruling makes it a live liability in a named target market, and Klim's licence requires self-hosting regardless. Self-hosting is also what keeps the third-party-request gate green (ADR-007).

## Alternatives rejected
- **Buy Söhne now** — pay for a traffic tier before knowing the traffic, on the one campaign designed to spike.
- **Google Fonts CDN** — a legal liability in Germany and a third-party request that would need justifying against the no-banner property.
- **System fonts only** — the brand is doing real work on a page whose job is to look legitimate.

## Consequences
No font cost during the campaign. **The metric-matched fallbacks are the load-bearing part** — without them, the swap is a layout regression across every page.

The Söhne licence price is a **cost confirmation still open**: Klim prices interactively at checkout. It blocks nothing pre-launch.
