# Feature Specs

Fourteen pre-launch features, one spec each. Every spec uses the same headings so tickets can reference stable anchors: **Summary · Feature flag · User flows · Edge cases and error states · Acceptance criteria · Telemetry.**

Scope is the 8–12 week campaign on `valstara.com`. Anything that belongs to the store belongs to the storefront repository.

## Flag registry

Flags exist for one reason: **so a mechanic can be switched off during an incident without a deploy.** Every flag is registered in code with a fail-safe default; an unregistered key is an error, never a silent `false` (ADR-023).

| Flag | Default | Spec | Why it can be switched |
|---|---|---|---|
| `signup.enabled` | on | `signup.md` | The kill switch. Off yields an honest paused message, never a broken form |
| `referral.enabled` | on | `referral.md` | Off stops new attribution; existing edges are untouched |
| `leaderboard.public` | on | `leaderboard.md` | **Off during a credibility incident.** The weekly-email top-10 is the fallback surface |
| `giveaway.open` | **off** | `giveaway.md` | **Stays off until the rules pages are published and the ESP tiers are upgraded** |
| `survey.enabled` | on | `survey.md` | Off skips the two questions on the verification success page |
| `member.dashboard` | on | `member-status.md` | Off falls back to the status summary in email only — this is cut-list item 3 |
| `email.broadcast` | **off** | `email-campaign.md` | **Off until domain authentication is verified end to end.** Transactional mail is unaffected |
| `trustpilot.widget` | **off** | `seo.md` | Stays off until the review count justifies displaying a rating |

**Three flags default off.** `trustpilot.widget` is off because a rating below the display threshold is worse than none (ADR-024) — that is a brand decision, and it is turned on by judgement rather than by a gate.

**Two of the three are hard gates**, and this is the distinction that matters: `giveaway.open` and `email.broadcast` each depend on something **outside the code** — published rules pages and appointed representatives for one, verified DNS authentication and an upgraded ESP tier for the other. Neither may be turned on until its prerequisite is complete, and E8-09 enforces the ESP one in code.

## Not flagged, deliberately

**The absence of cookies has no flag**, because a flag implies it can be turned on. Cookieless operation is structural: there is no consent banner precisely because there is nothing to consent to (ADR-007).

**Double opt-in has no flag.** Turning it off would mean broadcasting to unverified addresses, which is the fastest way to destroy the sending reputation the entire campaign depends on (ADR-011).

## Cross-cutting acceptance criteria

These apply to **every** feature and are not restated per spec:

- **No non-essential cookie, and no browser-storage value used to identify a visitor.** The theme preference is the single permitted storage write, and it is functional.
- **No third-party script loads on any page** except two sanctioned, consent-free requests: the deliberately-flagged Trustpilot widget, lazily and only when it is worth showing, and the always-on Cloudflare Turnstile loader on the signup form (ADR-006, founder-authorised 2026-09-08). Turnstile sets no cookie and uses no fingerprinting API.
- **No unverified subscriber is counted, ranked, rewarded, or broadcast to.**
- **Referral attribution is server-side and signed** — never read from a cookie or from client JavaScript.
- **Fraud signals flag; humans decide.** No code path sets `disqualified` without a recorded human action.
- **No email address, referral code, IP address or country appears in an analytics event.**
- **No forbidden copy string ships** (`docs/brand/copy-rules.md`) — CI-scanned.
- **No countdown timer, no fake scarcity, no inflated position, no exit-intent popup.** These are the patterns every hosted alternative sells as features, and shipping one puts this brand in the bracket it is trying to escape.
- **Every state that waits on a person has a defined expiry and a defined fallback.**
- **Every sweep, export and bulk operation caps its batch size.**
- Light-first with a dark toggle · every component references tokens, never literals · body text clears WCAG AA · `prefers-reduced-motion` respected.

## Cut list, in order

From `prelaunch-stack-decisions.md`. **A cut requires founder authorisation and is recorded in the plan before it is implemented.** Cutting is a legitimate response to schedule pressure; cutting silently is not.

1. Internationalisation — **already cut** (ADR-014)
2. Admin UI → SQL plus a CSV export script
3. Member dashboard page → the signed status link in email
4. Public leaderboard → a top-10 block in the weekly email *(also removes the credibility exposure entirely)*
5. Survey as a separate step → two questions on the verification success page *(this is already the default design)*
6. Advanced fraud checks → keep normalisation, blocklist and self-referral; drop velocity anomaly detection
7. Milestone ladder beyond tier 1 → add the five-referral tier mid-campaign

**Never cut:** the signup form · double opt-in deliverability · referral attribution · trust pages · legal and giveaway rules pages · funnel analytics. **If one of these is unfinished, delay the campaign rather than launch without it.**

## Deliberately never built

Permanent decisions, not postponements: a consent banner · device fingerprinting · GA4 or Meta pixels · passwords or sessions · an i18n framework · SMS · a hosted waitlist or referral SaaS · a public API · any write into Medusa's database · position inflation of any kind.
