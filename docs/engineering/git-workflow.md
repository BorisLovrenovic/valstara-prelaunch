# Git and GitHub Workflow

Status: authoritative. Repository: `valstara-prelaunch`, private, **separate from the storefront by decision** (ADR-002).

## Branch model — trunk-based

**One long-lived branch: `main`.** Short-lived ticket branches merge into it and are deleted.

There is no `develop` branch. A `develop` branch protects production from unvetted code and integrates parallel contributors; **this campaign has no live traffic until it opens, and one person working one ticket at a time.** Campaign flags do the job an integration branch would do, and they keep working after the site is live.

| Pattern | From | Purpose |
|---|---|---|
| `main` | — | The trunk. Always green, always deployable |
| `feat/<ticket-id>-<slug>` | `main` | One ticket, e.g. `feat/E3-06-verification-tokens` |
| `fix/<ticket-id>-<slug>` | `main` | A fix ticket |
| `fix/qa-gate-<n>-run-<run>` | `main` | One QA gate run's tests and fixes, e.g. `fix/qa-gate-7-run-1` |
| `data/price-index-YYYY-MM` | `main` | One monthly price-index run's data, e.g. `data/price-index-2026-11` (E11.6-15, `docs/price-index-runbook.md`) |

**One ticket = one branch = one PR.** Branches are deleted on merge. **A monthly price-index run is the one branch that is not a ticket:** it carries only the files the tool writes under `data/price-index/` and `reports/`, never code, configuration or docs. A change those need is a ticket of its own.

## Commits

Conventional Commits, **always including the ticket ID**:

```
feat(referral): server-side ref capture with a signed field [E4-02]
fix(email): re-check suppression at dispatch [E8-01]
docs(adr): record the prize limits in ADR-026 [E7-02]
```

The ticket ID in square brackets is mandatory — it is how work traces back to the plan.

A monthly price-index run traces back to its month instead, as `[PRICE-YYYY-MM]`, with the type `data` and the scope `price-index`:

```
data(price-index): November 2026 run [PRICE-2026-11]
```

Its pull request has the same title. It goes through CI like any other and squash-merges; it has no pre-PR review prompt, because the founder's decisions in it are recorded, with their actor, in `data/price-index/approvals.json` and `manual-overrides.json`.

## Pull requests

- **Squash-merge only.** One ticket becomes one commit on `main`, with the ticket ID in the title.
- **The PR is opened only after the pre-PR review passes and the pre-push checks are green.** Implement → review → pre-push checks → push → PR, deliberately: the reviewer must not have seen the implementation conversation. The cycle, the review cap and the decision procedure are in `docs/engineering/prompts/00-USAGE.md`.
- **PR body carries:** what was built, acceptance criteria met, tests added, docs and ADRs updated, new dependencies with licences, and any deviations.
- **Never merge with a red check.** Never merge without the review having run.

## What never happens to `main`

No direct commits · **no force-push, no history rewrite, ever** · no merge with failing CI · no "temporarily disable the gate to unblock" · no merge of work whose flag is missing or fail-open.

These are procedural rules with one developer. Where GitHub branch protection is available on the repository's plan, configure it to match; **where it is not, the rules are still binding and CI results remain mandatory review evidence.** Record which of the two applies in `infra/ENV.md` rather than treating an unavailable feature as a blocker.

## Merge policy

| Rule | Setting |
|---|---|
| Allowed merge method | **Squash only** — disable merge commits and rebase merging |
| Automatically delete head branches | On |

### Review-gate check names

Reviewed on every non-docs-only PR; they map one-to-one to `docs/engineering/ci-cd.md#pr-pipeline`:

| Check | Responsibility |
|---|---|
| `lint` | Lint and format |
| `typecheck` | TypeScript strict |
| `test (1/8)` … `test (8/8)` | Unit, module-contract and integration tests, run once under coverage and split across eight runners by recorded file timings |
| `build` | The Astro production build |
| `coverage` | Merges the eight shard reports, proves every test file ran exactly once, and applies the changed-code and critical-module coverage gates; fails when any shard fails or any report is missing. Warns, without failing, when the shard plan has gone stale |
| `red-paths` | The E1-04 red-path fixtures for the lint, typecheck, test, build and coverage gates |
| `security` | Secret, dependency, cookie/storage, fingerprinting, third-party request, vendor-boundary and forbidden-copy scans |
| `migration` | Ledger checksums and schema reproducibility; runs as tests inside the `test` shards |
| `a11y` | Automated accessibility pass over the built pages; runs as tests inside the `test` shards |

Adding a gate there means adding it here in the same change.

## Repository bootstrap

**A new repository has no `main`, so the first commit cannot come from a ticket branch.** This is a founder action, done once:

1. Create the private repository.
2. Push an initial commit to `main` containing `docs/` and `AGENTS.md` — the ground truth an agent reads before its first ticket.
3. Configure the merge settings above.
4. Configure repository secrets. **Document each in `infra/ENV.md`; never a value in the repository.**

**Only after `main` exists can E1-01 branch from it.** An agent that finds no `origin/main` **stops and reports** — it never seeds the trunk itself.

## Deploy triggering — merged is not deployed

| Phase | Trigger | Rationale |
|---|---|---|
| **Before the campaign opens** | **Manual.** A merge to `main` builds and pushes an image; deploying is a deliberate command | No visitors exist to protect, and exercising the real host continuously surfaces problems early |
| **From campaign open onward** | **A release tag, cut deliberately** | The site is public, collecting personal data and running a prize draw. An explicit human decision separates *reviewed* from *live* |

**`main` is always deployable; it is not always deployed.**

### Tags and releases
Semantic tags — `v0.x.y` during the build, `v1.0.0` at campaign open. **A tag is never moved or deleted once deployed.** The deploy record (image SHA, migrations applied, timestamp, outcome) is written against the tag.

**Rollback is redeploying the previous release identifier** — one command, its logic drilled locally in E1-07 and **timed against the real host in E12-03**, which is where the five-minute objective is measured. Because migrations are additive-first, the previous image runs against the migrated schema.

## The plan is the source of truth

**No branch, PR or commit changes what gets built.** `docs/plan/development-plan.md` does, and it changes only with founder authorisation. A branch that has drifted from its ticket is a defect in the branch, never a redefinition of the ticket.
