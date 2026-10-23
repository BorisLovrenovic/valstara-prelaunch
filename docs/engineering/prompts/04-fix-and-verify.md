You are fixing an **explicit list of findings** on the Valstara pre-launch branch named below — nothing more. `AGENTS.md` and every hard rule from the implementation prompt remain binding.

## Inputs
*(entries live in `docs/plan/development-plan.md` — read the relevant one before fixing)*

- **Branch:** feat/E1-03-data-layer-migration-runner-initial-schema
- **Ticket ID and title:** E1-03 — Data layer, migration runner and the initial schema
- **Epic:** Epic E1 — Foundations
- **Findings to address, verbatim from the report:**

Blockers (must fix before PR)
1. coverage.config.json:3 and scripts/ci/changed-coverage.mjs:70 — changed-code coverage only recognizes .ts; changed .astro code is ignored and receives 100% coverage with 0/0 lines. This fails the Build requirement for 80% changed-code coverage (ground 1). Cover applicable executable source formats, fail closed when eligible changed code has no coverage entries, and add a red-path fixture proving an uncovered .astro change fails.
2. docs/engineering/git-workflow.md:43 and infra/ENV.md:1 — the required record of whether GitHub branch protection is available is absent. The repository API confirms it is unavailable for the current private-repository plan. This violates standing rule 18 (ground 3). Record that mandatory gates are procedurally enforced because branch protection is unavailable.
Non-blocking findings
1. infra/ENV.md:8 — most of this file’s diff is unrelated table-formatting churn; non-blocking because it does not independently meet one of the three blocker grounds.

## Rules

1. **Fix exactly these findings.** No unrelated changes, no opportunistic refactors, no dependency changes unless a finding requires one — and then note it, **including what it loads in the browser.**
2. **Never fix by weakening a gate.** Do not delete, skip or loosen a test, lower a coverage bar, disable a lint rule, or widen a scanner allowlist to make a finding pass. **Dependency vulnerabilities are fixed by upgrade**, or allowlisted **with written justification and an expiry date** — never silently. **Never add an entry to the cookie/storage allowlist to make the privacy gate pass** — that gate exists precisely to stop that.
3. **Every fix gets proof.** For a behavioural finding, add or strengthen a test that **fails before the fix and passes after** — state which test and how you know it failed before (run it against the pre-fix code, or revert-check). For a doc-drift finding, the proof is the corrected text. **For a "cannot verify" finding, the fix is making it verifiable** — a test or a reproducible command — not an assertion that it is fine.
4. **Dispute path.** If you believe a finding is factually wrong, **do not code around it.** Mark it **DISPUTED** with concrete evidence (file:line, doc quote, command output) and leave the code unchanged. Where the docs do not settle the right fix, mark it **NEEDS-DECISION** with the options — stop-and-ask applies here too.
5. **Re-read the doc section each finding cites before fixing it.** Fix to the documented rule, not to the reviewer's paraphrase.
6. **A finding that is actually a plan defect is not yours to fix.** If the correct fix would require changing a ticket's scope, interfaces or acceptance criteria, mark it **NEEDS-DECISION** — **the plan changes only with founder authorisation.**
7. **A finding that is blocked on a founder prerequisite is NEEDS-DECISION**, never a placeholder.
8. **Do not build another ticket's work to close a finding.** If a fix seems to require it, check standing rule 19 first: a constraint belonging to a structure **this** ticket creates is this ticket's, and building it is correct. Anything genuinely owned elsewhere is **NEEDS-DECISION**.
9. **Do not add tests, fixtures or styles the ticket did not ask for.** The Tests line is the contract. Converting working example tests to generated or property-based ones is not a fix, and it creates new surface for the next review.

## Self-review before you declare done — mandatory

**This is the step that stops the loop.** A fix that closes one blocker and opens another costs a full cycle, and you are the cheapest place to catch it.

When every finding is addressed, **re-review your own diff as an independent reviewer would**, using the three blocker grounds in `docs/engineering/prompts/02-pre-pr-review.md`:

1. **Re-read the ticket's acceptance criteria in full** — not just the ones the findings touched. Confirm your changes did not break one that previously passed.
2. **Re-read the ticket's Tests line.** Every named test still present and still meaningful.
3. **Diff your own diff.** For everything you added: is it inside this ticket's scope? Did you introduce a file, migration, dependency, role, service or config another ticket owns? Did you add a test the ticket did not ask for?
4. **Mutate one behaviour you changed** and confirm a test catches it.
5. **Check the standing rules your change now touches** — especially rule 19 (constraints ship with their structure) and rule 20 (self-contained).

**If this pass finds a new problem, fix it now and run the pass again.** Do not hand it forward. Report what the pass found under `Self-review` below — including "nothing", which is a real result worth stating.

## Verify

- Re-run the **specific check each finding names** — the failing test, the query, the command.
- Then the quick local gate:
  ```
  docker compose -f infra/compose/docker-compose.yml up -d
  npm run check
  npm run test:changed -- <the ticket's Tests-line files and each finding's test>
  ```
  `test:changed` also picks every test the fixes affect, and adds the privacy and accessibility suites when a fix can reach the browser. The full suite runs in CI on the pull request (`docs/engineering/ci-cd.md#local-checks`).
- Schema touched? Add a **new forward-only migration** — never edit one that has already run.
- Commit on that branch with Conventional Commits referencing the ticket ID.

## Output exactly this

```
# Fix-and-verify — <source> — <ticket ID>
| # | Finding (short) | Status | Fix (files) | Proof (test/command + failed-before evidence) |
|---|-----------------|--------|-------------|-----------------------------------------------|
| 1 | ...             | FIXED / DISPUTED / NEEDS-DECISION | ... | ... |

## Self-review (mandatory)
- Acceptance criteria re-read in full: <all still met? which, if any, you had to repair>
- Tests line re-read: <all named tests present and meaningful>
- Scope check on my own additions: <anything belonging to another ticket — or "none">
- Mutation run: <what you broke → which test caught it>
- Standing rules touched: <which, and how they hold>
- New problems this pass found and fixed: <or "none">

## Commands run + results
## Privacy impact of these fixes (or "None")
## Deviations & uncertainty (or "None")
```

**Every finding from the input list must appear in the table — none may be silently dropped.**

After review-sourced fixes: the branch is ready for push and PR **once every row is FIXED** — DISPUTED and NEEDS-DECISION rows go back to the founder first. After QA-sourced fixes: **the QA blocker list must be re-verified clear before the next epic opens.**
