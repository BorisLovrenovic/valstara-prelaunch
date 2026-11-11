You are implementing exactly one ticket for the **Valstara pre-launch waitlist site** — an Astro site on `valstara.com` that collects waitlist signups, verifies them by double opt-in, attributes referrals, runs one global giveaway under Hong Kong law, and hands a clean list to the storefront at launch. **The ticket's acceptance criteria are the contract.** `AGENTS.md` at the repository root is binding; this prompt adds ticket-cycle specifics.

This is a production system that will hold real people's personal data and run a real prize draw: **no placeholder, stub or demo-grade implementation of in-scope work.** Anything incomplete is reported under Deviations, never disguised as complete.

## Ticket

- **Ticket ID and title:** {TICKET_ID} — {TICKET_TITLE}
- **Epic:** {EPIC}
- **Notes / changes since the plan was written (leave "None" if the plan is current):** {NOTES}

These values are given once. Everywhere below, *the ticket ID*, *the ticket title* and *the epic* refer back to this block — substitute them yourself wherever an output format asks.

**Create the ticket's branch first, before anything else.** You start on `main`. Name the branch `feat/<ticket ID>-<slug>`, where the slug is the ticket title in lowercase ASCII words joined by hyphens, cut at a word boundary to at most 50 characters (for example `feat/E11.5-11r-final-design-member-page-and-leaderboard`). Then:

```
git fetch origin
git branch --list 'feat/<ticket ID>-*'      # a re-run finds the branch the earlier run created
git switch <that branch>                    # if it exists
git switch -c <new branch> origin/main      # if it does not
```

Everywhere below, *the branch* means this branch. Report its exact name in the result block, because every later step uses it. Creating it first means a run that stops before any code still leaves a branch for the founder's decision to be recorded on.

The ticket's **Model** and **Why this model** lines are routing metadata already applied by the founder. Read past them; they are not instructions to you.

The ticket lives in `docs/plan/development-plan.md`, which is the **single source of truth**. Locate it by **both** ID and title. If they point at different tickets, **STOP and ask** — do not guess which is meant.

**Notes carry founder decisions.** When this is a re-run after a `BLOCKED:` stop, the Notes field names the decisions taken since, and the plan entry already records them. The branch may already hold commits from the earlier run: read them (`git log origin/main..HEAD`, `git diff origin/main...HEAD`) and build on them rather than starting over.

## Step 1 — Read before writing any code, in this order

1. **`AGENTS.md`**, in full. It is binding.
2. **`docs/plan/development-plan.md`, in full.** Not just your ticket. Read §0 (governance), §2 (founder prerequisites), §4 (standing rules), the epic dependency graph, and enough of the surrounding epics to know what has been built, what comes later, and **what future tickets assume this one produces.** That context informs *how* you implement — never *what*. Your scope is this ticket only.
3. **Every path on your ticket's Docs line**, fully — the section and enough surrounding context to apply it correctly.
4. `docs/architecture/modules.md` · `docs/engineering/standards.md`.
5. Conditionally:
   - Touching anything that **reaches the browser** → `docs/architecture/adr/007-cookieless-analytics.md`, `008-server-side-referral-attribution.md`, `013-no-fingerprinting.md`, and `docs/legal/compliance.md#3-eprivacy--why-there-is-no-banner`.
   - Touching **subscribers, tokens or verification** → `docs/modules/subscriber.md`, `docs/modules/verification.md`, ADR-011.
   - Touching **referrals or rewards** → `docs/modules/referral.md`, ADR-008, ADR-012.
   - Touching **the giveaway** → `docs/modules/giveaway.md`, ADR-026, ADR-027, and `docs/legal/compliance.md#4-giveaway--one-global-draw-under-hong-kong-law`.
   - Touching **email** → `docs/modules/email.md`, ADR-009, ADR-028.
   - Touching **personal data of any kind** → `docs/data/model.md#ip-handling`, `docs/legal/compliance.md`, `docs/security/threat-model.md`.
   - Implementing any **failure or degradation behaviour** → the matching rows of `docs/architecture/fallbacks.md`.
   - Touching the **API surface** → `docs/api/README.md` and its closed code set.
   - Any **customer-visible string** → `docs/brand/copy-rules.md` and `docs/brand/tokens.md`.

