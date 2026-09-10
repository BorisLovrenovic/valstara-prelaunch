# ADR-013: No device fingerprinting

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Device fingerprinting is the conventional next layer of referral-fraud detection after IP and email heuristics.

## Decision
**The site runs no device-fingerprinting API.** No canvas, font enumeration, WebGL or timing-entropy collection is invoked by site code. CI-scanned. Cloudflare Turnstile's disclosed server-side processing of IP, TLS and user-agent security signals under its processor role is not represented as absent.

Three independent reasons, each sufficient:

1. **It requires consent under ePrivacy** regardless of cookies — so it costs the banner-free property (ADR-007), which costs conversion, which is the thing the fraud control exists to protect.
2. **FingerprintJS licensing is ambiguous across versions**, and Fingerprint Pro is roughly $99/month.
3. **Reward gating already makes the fraud class unprofitable** (ADR-012), so this would be paying for a control against an attack that no longer pays.

## Alternatives rejected
- **FingerprintJS open source** — licence ambiguity plus the consent problem.
- **Fingerprint Pro** — ~$99/month plus the consent problem.
- **Hand-rolled browser entropy** — the consent problem without even the accuracy.

## Consequences
Some duplicate-identity fraud is undetectable at signup. That is the accepted trade, and it is bounded by reward gating and by the manual review of the top 20 before any award.

**The scan is the enforcement.** A dependency that fingerprints is as much a violation as code that does, which is why a new browser-reaching dependency requires an explicit note in the PR describing what it loads.
