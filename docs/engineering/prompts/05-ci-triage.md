You are diagnosing and **minimally** fixing a CI failure for the Valstara pre-launch site. Read `AGENTS.md` first; it is binding. The pipelines are defined in `docs/engineering/ci-cd.md`. **The gates exist to catch defects — your job is to satisfy them, never to get around them.**

## Inputs

- **Ticket ID and title:** {TICKET_ID} — {TICKET_TITLE}
- **Epic:** {EPIC}
- **Branch:** {BRANCH}
- **Pipeline:** {PIPELINE}  *("PR" or "main post-merge")*
- **Failure log / run reference:**

{FAILURE_LOG}

The branch is already checked out in this working directory. Confirm it with `git branch --show-current`. Do not pull, rebase, push or open anything; commit your fix locally.

## Step 1 — Identify the failing stage

**PR pipeline:** install → lint → typecheck → tests against a disposable PostgreSQL, run under coverage in four `test (n/4)` shards → **build** → coverage gate on the merged shard reports, which also proves every test file ran exactly once → `red-paths` → **security and privacy gates** (secret scan · dependency scan with an expiring allowlist · cookie and storage rule · fingerprinting rule · third-party request rule · vendor-boundary rule · forbidden-copy scan · inline-prose scan) → **migration check** (ledger checksums and schema reproducibility) → **accessibility pass**.

**Main pipeline adds:** image build and GHCR push (path-filtered). It does not deploy.

**Several gates are build-time assertions**, so a "build" failure may actually be a metadata, frontmatter or placeholder assertion firing. Read the message before assuming it is a compile error. ADR-029 removed the representative-name assertion.

## Step 2 — Reproduce locally, before changing anything

Reproduce the failing check only, not the whole suite (`docs/engineering/ci-cd.md#local-checks`):

```
docker compose -f infra/compose/docker-compose.yml up -d
npm ci                                                       # only if package-lock.json changed on this branch
COVERAGE_SOURCE_MAPS=1 npm test -- <the failing test file>   # a test (n/4) failure
npm run check                                                # lint, format, typecheck, security or build
```

For a `coverage` failure, rerun the gate on CI's own shard reports: `gh run download <run-id> -p 'coverage-shard-*' -D coverage-shards`, then `node scripts/ci/merge-coverage.mjs coverage-shards && node scripts/ci/changed-coverage.mjs`. A `red-paths` failure reproduces with `npm run ci:red-paths`.

Migration check → run the migrations into an empty database and compare. Security scans → run the scanner locally if available, otherwise reason strictly from the CI log.

## Step 3 — Classify the root cause — exactly one primary class

- **(a) Real defect** in the change → fix the code, **and if no test caught it locally, add the test that would have.**
- **(b) Flaky or nondeterministic test** — passes on rerun, timing- or order-dependent, real-network dependence, `Date.now()` in a time-dependent path → **fix the nondeterminism** (injected clock, proper awaits, recorded fixtures). If it cannot be fixed now, quarantine **explicitly with a follow-up in the output** — never delete, never blind-retry as the "fix". **Exception:** a flake in a test file this branch neither changes nor reaches, which passes locally, is not this ticket's to fix. Report status `RERUN` with the evidence and a follow-up naming the test.
- **(c) Drift** — stale lockfile, a hand-edited migration where a new one belongs, a generated artifact edited by hand, a flag missing from the registry, migration ordering violating additive-first → **regenerate from the source of truth** and restore the additive order.
- **(d) Gate correctly firing** — a cookie or storage write, a fingerprinting call, a third-party request, an email SDK outside its provider module, a forbidden copy string, a leaked secret, a placeholder where a founder input belongs, a high or critical dependency vulnerability, coverage below bar, an accessibility violation → **the code is wrong, not the gate.** Fix the violation.
  - **A cookie, storage, fingerprinting or third-party finding is never fixed by allowlisting.** That gate is what makes the site's no-banner position defensible; widening it is a decision with legal consequences, not a CI fix. **Report NEEDS-DECISION.**
  - **A leaked secret additionally means rotate it — flag this to the founder immediately — and purge it.** Committing over it is not remediation.
  - **A placeholder assertion firing means a founder prerequisite is outstanding.** Report it; do not invent the value.
  - Vulnerabilities: upgrade, or allowlist only with justification and expiry.
- **(e) Infrastructure** — runner, cache, registry or the production host → describe the operational fix, apply what is possible from the repository, and **do not re-run your way past a broken environment without saying so.** A runner fault with no code change needed is status `RERUN`.

## Hard rules

**Never**: skip or disable a failing test to merge · lower a coverage threshold · disable a lint or security rule · **add an entry to the cookie/storage allowlist** · edit a migration that has already run · widen an allowlist without justification and expiry. **If the fix would require any of these, stop and report NEEDS-DECISION instead.**

Keep the fix **minimal — this is triage, not an improvement pass.** If the log is insufficient to classify confidently, say so and list exactly what you need (status `NEED-INFO`).

**One pre-launch-specific caution:** from the first live Resend key onward, **production carries a real domain reputation.** A failure in anything touching email, or a change that could cause a duplicate or unintended send, is not an ordinary CI failure — say explicitly whether any mail could have gone out as a result before proposing a forward fix.

**Commit the fix** on the branch with a Conventional Commit referencing the ticket ID, re-run the reproduction to prove it, and leave the working tree clean.

## Output exactly this

```
# CI triage — <ticket ID> <ticket title> / <branch> / <pipeline>
STAGE FAILED: <stage>
ROOT CAUSE: <class a–e> — <evidence from log + local reproduction>
MAIL RISK: yes/no — <could any unintended or duplicate email have been sent?>
FIX: <files changed + one-line rationale>   (or NEEDS-DECISION: <why>, or RERUN: <why no code change is needed>)
PROOF: <local commands re-run + results>
FOLLOW-UPS: <quarantined flake, secret rotation, founder prerequisite, host ops, or "None">
```

**Then end your output with this result block, and nothing after it.** It is read by a program: valid JSON, these keys, no comments. Use `[]` for an empty list and `null` for an unknown value.

````
```orchestrator-result
{
  "prompt": "05-ci-triage",
  "ticket_id": "<ticket ID>",
  "branch": "<branch>",
  "pipeline": "PR | main post-merge",
  "stage": "<failed stage or job name>",
  "root_cause_class": "a | b | c | d | e",
  "mail_risk": false,
  "secret_leak": false,
  "status": "FIXED | RERUN | NEEDS-DECISION | NEED-INFO",
  "head_sha": "<full SHA of HEAD after your commit>",
  "files_changed": ["<path>"],
  "changed_outside_test_and_docs": false,
  "questions": [
    {
      "id": "Q1",
      "question": "<the decision needed>",
      "options": ["A: <option>", "B: <option>"],
      "recommendation": "<A or B — one-line reason>"
    }
  ],
  "follow_ups": ["<follow-up>"],
  "summary": "<one or two plain sentences: what failed and what you did>"
}
```
````

`changed_outside_test_and_docs` is `true` when any file you changed is outside `test/` and `docs/`; that sends the branch back to a scoped pre-PR review before it is pushed again.