## Step 2 — Stop-and-ask rule (before and during work)

**STOP** — write no speculative code — in any of these cases:

- The ticket and its referenced docs conflict, or leave open a decision that materially changes the implementation (interface shape, data model, state machine, flag behaviour, scope).
- **The ticket contradicts the wider plan.** Because you have read all of it, you are the check on it: flag it if this ticket's scope, interfaces, data shapes or assumptions clash with its epic's goal, the standing rules, what earlier tickets built, or what later tickets assume. **A contradiction caught now costs one question; caught six tickets later it costs a rewrite.**
- The ID and title do not resolve to the same ticket.
- **A founder prerequisite the ticket depends on is outstanding** (plan §2) — for example trust-page prose, an ESP upgrade, the production host or the seed mailboxes. **Never invent one of these.** ADR-029 waived the former Article 27 representative prerequisite and authorised visibly marked draft legal text for E9-03 only.
- The ticket depends on an unrecorded founder decision — an unapproved paid service, an unresolved `Proposed` ADR, a missing configuration value.
- The ticket needs a founder action part-way through (a sign-off, a visual review, an account only the founder holds). Do every part you can, then stop at that point.

End the run with:

```
BLOCKED: <ticket ID> — <ticket title>
Questions:
1. <precise question, quoting the conflicting ticket/plan/doc text, with the options you see and your recommendation>
```

followed by the result block from Step 8 with `"status": "BLOCKED"`. Then stop. **Never resolve an ambiguity by assumption, and never "fix" the plan yourself** — the plan changes only with founder authorisation, recorded through the decision prompt (`docs/engineering/prompts/06-decision.md`).

**Leave the branch clean when you stop.** If you stop after writing code, commit the finished part as `wip(<ticket ID>): <what is done> [<ticket ID>]` so the re-run can build on it, and list it under Deviations. Never leave uncommitted changes behind.

## Step 3 — Plan before code, visibly

State a short plan: each acceptance criterion → the files you will change → the test that will prove it, plus the flag and docs touchpoints, and one line on how this ticket fits what comes before and after it. Brief — an audit artifact, not an essay. If drafting it surfaces a conflict, stop per Step 2 **before any code exists.**

## Step 4 — Scope discipline

- Implement **exactly** what the Build section specifies. No scope creep, no unrequested refactors, no drive-by improvements, no dependency bumps, **no scaffolding for future tickets.**
- Permanently out of scope — never scaffold: a consent banner · device fingerprinting · GA4 or Meta pixels · passwords or sessions · an i18n framework · SMS · a hosted waitlist or referral SaaS · a public API · **a fourth island** · any write into Medusa's database · position inflation, countdown timers or manufactured scarcity.
- A new runtime dependency only if the ticket genuinely requires it. Record name, why, licence, **and what it loads in the browser**, for the PR description. **No new paid service, ever** — that needs founder approval through an ADR.

## Step 5 — Hard rules while implementing (violations fail review)

All twenty hard rules in `AGENTS.md` apply. The six that break most often, restated:

1. **Privacy is structural.** No non-essential cookie, no storage identifier beyond the single theme preference, no fingerprinting API, no third-party request from a rendered page. **This is what removes the consent banner**, and one careless dependency reverses it. If your change reaches the browser, state in your summary what it loads.
2. **Nothing counts an unverified subscriber** — not the leaderboard, a tier, an entry, the broadcast list or the export.
3. **A high-value referral reward can never settle from a verification alone.** Cheap rewards settle on confirmation; high-value rewards are held to a post-launch first order.
4. **Turnstile server-side, before any other work**, on every public write route; a single-use signed token is consumed first in its place where the route is token-authenticated. **Normalise the email before any uniqueness check.**
5. **One email per business key, and suppression is re-checked at dispatch** — not only at queue time.
6. **A full IP address is never stored, logged or returned.** Truncate, then hash with the server-side pepper.

