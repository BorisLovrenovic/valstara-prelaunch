You are diagnosing and **minimally** fixing a CI failure for the Valstara pre-launch site. The pipelines are defined in `docs/engineering/ci-cd.md`. **The gates exist to catch defects — your job is to satisfy them, never to get around them.**

## Inputs

- **Ticket ID and title:** E1-06 — Image build, GHCR push, production Compose behind Cloudflare
- **Epic:** Epic E1 — Foundations
- **Branch:** feat/E1-06-image-ghcr-production-compose
- **Pipeline:** PR *("PR" or "main post-merge")*
- **Failure log / run reference:**

{FAILURE_LOG}

## Step 1 — Identify the failing stage

**PR pipeline:** install → lint → typecheck → tests against a disposable PostgreSQL, run under coverage in four `test (n/4)` shards → **build** → coverage gate on the merged shard reports, which also proves every test file ran exactly once → `red-paths` → **security and privacy gates** (secret scan · dependency scan with an expiring allowlist · cookie and storage rule · fingerprinting rule · third-party request rule · vendor-boundary rule · forbidden-copy scan) → **migration check** (ledger checksums and schema reproducibility) → **accessibility pass**.

**Main pipeline adds:** image build and GHCR push (path-filtered). It does not deploy.

**Several gates are build-time assertions**, so a "build" failure may actually be a metadata, frontmatter or placeholder assertion firing. Read the message before assuming it is a compile error. ADR-029 removed the representative-name assertion.

## Step 2 — Reproduce locally, before changing anything

Reproduce the failing check only, not the whole suite (`docs/engineering/ci-cd.md#local-checks`):

```
docker compose -f infra/compose/docker-compose.yml up -d
npm i
COVERAGE_SOURCE_MAPS=1 npm test -- <the failing test file>   # a test (n/4) failure
npm run check                                                # lint, format, typecheck, security or build
```

For a `coverage` failure, rerun the gate on CI's own shard reports: `gh run download <run-id> -p 'coverage-shard-*' -D coverage-shards`, then `node scripts/ci/merge-coverage.mjs coverage-shards && node scripts/ci/changed-coverage.mjs`. A `red-paths` failure reproduces with `npm run ci:red-paths`.

Migration check → run the migrations into an empty database and compare. Security scans → run the scanner locally if available, otherwise reason strictly from the CI log.

## Step 3 — Classify the root cause — exactly one primary class

- **(a) Real defect** in the change → fix the code, **and if no test caught it locally, add the test that would have.**
- **(b) Flaky or nondeterministic test** — passes on rerun, timing- or order-dependent, real-network dependence, `Date.now()` in a time-dependent path → **fix the nondeterminism** (injected clock, proper awaits, recorded fixtures). If it cannot be fixed now, quarantine **explicitly with a follow-up in the output** — never delete, never blind-retry as the "fix".
- **(c) Drift** — stale lockfile, a hand-edited migration where a new one belongs, a generated artifact edited by hand, a flag missing from the registry, migration ordering violating additive-first → **regenerate from the source of truth** and restore the additive order.
- **(d) Gate correctly firing** — a cookie or storage write, a fingerprinting call, a third-party request, an email SDK outside its provider module, a forbidden copy string, a leaked secret, a placeholder where a founder input belongs, a high or critical dependency vulnerability, coverage below bar, an accessibility violation → **the code is wrong, not the gate.** Fix the violation.
  - **A cookie, storage, fingerprinting or third-party finding is never fixed by allowlisting.** That gate is what makes the site's no-banner position defensible; widening it is a decision with legal consequences, not a CI fix. **Report NEEDS-DECISION.**
  - **A leaked secret additionally means rotate it — flag this to the founder immediately — and purge it.** Committing over it is not remediation.
  - **A placeholder assertion firing means a founder prerequisite is outstanding.** Report it; do not invent the value.
  - Vulnerabilities: upgrade, or allowlist only with justification and expiry.
- **(e) Infrastructure** — runner, cache, registry or the production host → describe the operational fix, apply what is possible from the repository, and **do not re-run your way past a broken environment without saying so.**

## Hard rules

**Never**: skip or disable a failing test to merge · lower a coverage threshold · disable a lint or security rule · **add an entry to the cookie/storage allowlist** · edit a migration that has already run · widen an allowlist without justification and expiry. **If the fix would require any of these, stop and report NEEDS-DECISION instead.**

Keep the fix **minimal — this is triage, not an improvement pass.** If the log is insufficient to classify confidently, say so and list exactly what you need.

**One pre-launch-specific caution:** from the first live Resend key onward, **production carries a real domain reputation.** A failure in anything touching email, or a change that could cause a duplicate or unintended send, is not an ordinary CI failure — say explicitly whether any mail could have gone out as a result before proposing a forward fix.

## Output exactly this

```
# CI triage — <ticket ID> <ticket title> / <branch> / <pipeline>
STAGE FAILED: <stage>
ROOT CAUSE: <class a–e> — <evidence from log + local reproduction>
MAIL RISK: yes/no — <could any unintended or duplicate email have been sent?>
FIX: <files changed + one-line rationale>   (or NEEDS-DECISION: <why>)
PROOF: <local commands re-run + results>
FOLLOW-UPS: <quarantined flake, secret rotation, founder prerequisite, host ops, or "None">
```
