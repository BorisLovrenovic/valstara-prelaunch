# Valstara Pre-Launch — Agent Prompts: Usage Guide

Seven reusable prompts run a coding agent through this repository's workflow, by hand or from the orchestrator. Every prompt assumes the agent runs **at the repository root**, where `AGENTS.md` and `docs/` are the ground truth, and every prompt tells the agent to read `AGENTS.md` first.

**Each prompt file is exactly what is sent.** Replace every `{PLACEHOLDER}` and send the whole file; nothing in it is a note for the person sending it. Session and model guidance lives here, not in the prompts.

**Every prompt ends its output with a result block** — a fenced block tagged `orchestrator-result` holding one JSON object — and nothing after it. A program reads that block to decide the next step. **A missing or invalid result block means "unknown"**, never "pass": the step is retried once in a fresh session, then goes to the founder.

## The prompts

| Prompt | What it does | Session | Model (Opus 5.5) | Placeholders |
|---|---|---|---|---|
| `01-implement-ticket.md` | Implements one ticket | Fresh | The ticket's **Model** line | `{TICKET_ID}` `{TICKET_TITLE}` `{EPIC}` `{NOTES}` — it starts on `main` and creates the branch itself |
| `02-pre-pr-review.md` | Reviews one ticket's diff against its contract | Fresh — **must not have seen the implementation** | High; Extra High when the ticket's Model line is Extra High | `{TICKET_ID}` `{TICKET_TITLE}` `{EPIC}` `{BRANCH}` `{ROUND}` `{PRIOR_FINDINGS}` |
| `03-integrated-qa.md` | Audits a group of epics at a QA gate | Fresh, on `main` | Per plan §6 | `{GATE_ID}` `{EPICS}` `{TICKET_LIST}` `{RUN}` `{PRIOR_BLOCKERS}` `{FOCUS_NOTES}` |
| `04-fix-and-verify.md` | Fixes an explicit list of findings | Fresh, on the branch | The ticket's Model line (High for a gate) | `{TICKET_ID}` `{TICKET_TITLE}` `{EPIC}` `{BRANCH}` `{SOURCE}` `{DECISIONS}` `{FINDINGS}` |
| `05-ci-triage.md` | Diagnoses and fixes a CI failure — **the only prompt for CI failures** | Fresh, on the branch | Medium | `{TICKET_ID}` `{TICKET_TITLE}` `{EPIC}` `{BRANCH}` `{PIPELINE}` `{FAILURE_LOG}` |
| `06-decision.md` | Recommends a decision, explains it, and records it once accepted | Fresh; **resumed** for every founder reply on that decision | High | `{DECISION_ID}` `{TICKET_ID}` `{TICKET_TITLE}` `{EPIC}` `{BRANCH}` `{SOURCE_STEP}` `{QUESTIONS}` `{SOURCE_REPORT}` `{PRIOR_DECISIONS}` |
| `07-pre-push-checks.md` | Runs the relevant local checks, fixes failures, marks the ticket done, writes the PR body | **The same session** that made the last change on the branch | That session's model | `{TICKET_ID}` `{TICKET_TITLE}` `{BRANCH}` `{PUSH_AND_PR}` `{PR_BODY_FILE}` |

**Where the values come from:**

- `{TICKET_ID}`, `{TICKET_TITLE}` and `{EPIC}` — the ticket's row in `docs/plan/ticket-register.md`, which matches its plan heading exactly. Supply both ID and title, always: the title pairs correctly even if an ID shifts.
- `{BRANCH}` — `feat/<ticket ID>-<slug>`, where the slug is the title in lowercase ASCII words joined by hyphens, cut at a word boundary to at most 50 characters (for example `feat/E11.5-11r-final-design-member-page-and-leaderboard`). **`01` creates the branch itself**, from `main`, by this rule, and reports its exact name in its result block; every later step receives that name. A QA-fix branch is `fix/qa-gate-<n>-run-<run>`.
- `{NOTES}` and `{DECISIONS}` — the accepted decisions since the plan entry was written, or "None".
- `{PRIOR_FINDINGS}` — the previous fix-and-verify (or CI triage) report, verbatim, including its result block; "None" on round 1.
- `{FINDINGS}` — the findings to fix, verbatim from the report, with their IDs.
- `{PR_BODY_FILE}` — a path outside the tracked tree. The orchestrator uses its own log folder; in a manual run, `pr-<ticket ID>.md` at the repository root is git-ignored.
- `{PUSH_AND_PR}` — "no" under the orchestrator, which pushes after the founder approves; "yes" in a manual run.

## How tickets reach the agent

**The plan file is the only source of what a ticket builds**, and **the register is the only source of what runs next.** There is no board and no import. If a ticket changes, **it changes in the plan first, with founder authorisation** — anything not yet written there goes in the Notes field, or the agent implements the stale version.

