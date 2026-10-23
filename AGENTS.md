# AGENTS.md — binding rules for coding agents

This repository builds the **Valstara pre-launch waitlist site**. You are working on a production system that will hold real people's personal data, run a real prize draw, and sit on the root domain of a brand whose entire proposition is that it is trustworthy.

**`docs/plan/development-plan.md` is the single source of truth for what gets built.** Read it before writing any code. It changes only with founder authorisation, and never by you.

---

## The five rules that break most often

**1. Nothing may set a non-essential cookie, write a browser-storage identifier, call a fingerprinting API, or make a third-party request from a rendered page.** This site has no consent banner because it has nothing to consent to. One careless dependency reverses that, and the cost is not a banner — it is the conversion the banner takes and the measurement it corrupts. Three CI gates enforce it. **If your change reaches the browser, say in the PR what it loads.**

**2. Nothing counts an unverified subscriber.** Not the leaderboard, not a referral tier, not a giveaway entry, not the broadcast list, not the export. Verification is the boundary the campaign's honesty rests on.

**3. A high-value referral reward can never settle from a verification alone.** Cheap rewards settle on verification; high-value rewards are held until a post-launch first order. This is the anti-fraud design, and it is an invariant with a test on it.

**4. No code path sets `disqualified` without a recorded human actor.** Fraud signals flag. Humans decide. Every decision is audited.

**5. No literal colour, font, radius, spacing or duration value appears in a component**, and no customer-visible prose appears inline in markup. Tokens live in `src/styles/tokens.css`; prose lives in `src/content/` and `src/copy/`. Both files are what the storefront inherits.

---

## Scope discipline

- **Implement exactly what your ticket's Build section specifies.** No scope creep, no unrequested refactors, no drive-by improvements, no dependency bumps, **no scaffolding for future tickets.**
- **Permanently out of scope — never scaffold**: a consent banner · device fingerprinting · GA4 or Meta pixels · passwords or sessions · an i18n framework · SMS · a hosted waitlist or referral SaaS · a public API · a fourth island · any write into Medusa's database · position inflation, countdown timers or manufactured scarcity.
- **A new runtime dependency only if the ticket genuinely requires it.** Record name, why, licence, and what it loads in the browser, for the PR description. **No new paid service, ever** — that needs founder approval through an ADR.

## Stop and ask

**Write no speculative code** when: the ticket and its docs conflict · the ticket contradicts the wider plan · a decision that materially changes the implementation is unrecorded · a `Proposed` ADR is in the path · a required founder input (brand token values, trust-page prose, the representatives' names, prize details) is missing.

**Never resolve an ambiguity by assumption, and never edit the plan yourself.**

## Hard rules, in full

1. Every public, unauthenticated write route verifies Turnstile **server-side first**. A write authenticated by a single-use signed token consumes that token first, in place of Turnstile. Rate limiting applies to both kinds. Founder-authorised amendment 2026-09-28 (ADR-006).
2. Email is **normalised before any uniqueness check**; the normalised form is the unique key.
3. **One referral edge per referred person**, enforced by a database constraint. `referred_by_id` is write-once.
4. **Referral attribution is server-side and signed.** No cookie, no client-side attribution path.
5. **One email per business key**, and **suppression is re-checked at dispatch**, not only at queue time.
6. **A verification token is stored only as its hash**; a replay returns success, not an error.
7. **Every giveaway entry stamps the `rules_version` and rules hash in force when it accrues.** The giveaway is one global draw under Hong Kong law: **no country or location is collected except from a provisional winner at award time**, and entry never depends on marketing consent (ADR-026, ADR-027).
8. **A draw is not published until it reproduces** from its recorded seed and snapshot hash.
9. **A full IP address is never stored, logged or returned** — truncate, then hash with the server-side pepper.
10. **No analytics event property carries personal data.**
11. **No public response carries another person's data.**
12. **The audit log is append-only, by database permission.**
13. **Every sweep, export and bulk operation caps its batch size.** The box has hard memory limits and no swap.
14. **Every state that waits on a person has a defined expiry and a defined fallback.**
15. **Business logic lives in server modules, not in routes.** Only `server/db` issues SQL.
16. **Every feature sits behind its registered flag** with a code-level fail-safe default, and the flag-off path is tested.
17. **No forbidden copy string ships** — CI-scanned.
18. **Docs and ADRs update in the same PR** as behaviour changes. Doc drift is a review blocker.
19. **A ticket that creates a structure also creates the constraints that make it correct** — permissions, triggers, indexes, defaults, checks. They ship with the thing they constrain, never in a later ticket. If your ticket creates a table that a standing rule governs, that rule is enforced in your ticket.
20. **Your ticket is self-contained by construction.** If you cannot meet an acceptance criterion without building something another ticket owns, that is a defect in the plan — **stop and report it**, do not work around it and do not build ahead.

## Testing

The QA gate later is an **audit, not the safety net.** Every ticket implements **every test named on its Tests line**, plus unit tests for new logic and integration tests where it wires components together.

**The Tests line is the contract.** A seeded property test is required where, and only where, the ticket names one — do not add one speculatively, and do not convert working example tests into generated ones. Fixtures are explicit by default; generate only where a test asserts a property over many inputs, and seed it when you do.

Concurrency is tested under real concurrency against a real database. **Time-dependent logic injects a clock — never `Date.now()` in a test path.**

**A test that would still pass if the feature broke is a defect.**

## Before you commit

Run the quick local checks. **The full suite runs in CI on the pull request,** split across parallel runners, and every check must be green before merge (founder-authorised 2026-10-23; `docs/engineering/ci-cd.md#local-checks`).

```
docker compose -f infra/compose/docker-compose.yml up -d
npm run check
npm run test:changed -- <each test file on your ticket's Tests line>
```

`npm run check` runs lint, format, typecheck, the security and privacy scans, and the build. `npm run test:changed` runs every test file your branch changed, every test whose imports reach a changed file, the files you name, and the privacy and accessibility suites whenever a change can reach the browser. It prints why it picked each file. The full `npm test` is not part of the local gate. To reproduce a CI failure, run the failing file.

Fix every failure. **Never skip, delete or weaken a test or gate to get green.** Branch `feat/<ticket-id>-<slug>` from `main`; Conventional Commits including the ticket ID. **Do not push or open a PR** — that happens only after the pre-PR review passes.

## Reference

`docs/README.md` is the map. `docs/architecture/modules.md` is the boundary model. `docs/data/model.md` is the schema. `docs/testing/strategy.md` is the definition of done.

**The folder `docs/example development plan and prompts/` is reference material from a different project. Nothing in it is a decision for this campaign.**