Plus: the ticket's **flag** wired with a code-level fail-safe default and a graceful flag-off path · failure behaviour matching its `docs/architecture/fallbacks.md` row exactly, including alert severity · typed errors from the closed code set, **never a forwarded vendor error body** · customer strings from the copy layer in brand voice · **no literal colour, font, radius, spacing or duration in a component** · **no prose inline in markup** · **every sweep, export and bulk operation batch-capped.**

## Step 6 — Tests are part of this ticket

The QA gate later is an **audit, not the safety net.** Implement, minimum:

- **Every test named on the ticket's Tests line.**
- **Unit** tests for all new logic.
- **Integration** tests against the local stack where the ticket wires components together.
- **A test proving the flag-off path is graceful**, where a flag is involved.
- **A seeded property-based test only where the Tests line names one** (`AGENTS.md#testing`), with a fixed seed and bounded runs, **alongside** example cases, not instead of them.
- **Concurrency-sensitive behaviour is tested under genuine concurrency against a real database, never mocked.** Duplicate signup and duplicate entry accrual are the canonical cases — both rely on database constraints, and a mocked test proves nothing about a constraint.
- **Time-dependent logic injects a clock.** Never `Date.now()` in a test path.
- Coverage bars hold: ≥80% changed code; ≥90% in `subscriber`, `verification`, `referral`, `giveaway`, `email`.

**A test that would still pass if the feature broke is a defect.** For at least one critical test, mentally mutate the implementation and confirm the test would catch it.

## Step 7 — Verify locally, then commit

- **Stay on the branch you created or switched to at the start.** Never work on `main`, and never create a second branch for this ticket.
- Start the stack if integration tests need it: `docker compose -f infra/compose/docker-compose.yml up -d`
- Run the quick local checks: `npm run check`, then `npm run test:changed -- <each test file on the Tests line>`. It also picks every test your change affects and prints why. **The full suite runs in CI on the pull request** (`docs/engineering/ci-cd.md#local-checks`), so do not run the whole `npm test` locally, even for a dependency upgrade.
- Schema changed? Add a **new forward-only migration file** — additive first — and **never edit one that has already run.** Review it in the diff.
- **Fix every failure. Never skip, delete or weaken a test or gate to get green.**
- **Docs duty:** behaviour, contract, env or decision changes update the matching `docs/**` file and ADR **now, in this ticket.** New environment variables go in `infra/ENV.md`. Doc drift is a review blocker.
- Conventional Commits including the ticket ID. Commit locally. **Do not push or open a PR** — that happens only after the pre-PR review passes, in the pre-push step (`07-pre-push-checks.md`).
- Do not touch `docs/plan/ticket-register.md`; the pre-push step marks the ticket done.

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

**Then end your output with this result block, and nothing after it.** It is read by a program: valid JSON, these keys, no comments. Use `[]` for an empty list and `null` for an unknown value.

````
```orchestrator-result
{
  "prompt": "01-implement-ticket",
  "ticket_id": "<ticket ID>",
  "branch": "<the exact name of the branch you created or reused>",
  "status": "DONE | PARTIAL | BLOCKED",
  "head_sha": "<full SHA of HEAD after your last commit, or null if you committed nothing>",
  "uncommitted_changes": false,
  "unmet_criteria": ["<AC as written in the plan — why it is not demonstrably met>"],
  "questions": [
    {
      "id": "Q1",
      "question": "<the question, quoting the conflicting text>",
      "options": ["A: <option>", "B: <option>"],
      "recommendation": "<A or B — one-line reason>"
    }
  ],
  "new_dependencies": ["<name — licence — what it loads in the browser>"],
  "reaches_browser": false,
  "summary": "<one or two plain sentences: what was built, or why you stopped>"
}
```
````

- **`DONE`** — every acceptance criterion met and demonstrated, every Tests-line test present, local checks green, everything committed. `unmet_criteria` and `questions` are empty.
- **`PARTIAL`** — work committed, but an acceptance criterion is not demonstrably met or a local check still fails. Every gap is in `unmet_criteria`.
- **`BLOCKED`** — you stopped under Step 2. `questions` is not empty.
- Open questions that do not stop the work go in `questions` with status `DONE` or `PARTIAL`; the founder sees them before the review runs.
