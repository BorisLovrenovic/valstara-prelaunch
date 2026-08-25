# Integrated QA Prompt (per epic gate)

Run in a **fresh session on `main`** after the epics under audit are merged, before anything builds on them. Model: **Tier B Extra High** (Tier B High acceptable for content-only epics). On a **dual gate**, this exact prompt runs a second time, independently, on a model from **a different family**, at high reasoning. This is a deep audit — budget a long run.

---

You are auditing the foundation the Valstara pre-launch campaign is about to build on. The per-ticket reviews already passed; **your job is to find what they could not see** — cross-ticket integration gaps, missing failure paths, privacy and security weaknesses, and drift. **If you cannot verify something, that is a finding.** This gate must fully clear before the next epics start.

Hold one thing in mind throughout: **this campaign has a small number of unrecoverable failures**, and most of them are silent. A leaked list, a destroyed sending reputation, a privacy property broken after data was already collected, an unreproducible draw, a non-idempotent handoff. A per-ticket review cannot see any of those. You can.

## Inputs

- **Epics under audit:** {EPICS}
- **Tickets in scope:** {TICKET_LIST}
- **Extra focus (optional):** {FOCUS_NOTES}

## Step 1 — Ground yourself

Read fully: `docs/plan/development-plan.md` — the sections for these epics closely, the rest for what they must hand forward · every `docs/features/*.md` these epics implement (**their acceptance criteria and edge-case sections are your checklist**) · `docs/architecture/overview.md`, `docs/architecture/modules.md`, and every `docs/architecture/fallbacks.md` row touching what these epics changed · `docs/security/threat-model.md` · `docs/legal/compliance.md` · `docs/testing/strategy.md` · the `docs/modules/*.md` files and ADRs these epics touched · `AGENTS.md`.

## Step 2 — Run everything

```
git checkout main && git pull
docker compose -f infra/compose/docker-compose.yml up -d
npm i && npm run lint && npm run typecheck && npm test && npm run build
npm run test:privacy      # rendered-page cookie, storage, third-party and fingerprinting checks
npm run test:a11y         # axe over the built pages, both themes
```

Record every failure **and every flake — a flake is a finding, not noise.**

## Step 3 — Audit passes (do all seven)

**1. Spec conformance.** For each feature spec in scope, map every acceptance-criterion checkbox and every "Edge cases and error states" bullet to concrete code plus a test. **Unmapped items are findings.**

**2. Integration-gap hunt.** Trace at least three full journeys end to end **across ticket seams**. For example: land with `?ref=` → server-side capture and signing → signup with Turnstile → normalisation → blocklist and MX → subscriber row → referral edge → fraud signals → eligibility stamp → queued verification mail → dispatch → verify → confirm edge → settle cheap reward → **hold high-value reward** → assign wave → accrue entry → survey → welcome mail → leaderboard snapshot. And: bounce webhook → suppression → a queued send stopped at dispatch → unsubscribe from either provider → both suppressed. And: flag raised → reviewed → upheld → disqualified → edges rejected → entries voided → leaderboard excludes → **referred subscribers unaffected**.

Look for **mismatched assumptions between tickets, fields produced but never consumed (or consumed but never produced), and a check present on one path and missing on a parallel path.**

**3. Failure-path audit.** For every relevant fallbacks row: is detection implemented, does the fallback actually engage, does the visitor see the documented copy, is the alert at the documented severity — **and is there a test proving each?** Then invert: enumerate the error states these epics can actually produce and **flag any with no designed fallback in the matrix** — that is doc drift plus a product gap. Confirm the standing properties: **a signup that reached PostgreSQL is safe** · an email failure never blocks a signup · a stopped job makes work late, never lost · **the two silent failures both have working guards.**

**4. Privacy and security audit.** **Privacy first, because it is the property that cannot be repaired retroactively:**
- Enumerate **every rendered page these epics added or changed** and check each for a cookie, a storage identifier, a third-party request or a fingerprinting call — **from the built output, not the source.**
- Enumerate **every dependency these epics added that reaches the browser** and state what it loads.
- Enumerate **every response shape these epics added** and assert none can emit another person's data. Check enumeration oracles in body, status **and timing**.
- Verify no analytics event, log line or alert carries personal data; verify IP truncation precedes hashing and the pepper is outside the database.
- Then: webhook signature verification **before** parsing · idempotency keys and unique constraints **actually present in the schema**, not only in code · **`audit_log` append-only enforced by database permission** · no secret in logs or templates · dependency risk.

**5. Hygiene.** Dead code, duplicated logic across tickets, TODO or FIXME left in scope, unused exports, **flag debt** (a flag permanently on is overdue for removal), coverage regressions, **and any placeholder value where a founder input belongs.**

**6. Doc-drift sweep.** Compare implemented reality against: the touched `docs/modules/*.md` · `docs/api/README.md` versus actual routes, response shapes and error codes · `docs/data/model.md` versus the actual schema **and against what the privacy policy claims is collected** · the flag registry in `docs/features/README.md` versus registered flags · ADR statuses · `infra/ENV.md` versus actual env vars. **Every mismatch is a doc-drift item with the correct state stated.**

The data-model-versus-policy comparison is the one to do carefully: **a column collected but not disclosed is a compliance defect, not doc drift.**

**7. Strengthen the net.** Where a missing test is cheap, write it now on a branch `fix/qa-<epics>-tests` and include it in the report. Larger gaps become findings for fix-and-verify.

## Step 4 — Output exactly this

```
# Integrated QA report — <epics under audit>
VERDICT: GO | NO-GO   — one-paragraph justification

## Blockers (must fix before the next epics build on this)
1. <evidence (file:line / failing command output) — rule or spec violated (path#anchor) — required fix>

## Important findings (fix soon; not gating)
## Doc-drift items (doc path → what it says → what reality is → required correction)
## Test gaps (added now vs. remaining as findings)
## Plan defects (or "None")   ← where the plan itself is wrong; founder authorisation required to change it
## Observations (non-actionable but worth knowing)

## Evidence log
- Commands run + results
- Journeys traced + outcome
- Fallback rows verified / failed
- Pages checked for cookies, storage, third-party requests and fingerprinting
- Response shapes checked for other people's data
- Browser-reaching dependencies and what each loads
```

**NO-GO** if any blocker exists, or if a campaign-gating invariant is unverifiable: **the privacy properties · double-opt-in exclusivity · reward-hold integrity · email idempotency and suppression · giveaway eligibility and draw reproducibility · audit append-only.**

**Do not fix blockers yourself** beyond pass 7's cheap tests. Findings go to the fix-and-verify prompt, and **this blocker list must be re-verified clear before the next epic opens.**

**Dual-model gates:** if this run is one of two, work **strictly independently** — you must not read, receive or reference the other model's report, and yours must not speculate about it. The founder merges them afterward; the deduplicated **union** of blockers gates, and disagreements are settled **by evidence through the fix-and-verify dispute path, never by which model said it.**
