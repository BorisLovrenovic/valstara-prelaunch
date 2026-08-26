# Valstara Pre-Launch — Agent Prompts: Usage Guide

Six reusable prompts for running a coding agent through this repository's workflow. Every prompt assumes the agent runs **at the repository root**, where `AGENTS.md` and `docs/` are the ground truth. Fill the input block at the **top** of the prompt, paste, run — every placeholder lives in that one block and the rest of the prompt refers back to it.

## How tickets reach the agent

You supply **the ticket ID and title** (both, always — the title pairs correctly even if an ID shifts) and the agent reads the ticket itself from **`docs/plan/development-plan.md`**, which is the single source of truth.

Two consequences worth internalising:

- **The plan file is the only ticket source.** There is no board and no import. If a ticket changes, **you change it in the plan first, with your authorisation** — anything not yet written there goes in the ticket-notes field, or the agent implements the stale version.
- **The agent is a check on the plan.** Because it reads the whole plan, prompts 01 and 02 require it to stop and ask when a ticket contradicts its epic's goal, the standing rules, what earlier tickets built, or what later tickets assume. **Treat a `BLOCKED:` output as the system working** — answer it, update the plan, re-run.

## The per-ticket cycle

| Step | Prompt | Session | Model |
|---|---|---|---|
| 1. Implement | `01-implement-ticket.md` | fresh | the ticket's **Model** line |
| 2. Review | `02-pre-pr-review.md`, `{ROUND}` = 1 | **fresh — must not have seen the implementation** | Tier A High; **Tier B High if the ticket was Tier B or the area is security, privacy, fraud or email** |
| 3. Fix blockers | `04-fix-and-verify.md` (source = the review) | the implementation session, or fresh on the branch | the ticket's model |
| 4. Re-review **only if** step 3 reported a DISPUTED or NEEDS-DECISION row, or changed behaviour beyond the findings | `02-pre-pr-review.md`, `{ROUND}` = 2, with the cleared blockers pasted into `{PRIOR_FINDINGS}` | fresh | as step 2 |
| 5. Push, open PR, squash-merge to `main` | manual | — | — |
| 6. CI failed? | `05-ci-triage.md` | fresh | Tier A Medium |
| 7. Deploy | Deliberate — **merged is not deployed** | — | — |

Then the next ticket. **Tickets are worked in plan order within an epic**, because later tickets assume what earlier ones built.

### The expected shape of a cycle

**Implement → review → PASS → PR → merge.** That is the normal path, not the lucky one. Where a review does return blockers, **one fix-and-verify run should clear them**, because that prompt now ends with a mandatory self-review against the same three blocker grounds the reviewer uses.

**A third round on the same ticket means something is wrong with the ticket, not the agent.** Stop and read the plan entry. That has been the rule from the start; apply it.

### Why the review is scoped

`02-pre-pr-review.md` reviews **one ticket's diff against that ticket's contract** — its acceptance criteria, its Tests line, and the standing rules. It is deliberately **not** a repository audit; `03-integrated-qa.md` is, at the epic gate, at higher effort.

A review that ranges over the whole codebase always finds something true and irrelevant, blocks a finished ticket on it, and never converges. **The blocker bar is three grounds and nothing else** — they are listed in the prompt and in `docs/testing/strategy.md#what-a-reviewer-may-require`. Everything real but outside them is a non-blocking finding or a plan tension.

## The per-epic gate

| Step | Prompt | Session | Model |
|---|---|---|---|
| A. Deep audit | `03-integrated-qa.md` | fresh, on `main` | per the schedule below |
| B. Clear blockers | `04-fix-and-verify.md` (source = the QA report); each fix branch goes through steps 2–6 | fresh | Tier B High for security, privacy or money findings; Tier A High otherwise |
| C. Re-verify | re-run `03-integrated-qa.md` scoped to the blocker list until **GO** | fresh | as A |

**No next epic opens on a NO-GO.** The QA is an audit; the primary safety net is the tests written inside every ticket, which prompt 01 enforces.

## QA gate schedule

| Gate | After | Runs | Models |
|---|---|---|---|
| 1 | E1 | 1 | Tier B |
| 2 | E2 + E3 | 2 | Tier B + second model |
| 3 | E4 + E5 | 2 | Tier B + second model |
| 4 | E6 + E7 | 2 | Tier B + second model |
| 5 | E8 | 2 | Tier B + second model |
| 6 | E9 + E10 | 1 | Tier B |
| 7 | E11 | 2 | Tier B + second model |

**Dual-gate rules, three, no exceptions:** the two runs are **fully independent** — fresh sessions, and neither model ever sees or hears about the other's report · you merge afterward and the deduplicated **union** of blockers gates · **disagreements are settled by evidence from the code and docs, never by which model raised the finding.** What you are buying is a **decorrelated blind spot from a different model family**, not extra capability.

**Gates 2, 3, 4 and 5 are dual because each covers something unrecoverable** — the privacy properties, the fraud invariants, the prize draw, and the sending reputation.

## The founder prerequisites

Five items no agent can complete (`docs/plan/development-plan.md#2-founder-prerequisites--not-agent-tickets`): the DNS and email authentication, the Article 27 appointments, the brand token values and trust-page prose, the giveaway rules text, and the ESP tier upgrades.

**A ticket blocked on one of these must report `BLOCKED:` and stop.** If an agent invents a placeholder colour, a placeholder representative name or placeholder rules text, that is a defect — and in two of those five cases it is one that ships to production and is legally significant.

## Escalation rule

**On a second failed attempt at the same ticket or finding, bump one step** — Tier A Medium → Tier A High → Tier B Medium → Tier B High. If a third attempt fails, that is a signal the ticket is wrong, not the agent: stop and revisit the plan entry.

## What the agent must never do

Edit `docs/plan/development-plan.md` · weaken a test, gate, lint rule or coverage bar to get green · scaffold work belonging to a future ticket · resolve an ambiguity by assumption · invent a value that is a founder input · add a fourth island · introduce anything that sets a cookie, writes a storage identifier, fingerprints, or makes a third-party request.
