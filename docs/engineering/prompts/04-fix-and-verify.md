# Fix-and-Verify Prompt

Run after a pre-PR review returned FAIL or an integrated QA returned findings. The implementation session is fine for review findings; a fresh session on the branch is fine too. Model: the original ticket's model — **bump one step if this is the second attempt.**

---

You are fixing an **explicit list of findings** on the Valstara pre-launch branch named below — nothing more. `AGENTS.md` and every hard rule from the implementation prompt remain binding.

## Inputs

- **Branch:** {BRANCH}
- **Ticket ID and title:** {TICKET_ID} — {TICKET_TITLE}   *(entries live in `docs/plan/development-plan.md` — read the relevant one before fixing)*
- **Epic:** {EPIC}
- **Source:** {SOURCE}   *(pre-PR review | integrated QA gate N)*
- **Findings to address, verbatim from the report:**

{FINDINGS}

## Rules

1. **Fix exactly these findings.** No unrelated changes, no opportunistic refactors, no dependency changes unless a finding requires one — and then note it, **including what it loads in the browser.**
2. **Never fix by weakening a gate.** Do not delete, skip or loosen a test, lower a coverage bar, disable a lint rule, or widen a scanner allowlist to make a finding pass. **Dependency vulnerabilities are fixed by upgrade**, or allowlisted **with written justification and an expiry date** — never silently. **Never add an entry to the cookie/storage allowlist to make the privacy gate pass** — that gate exists precisely to stop that.
3. **Every fix gets proof.** For a behavioural finding, add or strengthen a test that **fails before the fix and passes after** — state which test and how you know it failed before (run it against the pre-fix code, or revert-check). For a doc-drift finding, the proof is the corrected text. **For a "cannot verify" finding, the fix is making it verifiable** — a test or a reproducible command — not an assertion that it is fine.
4. **Dispute path.** If you believe a finding is factually wrong, **do not code around it.** Mark it **DISPUTED** with concrete evidence (file:line, doc quote, command output) and leave the code unchanged. Where the docs do not settle the right fix, mark it **NEEDS-DECISION** with the options — stop-and-ask applies here too.
5. **Re-read the doc section each finding cites before fixing it.** Fix to the documented rule, not to the reviewer's paraphrase.
6. **A finding that is actually a plan defect is not yours to fix.** If the correct fix would require changing a ticket's scope, interfaces or acceptance criteria, mark it **NEEDS-DECISION** — **the plan changes only with founder authorisation.**
7. **A finding that is blocked on a founder prerequisite is NEEDS-DECISION**, never a placeholder.

## Verify

- Re-run the **specific check each finding names** — the failing test, the query, the command.
- Then the full local gate:
  ```
  docker compose -f infra/compose/docker-compose.yml up -d
  npm run lint && npm run typecheck && npm test && npm run build
  npm run test:privacy && npm run test:a11y
  ```
- Schema touched? Add a **new forward-only migration** — never edit one that has already run.
- Commit on that branch with Conventional Commits referencing the ticket ID.

## Output exactly this

```
# Fix-and-verify — <source> — <ticket ID>
| # | Finding (short) | Status | Fix (files) | Proof (test/command + failed-before evidence) |
|---|-----------------|--------|-------------|-----------------------------------------------|
| 1 | ...             | FIXED / DISPUTED / NEEDS-DECISION | ... | ... |

## Commands run + results
## Privacy impact of these fixes (or "None")
## Deviations & uncertainty (or "None")
```

**Every finding from the input list must appear in the table — none may be silently dropped.**

After review-sourced fixes: the branch is ready for push and PR **once every row is FIXED** — DISPUTED and NEEDS-DECISION rows go back to the founder first. After QA-sourced fixes: **the QA blocker list must be re-verified clear before the next epic opens.**