**The agent is a check on the plan.** Because it reads the whole plan, prompt 01 requires it to stop and ask when a ticket contradicts its epic's goal, the standing rules, what earlier tickets built, or what later tickets assume. **Treat a `BLOCKED:` output as the system working** — decide it, record it, re-run.

## The per-ticket cycle

1. **Pick.** Start only from a clean `main` equal to `origin/main`. Take the first `todo` row in `docs/plan/ticket-register.md`. A `manual` row stops automation: the founder runs it. A gate row runs the QA procedure below.
2. **Implement** — `01`. `DONE` → step 3. `PARTIAL` → the founder decides whether to fix forward (`04` with the unmet criteria as findings) or review as is. `BLOCKED` → a decision (below), then `01` again in a fresh session with the decisions in `{NOTES}`.
3. **Review** — `02`, round 1. Then the review loop below.
4. **Pre-push checks** — `07`, in the same session as the last change. `READY` → step 5. `NEEDS-DECISION` → a decision. `FAILED` → the founder.
5. **Push and open the pull request** — after the founder approves: `git push -u origin <branch>` (never `--force`) and `gh pr create --base main --head <branch> --title "<title>" --body-file <file>`.
6. **CI.** Green → step 7. Red → the CI procedure below. **A docs-only pull request runs no checks**, because `pr.yml` ignores `docs/**`; zero checks counts as green.
7. **Merge** — after the founder approves: `gh pr merge <number> --squash`. Squash only (`docs/engineering/git-workflow.md#merge-policy`).
8. **Clean up**, once `gh pr view <number>` reports `MERGED`:
   ```
   git checkout main && git pull --ff-only origin main && git fetch --prune && git branch -D <branch> && git status
   ```
   `-D` is needed because a squash merge never makes the branch an ancestor of `main`; that is why it runs only after the pull request reports `MERGED`.
9. Next row.

**Merged is not deployed.** Deploying is a deliberate founder command (`docs/engineering/git-workflow.md#deploy-triggering--merged-is-not-deployed`).

## The review loop and its cap (founder-authorised 2026-11-11)

After review round `r`:

| The review found | Next step |
|---|---|
| **Blockers** (`FAIL`), and `r` is 1, 2 or 3 | `04` with **every** blocker and non-blocking finding → review round `r + 1`, with the fix report in `{PRIOR_FINDINGS}` |
| **Blockers** (`FAIL`), and `r` is 4 | **Stop.** A decision on how this ticket moves forward. Never push |
| **No blockers** (`PASS`) and non-blocking findings | `04` with the non-blocking findings → pre-push checks (`07`). No further review |
| **No blockers and nothing else** | Pre-push checks (`07`) |

So a ticket gets at most four reviews; a fourth runs only when the third still found blockers; and **nothing is pushed while a blocker stands.** Fixes that address only non-blocking findings are not reviewed again — that is what keeps the loop finite.

**How fix rows are handled:**

- `FIXED` — verified by the next review, if there is one.
- `DISPUTED` blocker — the next review judges the evidence, and either accepts the dispute or raises the finding again.
- `DISPUTED` non-blocking finding (`out-of-scope`, `no-value` or `factually-wrong`) — logged with its reason; it does not hold the ticket.
- `NEEDS-DECISION` — a decision, then `04` again for those rows only, with the decision in `{DECISIONS}`, before the loop continues.
- A fix run that reports `changed_beyond_findings` after a non-blocking-only fix — the founder chooses between another review round and the pre-push checks.

**Plan tensions** from a review do not block. The founder sees them with the review summary and may open a decision on one.

**Why the review is scoped.** `02-pre-pr-review.md` reviews **one ticket's diff against that ticket's contract** — its acceptance criteria, its Tests line, and the standing rules. It is deliberately **not** a repository audit; `03-integrated-qa.md` is, at the QA gate. A review that ranges over the whole codebase always finds something true and irrelevant, blocks a finished ticket on it, and never converges. **The blocker bar is three grounds and nothing else** (`docs/testing/strategy.md#what-a-reviewer-may-require`), and a non-blocking finding must be worth fixing.

## CI failures

**Every CI failure goes to `05-ci-triage.md`, and to no other prompt.** Pass the failed jobs' log (`gh run view <run-id> --log-failed`) as `{FAILURE_LOG}`.

| Triage status | Next step |
|---|---|
| `FIXED`, and `changed_outside_test_and_docs` is `true` | A review scoped to the fix (`02`, the next round number, the triage report as `{PRIOR_FINDINGS}`; it counts toward the four-review cap), then push |
| `FIXED`, and only `test/` or `docs/` changed | Push; CI runs again |
| `RERUN` | Re-run the failed jobs once (`gh run rerun <run-id> --failed`) |
| `NEEDS-DECISION` or `NEED-INFO` | A decision, or the founder |

