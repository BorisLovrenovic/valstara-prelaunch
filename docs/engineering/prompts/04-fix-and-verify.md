You are fixing an **explicit list of findings** on the Valstara pre-launch branch named below — nothing more. Read `AGENTS.md` first: it and every hard rule from the implementation prompt (`docs/engineering/prompts/01-implement-ticket.md`) remain binding.

## Inputs
*(ticket entries live in `docs/plan/development-plan.md` — read the relevant one before fixing)*

- **Ticket ID and title:** {TICKET_ID} — {TICKET_TITLE}
- **Epic:** {EPIC}
- **Branch:** {BRANCH}
- **Source of the findings:** {SOURCE}  *(for example "Pre-PR review round 2" or "QA gate 7, run 1")*
- **Founder decisions that apply (or "None"):** {DECISIONS}
- **Findings to address, verbatim from the report, with their IDs:**

{FINDINGS}

**A QA-fix branch** has a gate ID (`GATE-<n>`) in place of a ticket ID. Its findings come from the integrated QA report, and each may name the ticket that owns the code. Read that ticket's plan entry for each finding, and plan §6 for the gate. "The ticket's acceptance criteria" below means those tickets' criteria.

## Rules

1. **Fix exactly these findings.** No unrelated changes, no opportunistic refactors, no dependency changes unless a finding requires one — and then note it, **including what it loads in the browser.**
2. **Never fix by weakening a gate.** Do not delete, skip or loosen a test, lower a coverage bar, disable a lint rule, or widen a scanner allowlist to make a finding pass. **Dependency vulnerabilities are fixed by upgrade**, or allowlisted **with written justification and an expiry date** — never silently. **Never add an entry to the cookie/storage allowlist to make the privacy gate pass** — that gate exists precisely to stop that.
3. **Every fix gets proof.** For a behavioural finding, add or strengthen a test that **fails before the fix and passes after** — state which test and how you know it failed before (run it against the pre-fix code, or revert-check). For a doc-drift finding, the proof is the corrected text. **For a "cannot verify" finding, the fix is making it verifiable** — a test or a reproducible command — not an assertion that it is fine.
4. **Dispute path.** If you believe a finding is factually wrong, **do not code around it.** Mark it **DISPUTED** with reason `factually-wrong` and concrete evidence (file:line, doc quote, command output), and leave the code unchanged. Where the docs do not settle the right fix, mark it **NEEDS-DECISION** with the options and your recommendation — stop-and-ask applies here too.
5. **Non-blocking findings are fixed when they are worth fixing.** Fix every one that is a real defect, a real risk or an untrue doc, inside this ticket's scope. Mark a non-blocking finding **DISPUTED** instead when it belongs to another ticket (reason `out-of-scope`, naming the owner) or when fixing it adds no real value — style, taste, naming (reason `no-value`, one line why). Never dispute a **blocker** as `no-value`.
6. **Re-read the doc section each finding cites before fixing it.** Fix to the documented rule, not to the reviewer's paraphrase.
7. **A finding that is actually a plan defect is not yours to fix.** If the correct fix would require changing a ticket's scope, interfaces or acceptance criteria, mark it **NEEDS-DECISION** — **the plan changes only with founder authorisation.**
8. **A finding that is blocked on a founder prerequisite is NEEDS-DECISION**, never a placeholder.
9. **Do not build another ticket's work to close a finding.** If a fix seems to require it, check standing rule 19 first: a constraint belonging to a structure **this** ticket creates is this ticket's, and building it is correct. Anything genuinely owned elsewhere is **NEEDS-DECISION**.
10. **Do not add tests, fixtures or styles the ticket did not ask for.** The Tests line is the contract. Converting working example tests to generated or property-based ones is not a fix, and it creates new surface for the next review.
11. **Founder decisions above are binding.** Apply them exactly. Do not edit the plan or `docs/plan/ticket-register.md`.

## Self-review before you declare done — mandatory

