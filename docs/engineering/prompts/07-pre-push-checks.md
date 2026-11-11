The pre-PR review has passed for this ticket. Before the branch is pushed, prove locally that CI will pass, so a red pull request does not cost a round trip. This message goes to **the same session** that made the last change on the branch, so you already know what changed. `AGENTS.md` stays binding.

## Inputs

- **Ticket ID and title:** {TICKET_ID} — {TICKET_TITLE}
- **Branch:** {BRANCH}
- **Push and open the pull request yourself:** {PUSH_AND_PR}  *("no" when the orchestrator pushes after the founder approves; "yes" in a manual run)*
- **Write the pull-request body to:** {PR_BODY_FILE}

## Step 1 — Start from a clean, current branch

```
git branch --show-current     # must print the branch above
git status --short            # must print nothing
git fetch origin
git merge-base --is-ancestor origin/main HEAD && echo current || echo behind
```

- **Uncommitted changes** that belong to this ticket: commit them. Anything that does not belong to the ticket (a scratch file, a screenshot, a PR body) is never committed; leave it out and say so.
- **Behind `main`:** `git merge --no-edit origin/main`. **Never rebase, never force.** If the merge conflicts, resolve it only when every conflicting hunk is mechanical and you are certain both sides' intent survives. Otherwise run `git merge --abort` and stop with `NEEDS-DECISION`, naming each conflicting file and what each side changed. After a merge, everything in Step 2 runs, whatever ran earlier.

## Step 2 — Run the checks that matter for this change

Run what CI will run on this diff, and nothing that cannot be affected by it:

```
docker compose -f infra/compose/docker-compose.yml up -d     # when any selected test needs the stack
npm run check                                                # lint, format, typecheck, security and privacy scans, build
npm run test:changed -- <each Tests-line file, plus every test file this branch added or changed>
```

- `npm run test:changed -- --dry-run <files>` prints what it will run and why. It already selects every test the branch affects, and adds the privacy and accessibility suites whenever the change can reach the browser.
- **Skip a check only when it already passed in this session after the last change to the branch** — say when it ran. A merge from `main` counts as a change.
- **A diff that touches only `docs/**`** runs nothing in CI. Run `npm run format` only.
- **Never run the full `npm test`** (`docs/engineering/ci-cd.md#local-checks`). CI runs it on the pull request.

## Step 3 — Fix what fails, properly

- **Find the root cause before changing anything.** Only production-ready fixes: no quick fixes, no workarounds, no `skip`, no loosened assertion, no widened allowlist, no lowered threshold.
- **Stay inside this ticket's scope.** A failure in a test this branch neither changes nor reaches is not yours to fix when it passes when run alone (`npm test -- <file>`), or fails the same way in the latest CI run on `main` (`gh run list --branch main --limit 3`). Show that evidence and report it as unrelated.
- After a fix, re-run **the check that failed**. If the fix changed source code, also re-run `npm run check`. Repeat until green.
- **Two attempts per failure.** If the same failure survives two honest fixes, stop with `NEEDS-DECISION` and say what you tried.
- Commit each fix: `fix(<scope>): <what> [<ticket ID>]`.

## Step 4 — Mark the ticket done in the register

In `docs/plan/ticket-register.md`, change this ticket's **Status** from `todo` to `done`, and nothing else. It merges with the ticket, so `main` is never ahead of what is built. Commit it: `docs(plan): mark <ticket ID> done in the ticket register [<ticket ID>]`. Skip this step for a QA-fix branch (`GATE-<n>`); the gate is marked done when it reaches GO.

## Step 5 — Write the pull-request body

Write it to the file named above, never into the repository's tracked files. Title on the first line, as the squash commit will read: `<type>(<ticket ID>): <ticket title>`. Then, per `docs/engineering/git-workflow.md#pull-requests`:

- **What was built**, in a few lines
- **Acceptance criteria**, each with the test or command that demonstrates it
- **Tests added**
- **Docs and ADRs updated**
- **New dependencies** with licence and **what each loads in the browser** (or "None")
- **What reaches the browser** (`AGENTS.md`, rule 1 — or "Nothing")
- **Founder decisions** this ticket relies on, with their dates (or "None")
- **Review**: the number of review rounds and the final verdict; disputed findings with the reason
- **Deviations** (or "None")
- **Local checks** from Step 2, with results

## Step 6 — Push and open the pull request (only if the input says "yes")

```
git push -u origin <branch>                 # never --force
gh pr create --base main --head <branch> --title "<title line>" --body-file <the body file>
```

If the input says "no", stop after Step 5: the orchestrator pushes and opens the pull request once the founder approves.

## Output

```
# Pre-push checks — <ticket ID> — <ticket title>
Branch: <branch> · merged main: yes/no · HEAD: <sha>

| Check | Result | Note |
|-------|--------|------|
| npm run check | pass / fail / skipped | <when it ran, or why skipped> |
| npm run test:changed -- … | … | <files selected> |

## Fixes made (or "None")
## Unrelated failures (or "None")
## Pull request: <URL, or "not opened — the orchestrator opens it">
```

**Then end your output with this result block, and nothing after it.** It is read by a program: valid JSON, these keys, no comments. Use `[]` for an empty list and `null` for an unknown value.

````
```orchestrator-result
{
  "prompt": "07-pre-push-checks",
  "ticket_id": "<ticket ID>",
  "branch": "<branch>",
  "status": "READY | PUSHED | FAILED | NEEDS-DECISION",
  "head_sha": "<full SHA of HEAD>",
  "merged_main": false,
  "checks": [
    { "command": "<command>", "result": "pass | fail | skipped", "note": "<one line>" }
  ],
  "fixes": [ { "summary": "<what and why>", "files": ["<path>"] } ],
  "fixes_changed_source": false,
  "unrelated_failures": ["<test file — evidence it is unrelated>"],
  "register_updated": true,
  "pr_title": "<title line>",
  "pr_body_file": "<path>",
  "pr_url": null,
  "questions": [
    {
      "id": "Q1",
      "question": "<the decision needed>",
      "options": ["A: <option>", "B: <option>"],
      "recommendation": "<A or B — one-line reason>"
    }
  ],
  "summary": "<one or two plain sentences>"
}
```
````

- **`READY`** — everything green and committed, body written, not pushed (input "no").
- **`PUSHED`** — as `READY`, and you pushed and opened the pull request (input "yes"); `pr_url` is set.
- **`FAILED`** — a check still fails after two attempts and it is not a decision; say why.
- **`NEEDS-DECISION`** — a merge conflict you could not resolve with certainty, or a failure whose fix needs a choice; `questions` is not empty.
- **`fixes_changed_source`** is `true` when a fix changed any file outside `test/` and `docs/`.
