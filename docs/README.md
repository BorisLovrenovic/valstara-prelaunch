# Valstara Pre-Launch — Documentation Set

This repository builds **one thing**: the Valstara pre-launch waitlist site, live on `valstara.com` for the 8–12 weeks before the store opens. It is a separate codebase from the storefront by decision (ADR-002), and it is deliberately temporary — except for the trust and legal pages, which are written here at their permanent URLs and ported into the storefront at launch.

**The single source of truth for what gets built is [`plan/development-plan.md`](plan/development-plan.md).** Everything else in this set is an *input* that plan references. When they disagree, the plan wins and the disagreement is a defect to be fixed in the plan.

---

## Source documents

| Document | Role |
|---|---|
| `prelaunch-stack-decisions.md` (v2, 25 Aug 2026) | The founder's stack and campaign decisions. Every ADR here records one of them or derives from one; none re-litigate them |
| `valstara-locked-tech-decisions.md` | Main-store decisions. Out of scope here except where the handoff touches them |
| [`brand/identity-guidelines.md`](brand/identity-guidelines.md) | **In this repository.** Palette (§5), type scale (§6), voice and never-use vocabulary (§3), the Triple Guarantee (§2), UI anti-patterns (§7.3). LOCKED sections are binding; `brand/tokens.md` and `brand/copy-rules.md` transcribe them, they do not invent them |

> **The folder `example development plan and prompts/` is reference material from a different project.** Nothing in it is a decision for this campaign. Do not cite it, do not inherit its features, its ADR numbers, its flags or its vocabulary.

## Reading order for a new agent

1. `plan/development-plan.md` — §0 governance, §4 standing rules, then your ticket
2. `architecture/overview.md` — what this system is and the five flows it runs
3. `architecture/modules.md` — the code boundaries and repository layout
4. `data/model.md` — the schema, and the handoff shape it is designed against
5. The ADRs on your ticket's **Docs** line
6. `AGENTS.md` at the repository root — binding, always

## Map

```
AGENTS.md                          binding rules for coding agents
docs/
  README.md                        this file
  prelaunch-stack-decisions.md     the founder's decisions (source)
  plan/development-plan.md         ★ the single source of truth for scope
  architecture/
    overview.md                    principles, context, the five runtime flows
    modules.md                     code boundaries, repository layout, dependency direction
    fallbacks.md                   degradation and failure matrix — every row testable
    adr/                           27 decision records (26 accepted, 1 superseded) + template
  features/
    README.md                      flag registry, cross-cutting acceptance criteria, cut list
    *.md                           one spec per feature
  modules/*.md                     one detail file per server module
  data/model.md                    schema, retention, and the launch-day handoff contract
  api/README.md                    route surface, error envelope, closed code set
  brand/
    tokens.md                      the portable token contract (ADR-015)
    copy-rules.md                  enforceable copy rules — CI-scanned
  engineering/
    standards.md                   coding standards
    git-workflow.md                branches, commits, PRs, releases
    ci-cd.md                       pipelines, deploy, rollback, backups
    prompts/                       ★ the six agent prompts
  security/threat-model.md         threats, CI security gates, secret handling
  legal/compliance.md              GDPR, ePrivacy, the global giveaway under Hong Kong law, Article 27
  testing/strategy.md              test tiers, invariants, definition of done
  testing/e11-01-load-report.md     E11-01 script, bounded-query inventory and local result
  ops/
    runbook.md                     by symptom
    launch-cutover.md              the host swap and the trust-page port
  prerequisites/
    founder-prerequisites.md       what the founder must supply, with instructions
    p4-rules-page-draft.md         the founder-approved text E7-02 publishes at /giveaway/rules
    p4-research-brief.md           the P4 research prompt (historical — superseded by ADR-026)
```

## What this site is not

Named here so no ticket scaffolds it. **None of these is deferred — each is a decision not to build**: a storefront, a cart, a payment path, user accounts with passwords, a CMS, an i18n framework, a consent banner, device fingerprinting, SMS, a mobile app, or any hosted waitlist SaaS integration (ADR-020).