**This is the step that stops the loop.** A fix that closes one blocker and opens another costs a full cycle, and you are the cheapest place to catch it.

When every finding is addressed, **re-review your own diff as an independent reviewer would**, using the three blocker grounds in `docs/engineering/prompts/02-pre-pr-review.md`:

1. **Re-read the ticket's acceptance criteria in full** — not just the ones the findings touched. Confirm your changes did not break one that previously passed.
2. **Re-read the ticket's Tests line.** Every named test still present and still meaningful.
3. **Diff your own diff.** For everything you added: is it inside this ticket's scope? Did you introduce a file, migration, dependency, role, service or config another ticket owns? Did you add a test the ticket did not ask for?
4. **Mutate one behaviour you changed** and confirm a test catches it. Undo the mutation.
5. **Check the standing rules your change now touches** — especially rule 19 (constraints ship with their structure) and rule 20 (self-contained).

**If this pass finds a new problem, fix it now and run the pass again.** Do not hand it forward. Report what the pass found under `Self-review` below — including "nothing", which is a real result worth stating.

## Verify

- Confirm you are on the branch (`git branch --show-current`). Do not pull, merge, rebase or push.
- Re-run the **specific check each finding names** — the failing test, the query, the command.
- Then the quick local gate:
  ```
  docker compose -f infra/compose/docker-compose.yml up -d
  npm run check
  npm run test:changed -- <the ticket's Tests-line files and each finding's test>
  ```
  `test:changed` also picks every test the fixes affect, and adds the privacy and accessibility suites when a fix can reach the browser. The full suite runs in CI on the pull request (`docs/engineering/ci-cd.md#local-checks`), so do not run it locally, even for a dependency upgrade.
- Schema touched? Add a **new forward-only migration** — never edit one that has already run.
- Commit on that branch with Conventional Commits referencing the ticket ID, and leave the working tree clean (`git status --short` prints nothing).

## Output exactly this

```
# Fix-and-verify — <source> — <ticket ID>
| ID | Finding (short) | Status | Fix (files) | Proof (test/command + failed-before evidence) |
|----|-----------------|--------|-------------|-----------------------------------------------|
| R1-B1 | ...          | FIXED / DISPUTED / NEEDS-DECISION | ... | ... |

## Disputes and decisions needed (or "None")
- <finding ID>: DISPUTED (<reason>) — <evidence>
- <finding ID>: NEEDS-DECISION — <question, options, your recommendation>

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

**Every finding from the input list must appear in the table, by its ID — none may be silently dropped.** Keep each table cell to one line, with no `|` character inside it; put detail in the sections below the table.

**Then end your output with this result block, and nothing after it.** It is read by a program: valid JSON, these keys, no comments. Use `[]` for an empty list and `null` for an unknown value.

````
```orchestrator-result
{
  "prompt": "04-fix-and-verify",
  "ticket_id": "<ticket ID>",
  "branch": "<branch>",
  "source": "<source>",
  "head_sha": "<full SHA of HEAD after your last commit>",
  "uncommitted_changes": false,
  "rows": [
    {
      "finding_id": "R1-B1",
      "kind": "blocker | non_blocking | qa_blocker | qa_other",
      "status": "FIXED | DISPUTED | NEEDS-DECISION",
      "dispute_reason": "factually-wrong | out-of-scope | no-value | null",
      "files": ["<path>"],
      "proof": "<test or command, and how you know it failed before>"
    }
  ],
  "questions": [
    {
      "id": "Q1",
      "finding_id": "R1-B2",
      "question": "<the decision needed>",
      "options": ["A: <option>", "B: <option>"],
      "recommendation": "<A or B — one-line reason>"
    }
  ],
  "changed_beyond_findings": false,
  "local_checks": "pass | fail",
  "summary": "<one or two plain sentences: what was fixed, disputed or needs a decision>"
}
```
````

`changed_beyond_findings` is `true` when the self-review made you change behaviour that no finding named. `local_checks` is `fail` if any check in Verify still fails; say which under Deviations.
