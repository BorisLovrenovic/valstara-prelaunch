# Testing Strategy

Status: authoritative. **The QA gates later are audits, not the safety net.** The tests written inside every ticket are the safety net.

## Tiers

| Tier | Runs against | Covers |
|---|---|---|
| **Unit** | Nothing external | Normalisation, signing, token hashing, tier computation, eligibility tables, copy scanning |
| **Module contract** | A disposable PostgreSQL | Each module's documented interface and its rules — the "Contract tests" line of every `docs/modules/*.md` |
| **Integration** | The local Compose stack | Route → module → database → queued email, end to end |
| **Build-time assertion** | The Astro build | Metadata completeness, frontmatter validity, **the representative-named assertion**, token placeholders |
| **Rendered-page checks** | A built page | No cookie, no storage identifier, no third-party request, axe accessibility |
| **Load** | Production-shaped infrastructure | The signup endpoint at 10× expected peak (E11-01) |

## Coverage bars

≥80% changed code. **≥90% in `subscriber`, `verification`, `referral`, `giveaway`, `email`** — the five modules where a defect is either unrecoverable or discredits the campaign.

## The invariant tests

Each states a property the campaign depends on.

**A seeded property-based test is required where, and only where, a ticket's Tests line names one.** The plan decides; a reviewer may not infer the requirement from an acceptance criterion's wording. Where a ticket does name one, it uses a fixed seed and bounded runs, **alongside** example cases rather than instead of them.

This is deliberate. "Where an AC states an invariant" was the earlier wording and it was undecidable — almost any criterion can be read as stating an invariant, so the requirement was whatever a given reviewer thought it was, and no ticket could be finished. If a property test is worth having, the ticket says so.

| # | Invariant | Where |
|---|---|---|
| I1 | **No unverified subscriber is counted, ranked, rewarded, exported or broadcast to** | Every consuming surface |
| I2 | **One subscriber per normalised email** — `+tag` and Gmail-dot variants collide | `subscriber` |
| I3 | **One referral edge per referred person**, enforced by the database | `referral` |
| I4 | **`confirmed_referrals` recomputes idempotently from edges** for any generated graph | `referral` |
| I5 | **A high-value reward cannot settle from a verification path** | `referral` |
| I6 | **One email per business key** — a retry never double-sends | `email` |
| I7 | **Suppression written between queue and dispatch stops the send** | `email` |
| I8 | **A replayed verification token returns success, not an error** | `verification` |
| I9 | **No entry accrues for an unverified subscriber, and no accrual double-credits** | `giveaway` |
| I10 | **A draw reproduces from its recorded seed and snapshot hash** | `giveaway` |
| I11 | **No code path sets `disqualified` without a recorded human actor** | `fraud` |
| I12 | **`UPDATE` and `DELETE` on `audit_log` are rejected at the database level** | `audit` |
| I13 | **No non-essential cookie, storage identifier, third-party request or fingerprinting API** | Rendered pages, whole repository |
| I14 | **No public response carries another person's data** | Every registered route |
| I15 | **No analytics event property carries personal data** | The event registry |
| I16 | **A full IP address is never stored, logged or returned** | `fraud`, logging |

**A test that would still pass if the feature broke is a defect.** For at least one critical test per ticket, mutate the implementation and confirm the test catches it.

## Rules

- **Time-dependent logic injects a clock. Never `Date.now()` in a test path.** The reminder ladder, token expiry and retention sweeps are all clock-driven and all table-tested.
- **Concurrency-sensitive behaviour is tested under genuine concurrency against a real database, never mocked.** Duplicate signup and duplicate entry accrual are the canonical cases — both rely on database constraints, and a mocked test proves nothing about a constraint.
- **Top-level test files run serially.** Database fixtures create separate databases on one PostgreSQL cluster, but migrations provision the cluster-global `valstara_app` role; parallel files can otherwise race while updating that shared role. Tests that assert concurrency create genuine parallel database sessions inside the test.
- **Fixtures are explicit by default; generated only where the test asserts a property over many inputs.** An example test reads better with literal values a person can check at a glance, and `crypto.randomUUID()` for an identifier nobody asserts on is fine. **A generated fixture must be seeded** — a fixed seed, so a failure reproduces. Do not convert working example fixtures to generated ones; that trades clarity for nothing.
- **A flake is a finding, not noise.** Fix the nondeterminism; quarantining requires an explicit follow-up.

## What a reviewer may require

**This section exists to make review decidable.** A ticket that can fail review on a rule nobody can bound is a ticket that never finishes, and that is a defect in this document rather than in the branch.

A pre-PR reviewer may raise a blocker on exactly three grounds:

1. **An acceptance criterion on the ticket is not met, or is met but not demonstrated** by a named test or a reproducible command.
2. **A test named on the ticket's Tests line is missing, or would still pass if the behaviour it names broke.**
3. **A standing rule in `docs/plan/development-plan.md#4-standing-rules-for-every-ticket` is violated by this diff.**

**Nothing else is a blocker.** Specifically, a reviewer may **not** require:

- a test style the ticket did not ask for — property-based, generated fixtures, table-driven — where example tests demonstrate the criterion
- coverage of code the ticket did not touch
- work owned by another ticket, whether earlier or later
- a refactor, a rename, or a structural preference
- rework of something a previous review on the same ticket already passed, unless this diff changed it

Anything real but outside those three grounds goes under **Non-blocking findings**, or under **Plan tensions** where the plan itself is at fault. The integrated QA gate is where the repository is audited as a whole.

## Definition of done

A ticket is done when **all** of the following hold:

1. Every acceptance criterion is met and **demonstrated by a named test or a reproducible command**
2. Every test on the ticket's **Tests** line exists and passes
3. `lint`, `typecheck`, `test`, `build` clean locally
4. Coverage bars hold
5. Security and privacy gates green
6. The ticket's flag is wired with a code-level fail-safe default, **and the flag-off path is tested**
7. **Docs and ADRs updated in the same PR**
8. No forbidden copy string, no placeholder value, no TODO in in-scope work
9. Deviations reported explicitly — **honest incompleteness is acceptable, silent gaps are not**
