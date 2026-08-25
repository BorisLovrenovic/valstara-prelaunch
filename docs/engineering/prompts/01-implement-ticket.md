You are implementing exactly one ticket for the **Valstara pre-launch waitlist site** — an Astro site on `valstara.com` that collects waitlist signups, verifies them by double opt-in, attributes referrals, runs a geo-scoped giveaway, and hands a clean list to the storefront at launch. **The ticket's acceptance criteria are the contract.** `AGENTS.md` at the repository root is binding; this prompt adds ticket-cycle specifics.

This is a production system that will hold real people's personal data and run a real prize draw: **no placeholder, stub or demo-grade implementation of in-scope work.** Anything incomplete is reported under Deviations, never disguised as complete.

## Ticket

- **Ticket ID and title:** E1-01 — Repository scaffold: Astro, Node adapter, strict TypeScript
- **Epic:** Epic E1 — Foundations
- **Notes / changes since the plan was written (leave "None" if the plan is current):** None

These three values are given once. Everywhere below, *the ticket ID*, *the ticket title* and *the epic* refer back to this block — substitute them yourself wherever an output format asks.

The ticket's **Model** and **Why this tier** lines are routing metadata already applied by the founder. Read past them; they are not instructions to you.

The ticket lives in `docs/plan/development-plan.md`, which is the **single source of truth**. Locate it by **both** ID and title. If they point at different tickets, **STOP and ask** — do not guess which is meant.

## Step 1 — Read before writing any code, in this order

1. **`docs/plan/development-plan.md`, in full.** Not just your ticket. Read §0 (governance), §2 (founder prerequisites), §4 (standing rules), the epic dependency graph, and enough of the surrounding epics to know what has been built, what comes later, and **what future tickets assume this one produces.** That context informs *how* you implement — never *what*. Your scope is this ticket only.
2. **Every path on your ticket's Docs line**, fully — the section and enough surrounding context to apply it correctly.
3. `AGENTS.md` · `docs/architecture/modules.md` · `docs/engineering/standards.md`.
4. Conditionally:
   - Touching anything that **reaches the browser** → `docs/architecture/adr/007-cookieless-analytics.md`, `008-server-side-referral-attribution.md`, `013-no-fingerprinting.md`, and `docs/legal/compliance.md#3-eprivacy--why-there-is-no-banner`.
   - Touching **subscribers, tokens or verification** → `docs/modules/subscriber.md`, `docs/modules/verification.md`, ADR-011.
   - Touching **referrals or rewards** → `docs/modules/referral.md`, ADR-008, ADR-012.
   - Touching **the giveaway** → `docs/modules/giveaway.md`, ADR-018, `docs/legal/compliance.md#4-giveaway--jurisdiction-exclusions`.
   - Touching **email** → `docs/modules/email.md`, ADR-009, ADR-010.
   - Touching **personal data of any kind** → `docs/data/model.md#ip-handling`, `docs/legal/compliance.md`, `docs/security/threat-model.md`.
   - Implementing any **failure or degradation behaviour** → the matching rows of `docs/architecture/fallbacks.md`.
   - Touching the **API surface** → `docs/api/README.md` and its closed code set.
   - Any **customer-visible string** → `docs/brand/copy-rules.md` and `docs/brand/tokens.md`.

## Step 2 — Stop-and-ask rule (before and during work)

**STOP** — write no speculative code — in any of these cases:

- The ticket and its referenced docs conflict, or leave open a decision that materially changes the implementation (interface shape, data model, state machine, flag behaviour, scope).
- **The ticket contradicts the wider plan.** Because you have read all of it, you are the check on it: flag it if this ticket's scope, interfaces, data shapes or assumptions clash with its epic's goal, the standing rules, what earlier tickets built, or what later tickets assume. **A contradiction caught now costs one question; caught six tickets later it costs a rewrite.**
- The ID and title do not resolve to the same ticket.
- **A founder prerequisite the ticket depends on is outstanding** — brand token values, trust-page prose, the Article 27 representatives, the giveaway rules text, an ESP upgrade, or DNS authentication. **Never invent one of these.** Two of the five are legally significant if a placeholder ships.
- The ticket depends on an unrecorded founder decision — an unapproved paid service, an unresolved `Proposed` ADR, a missing configuration value.

End the run with:

```
BLOCKED: <ticket ID> — <ticket title>
Questions:
1. <precise question, quoting the conflicting ticket/plan/doc text, with the options you see and your recommendation>
```

Then stop. **Never resolve an ambiguity by assumption, and never "fix" the plan yourself** — the plan changes only with founder authorisation.

## Step 3 — Plan before code, visibly

State a short plan: each acceptance criterion → the files you will change → the test that will prove it, plus the flag and docs touchpoints, and one line on how this ticket fits what comes before and after it. Brief — an audit artifact, not an essay. If drafting it surfaces a conflict, stop per Step 2 **before any code exists.**