**At most three triage runs per ticket**, then the founder. **`mail_risk` or `secret_leak` true pauses everything and alerts the founder at once.** Pushing a fix to an open pull request is a normal push — never `--force`.

## Decisions

A decision opens whenever a step cannot continue on its own: an implementation `BLOCKED`, a `NEEDS-DECISION` from fix-and-verify, CI triage or the pre-push checks, questions in a `DONE` implementation, four failing reviews, a merge conflict that cannot be resolved with certainty, or a QA plan defect.

1. **Recommend** — `06` in a fresh session, with the stopped step's questions and full report, and the earlier decisions that bear on it. Each question gets its own thread with the founder; all of a stop's questions share one decision session.
2. **Discuss** — every founder reply resumes **that same session**, with a header that names the question: `FOUNDER REPLY (Q<n>)`, `EXPLAIN SIMPLY (Q<n>)`, `FOUNDER ACCEPTED (Q<n>)` or `FOUNDER REJECTED (Q<n>)`.
3. **Record** — once every question is accepted, the same session records the decision (below).
4. **Continue** — the stopped step runs again in a **fresh** session, with the decisions in `{NOTES}` (for `01`) or `{DECISIONS}` (for `04`).

**The rule for recording a decision (founder-authorised 2026-11-11).** A decision that changes what gets built — a ticket's scope, behaviour, interfaces, acceptance criteria, Tests line or order, or a named test rewrite — is written into the ticket's plan entry as a `**Founder decisions (YYYY-MM-DD):**` block, in the founder's accepted wording, by the decision session, in one commit `docs(plan): record the <ticket ID> founder decisions [<ticket ID>]` on the ticket branch, **after the founder accepts and before any work builds on it.** A decision that only steers one run — accepting a dispute, resolving a conflict, re-running a job — changes no file and lives in the decision log. **No other session edits the plan**, and no session edits the register except the pre-push step marking its own ticket done.

## QA gates

The gates, their scope and their models are in plan §6, the single source; a gate row in the register marks where each runs. **Each gate runs once per run, on one model — there are no dual gates** (founder decision 2026-11-11).

1. **Audit** — `03`, run 1, fresh, on `main`. `{TICKET_LIST}` is every ticket row between the previous gate row and this one.
2. **GO** → a docs-only pull request marks the gate row `done`: `docs(plan): record QA gate <n> GO [GATE-<n>]`. If run 1 wrote tests on `fix/qa-gate-<n>-run-1`, that branch goes through review, pre-push, PR and CI first.
3. **NO-GO** → every blocker, important finding, doc-drift item and remaining test gap goes to `04` on `fix/qa-gate-<n>-run-<run>` (the branch run 1 may already have created), with `GATE-<n>` as the ticket ID, `QA gate <n> — <epics>` as the title and the epics as `{EPIC}`. That branch then runs the per-ticket cycle from step 3: the review loop, pre-push, PR, CI and merge. Plan defects go to a decision.
4. **Re-check** — `03`, run `+1`, with the previous blockers and their fix reports in `{PRIOR_BLOCKERS}`. Repeat until GO; **after three runs, the founder decides.**

**No next epic opens on a NO-GO.** The QA is an audit; the primary safety net is the tests written inside every ticket, which prompt 01 enforces.

## Session failures

A session that crashes, hits a usage limit or returns no valid result block: check `git status` (the tree must be clean, or hold only that step's committed work), stop any test containers it left running, and re-run the step once in a fresh session. A usage limit waits for the reset and the founder's go-ahead. The pre-push step that loses its session runs `07` in a fresh session instead, with the ticket's last fix or implementation report pasted above it.

## Escalation rule

**On a second failed attempt at the same ticket or finding, move one reasoning level up** — Low → Medium → High → Extra High (plan §3). If a third attempt fails, that is a signal the ticket is wrong, not the agent: stop and revisit the plan entry.

## The founder prerequisites

Items no agent can complete are listed in `docs/plan/development-plan.md#2-founder-prerequisites--not-agent-tickets`. **A ticket blocked on one of them reports `BLOCKED:` and stops.** If an agent invents a placeholder colour or placeholder rules text, that is a defect. ADR-029 waived the representative prerequisite and permits visibly marked draft text on `/terms` and `/privacy` only.

## What the agent must never do

Edit `docs/plan/development-plan.md`, except a decision session recording an accepted decision · edit `docs/plan/ticket-register.md`, except the pre-push step marking its own ticket done · push, open or merge a pull request, except the pre-push step in a manual run · force-push or rewrite history · weaken a test, gate, lint rule or coverage bar to get green · scaffold work belonging to a future ticket · resolve an ambiguity by assumption · invent a value that is a founder input · add a fourth island · introduce anything that sets a cookie, writes a storage identifier, fingerprints, or makes a third-party request.
