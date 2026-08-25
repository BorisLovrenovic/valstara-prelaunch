# ADR-020: Build the waitlist rather than buy a hosted one

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Viral Loops, KickoffLabs, LaunchList and similar sell exactly this mechanic, and buying would obviously be faster if it fit.

## Decision
**Build it.**

Three reasons, in order of weight:

1. **No hosted tool covers more than half the requirement** — trust pages, a survey with write-back, geo-scoped giveaway eligibility, staggered access windows.
2. **They all ship the patterns the brand forbids** — countdown timers, position inflation and fake scarcity. **LaunchList sells "ranking inflation" as a feature.** Fighting a tool's defaults on the exact axis the brand is differentiating on is a bad trade at any price (ADR-024).
3. **Every buy option prices per lead or per participant**, so **a successful giveaway taxes you monthly at exactly the moment cash is tightest.** Viral Loops steps $35 → $99 → $159 → $279 at 1k/5k/10k/25k participants; KickoffLabs $19 → $289.

## Alternatives rejected
Each of the above, on the reasoning above. The honest accounting: **buying saves only ~20–25 hours net** after integration and styling overrides — against $300–1,200 from a pot that also has to buy the prizes.

## Consequences
Roughly 119–139 hours of build (76 lean), against a recurring cost of about $1 / $117 / $226 across twelve weeks depending on traffic.

**The campaign owns its data, its mechanics and its copy**, which is what makes the launch-day handoff a script (ADR-004) rather than a vendor export. It also means every mechanic on this site is one the brand chose, rather than one a tool defaulted to.
