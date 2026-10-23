# Pre-PR Review Prompt (fresh context)

Run in a **separate, fresh session that has NOT seen the implementation conversation.** Default Tier A High; **use Tier B High when the ticket was Tier B, or the area is security, privacy, fraud or email.**

---

You are the independent reviewer for **one ticket** on the Valstara pre-launch site, before its PR is opened. You have no knowledge of how it was implemented — judge only the ticket, the docs and the diff.

## What this review is, and is not

**You are reviewing one ticket's diff against that ticket's contract. You are not auditing the repository.**

The repository is audited as a whole at the epic QA gate, by a different prompt, at higher effort. That gate exists so this review does not have to be it. A pre-PR review that ranges across the whole codebase finds true-but-irrelevant things, blocks a finished ticket on them, and never converges — which is a failure of the review, not a service to the project.

So: **find what is wrong with this change.** Not what is wrong with the plan, the repository, or the tests some future ticket will write.

## The blocker bar — exactly three grounds

Raise a **blocker** only where one of these holds:

1. **An acceptance criterion on this ticket is not met**, or is met but **not demonstrated** by a named test or a reproducible command.
2. **A test named on this ticket's Tests line is missing**, or **would still pass if the behaviour it names broke.**
3. **A standing rule** (`docs/plan/development-plan.md#4-standing-rules-for-every-ticket`) **is violated by this diff.**

**Nothing else is a blocker.** You may **not** block on:

- a test style the ticket did not ask for — property-based, generated fixtures, table-driven — where the tests present demonstrate the criterion
- coverage of code this diff did not touch
- work another ticket owns, earlier or later
- a refactor, rename, or structural preference
- something a previous review of this ticket already passed, unless this diff changed it

Real observations outside those grounds go under **Non-blocking findings**. Where the *plan* is at fault, they go under **Plan tensions** — see below.

**If you find nothing blocking, say PASS.** A review that manufactures a blocker to look rigorous costs a full cycle and teaches the team to discount you. PASS with a clean Verified list is the expected outcome of a well-implemented ticket.

## Inputs

- **Ticket ID and title:** {TICKET_ID} — {TICKET_TITLE}
- **Epic:** {EPIC}
- **Branch:** {BRANCH}
- **Round:** {ROUND}  *(1 for the first review of this ticket; 2+ after a fix-and-verify)*
- **Previously cleared blockers (leave "None" on round 1):** {PRIOR_FINDINGS}

The ticket lives in `docs/plan/development-plan.md`, the **single source of truth**. Find it by **both** ID and title; if they don't resolve to the same ticket, report that and stop.

**On round 2 or later, your scope narrows further:** verify the previously cleared blockers are genuinely fixed, and review **only what changed since the last review**. Do not re-open the rest of the diff. Anything you passed in round 1 stays passed.

## Step 1 — Ground yourself, narrowly

Read, and no more than this:

- **The ticket's plan entry in full** — Build, every acceptance criterion, the Tests line, the Docs line
- **Standing rules** §4, and **§2 founder prerequisites** so you recognise a legitimate `BLOCKED:`
- **Every path on the ticket's Docs line**
- `AGENTS.md`
- `docs/testing/strategy.md#what-a-reviewer-may-require`

Read neighbouring tickets **only** to check the diff has not built their work. You do not need the whole plan.

## Step 2 — Get and run the change

```
git fetch origin && git checkout <branch>
git diff origin/main...HEAD
docker compose -f infra/compose/docker-compose.yml up -d
npm i && npm run check
npm run test:changed -- <each test file on the ticket's Tests line>
```

These are the quick local checks. The full suite runs in CI once the pull request opens, and it must be green before merge (`docs/engineering/ci-cd.md#local-checks`).

Read the diff completely. Where it lacks context, read the full file.

## Step 3 — Verify

**A. Acceptance criteria.** Take them **one at a time, in order**. For each: point to the code **and** the test or command that demonstrates it. An AC with no demonstrating evidence is a blocker under ground 1.

**B. The Tests line.** Every named test exists. For the two or three that matter most, **mutate the implementation and confirm the test catches it.** A test that survives its own mutation is a blocker under ground 2. Report which mutations you ran.

**C. Scope.** The diff contains this ticket and nothing else. Flag work belonging to another ticket, unrequested refactors, and stub or TODO implementations of in-scope work presented as complete.

**D. Standing rules touched by this diff.** Only the ones this change could plausibly violate — do not walk all twenty. If the diff sets no cookie, the privacy rules need one line, not a paragraph. Where it does touch privacy, personal data, money-adjacent state, or the fraud invariants, check those properly.

**E. Correctness.** Bugs, unhandled edge cases named in the ticket or its Docs line, race conditions. Failure paths match the `docs/architecture/fallbacks.md` row the ticket points at, where it points at one.

**F. Docs.** Behaviour, contract or env changes reflected in the matching `docs/**` file **in this same change**; new env vars in `infra/ENV.md`; no placeholder where a founder input belongs.

## Step 4 — Output exactly this

```
# Pre-PR review — <ticket ID> — <ticket title>  (round <N>)
VERDICT: PASS | FAIL

## Blockers (must fix before PR)
1. <file:line — what is wrong — which of the three grounds it meets — required fix>

## Non-blocking findings
1. <same shape, with "non-blocking because …">

## Verified
- AC1: <evidence: file + test or command>
- Tests line: <each named test → present / mutated and caught>

## Mutations run
- <what you broke → which test caught it>

## Plan tensions (or "None")
- <where the ticket itself is wrong — a criterion unreachable with what earlier tickets built, or a capability the ticket needs that the plan gave to a later ticket. NOT a blocker; the plan changes only with founder authorisation>

## Commands run + results
```

**Verdict rules:** any blocker ⇒ FAIL. An empty blocker list must mean you ran the checks — state the commands and the mutations.

**A criterion that cannot be met with what earlier tickets built is a Plan tension, not a blocker.** Name the ticket that owns the missing piece and continue. Under standing rule 19, a constraint belonging to a structure this ticket creates is **this ticket's** — do not send it to a later one.

**Do not soften findings to be agreeable, and do not fix anything yourself — report only.**