## Step 4 — Scope discipline

- Implement **exactly** what the Build section specifies. No scope creep, no unrequested refactors, no drive-by improvements, no dependency bumps, **no scaffolding for future tickets.**
- Permanently out of scope — never scaffold: a consent banner · device fingerprinting · GA4 or Meta pixels · passwords or sessions · an i18n framework · SMS · a hosted waitlist or referral SaaS · a public API · **a fourth island** · any write into Medusa's database · position inflation, countdown timers or manufactured scarcity.
- A new runtime dependency only if the ticket genuinely requires it. Record name, why, licence, **and what it loads in the browser**, for the PR description. **No new paid service, ever** — that needs founder approval through an ADR.

## Step 5 — Hard rules while implementing (violations fail review)

All eighteen rules in `AGENTS.md` apply. The six that break most often, restated:

1. **Privacy is structural.** No non-essential cookie, no storage identifier beyond the single theme preference, no fingerprinting API, no third-party request from a rendered page. **This is what removes the consent banner**, and one careless dependency reverses it. If your change reaches the browser, state in your summary what it loads.
2. **Nothing counts an unverified subscriber** — not the leaderboard, a tier, an entry, the broadcast list or the export.
3. **A high-value referral reward can never settle from a verification alone.** Cheap rewards settle on confirmation; high-value rewards are held to a post-launch first order.
4. **Turnstile server-side, before any other work**, on every write route. **Normalise the email before any uniqueness check.**
5. **One email per business key, and suppression is re-checked at dispatch** — not only at queue time.
6. **A full IP address is never stored, logged or returned.** Truncate, then hash with the server-side pepper.

Plus: the ticket's **flag** wired with a code-level fail-safe default and a graceful flag-off path · failure behaviour matching its `docs/architecture/fallbacks.md` row exactly, including alert severity · typed errors from the closed code set, **never a forwarded vendor error body** · customer strings from the copy layer in brand voice · **no literal colour, font, radius, spacing or duration in a component** · **no prose inline in markup** · **every sweep, export and bulk operation batch-capped.**

## Step 6 — Tests are part of this ticket

The QA gate later is an **audit, not the safety net.** Implement, minimum:

- **Every test named on the ticket's Tests line.**
- **Unit** tests for all new logic.
- **Integration** tests against the local stack where the ticket wires components together.
- **A test proving the flag-off path is graceful**, where a flag is involved.
- Where an acceptance criterion states an **invariant** — idempotency, single-use, write-once, derivation from a source table, reproducibility — implement it as a **seeded property-based test** with a fixed seed and bounded runs, **alongside** example cases, not instead of them.
- **Concurrency-sensitive behaviour is tested under genuine concurrency against a real database, never mocked.** Duplicate signup and duplicate entry accrual are the canonical cases — both rely on database constraints, and a mocked test proves nothing about a constraint.
- **Time-dependent logic injects a clock.** Never `Date.now()` in a test path.
- Coverage bars hold: ≥80% changed code; ≥90% in `subscriber`, `verification`, `referral`, `giveaway`, `email`.

**A test that would still pass if the feature broke is a defect.** For at least one critical test, mentally mutate the implementation and confirm the test would catch it.

## Step 7 — Verify locally, then commit

- Start the stack if integration tests need it: `docker compose -f infra/compose/docker-compose.yml up -d`
- Run: `npm run lint && npm run typecheck && npm test && npm run build`
- Schema changed? Add a **new forward-only migration file** — additive first — and **never edit one that has already run.** Review it in the diff.
- **Fix every failure. Never skip, delete or weaken a test or gate to get green.**
- **Docs duty:** behaviour, contract, env or decision changes update the matching `docs/**` file and ADR **now, in this ticket.** New environment variables go in `infra/ENV.md`. Doc drift is a review blocker.
- Branch `feat/<ticket ID>-<slug>` from `main`; Conventional Commits including the ticket ID. Commit locally. **Do not push or open a PR** — that happens only after the pre-PR review passes.

## Step 8 — End with this summary, exact headings

```
## <ticket ID> — <ticket title> — implementation summary
### Implemented
### Tests added (path → what it asserts)
### Docs/ADRs updated
### New dependencies (or "None")   ← name, why, licence, and what it loads in the browser
### Privacy impact (or "None")     ← anything new that reaches the browser, sets storage, or touches personal data
### Deviations & uncertainty (or "None")   ← anything differing from ticket/plan/docs; NEVER silent
### Plan observations (or "None")   ← tensions with later tickets you noticed but did NOT act on
### Commands run + results
### Open questions (or "None")
```

If any acceptance criterion is not demonstrably met, **say so explicitly under Deviations.** Honest incompleteness is acceptable; silent gaps are not.
