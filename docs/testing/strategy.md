# Testing Strategy

Status: authoritative. **The QA gates later are audits, not the safety net.** The tests written inside every ticket are the safety net.

## Tiers

| Tier | Runs against | Covers |
|---|---|---|
| **Unit** | Nothing external | Normalisation, signing, token hashing, tier computation, eligibility rules, copy scanning |
| **Module contract** | A disposable PostgreSQL | Each module's documented interface and its rules — the "Contract tests" line of every `docs/modules/*.md` |
| **Integration** | The local Compose stack | Route → module → database → queued email, end to end |
| **Build-time assertion** | The Astro build | Metadata completeness, frontmatter validity, token placeholders. ADR-029 removed the representative assertion |
| **Rendered-page checks** | A built page | No cookie, no storage identifier, no third-party request, axe accessibility |
| **Load** | Production-shaped infrastructure | The signup endpoint at 10× expected peak (E11-01) |

Rendered-page checks drive Chromium in the version-pinned official Playwright
container. The Node test process and built Astro server remain on the host and
connect to that isolated browser over loopback. This makes local and CI runs use
the same browser system libraries without requiring privileged host package
installation. Docker is therefore a test prerequisite, alongside the disposable
PostgreSQL and integration stack.

E11-03's keyboard journey, rendered contrast measurements, error-state checks
and spoken screen-reader pass are recorded in
[`e11-03-accessibility-audit.md`](e11-03-accessibility-audit.md).

E11.5-12 re-runs the E11-03, E11-04, E11-05 and E11-07 audits on the final
design and measures the landing page's performance
(`test/e11-5-12-landing-performance.test.mjs`: zero layout shift and LCP within
2.5 s at 390px with 4× CPU throttling). Its evidence, the full contact sheet's
index and the founder's sign-off are recorded in
[`e11-5-design-qa.md`](e11-5-design-qa.md).

## Coverage bars

≥80% changed code. **≥90% in `subscriber`, `verification`, `referral`, `giveaway`, `email`** — the five modules where a defect is either unrecoverable or discredits the campaign.

## The invariant tests

Each states a property the campaign depends on.

**A seeded property-based test is required where, and only where, a ticket's Tests line names one.** The plan decides; a reviewer may not infer the requirement from an acceptance criterion's wording. Where a ticket does name one, it uses a fixed seed and bounded runs, **alongside** example cases rather than instead of them.

This is deliberate. "Where an AC states an invariant" was the earlier wording and it was undecidable — almost any criterion can be read as stating an invariant, so the requirement was whatever a given reviewer thought it was, and no ticket could be finished. If a property test is worth having, the ticket says so.

| # | Invariant | Where |
|---|---|---|
| I1 | **No unverified subscriber is counted, ranked, rewarded, exported or broadcast to** | Every consuming surface |
| I2 | **One subscriber per normalised email** — `+tag` and Gmail-dot variants collide | `subscriber` |
| I3 | **One referral edge per referred person**, enforced by the database | `referral` |
| I4 | **`confirmed_referrals` recomputes idempotently from edges** for any generated graph | `referral` |
| I5 | **A high-value reward cannot settle from a verification path** | `referral` |
| I6 | **One email per business key** — a retry never double-sends | `email` |
| I7 | **Suppression written between queue and dispatch stops the send** | `email` |
| I8 | **A replayed verification token returns success, not an error** | `verification` |
| I9 | **No entry accrues for an unverified subscriber, and no accrual double-credits** | `giveaway` |
| I10 | **A draw reproduces from its recorded seed and snapshot hash** | `giveaway` |
| I11 | **No code path sets `disqualified` without a recorded human actor** | `fraud` |
| I12 | **`UPDATE` and `DELETE` on `audit_log` are rejected at the database level** | `audit` |
| I13 | **No non-essential cookie, storage identifier, third-party request or fingerprinting API** | Rendered pages, whole repository |
| I14 | **No public response carries another person's data** | Every registered route |
| I15 | **No analytics event property carries personal data** | The event registry |
| I16 | **A full IP address is never stored, logged or returned** | `fraud`, logging |

**A test that would still pass if the feature broke is a defect.** For at least one critical test per ticket, mutate the implementation and confirm the test catches it.

## Rules

- **Time-dependent logic injects a clock. Never `Date.now()` in a test path.** The reminder ladder, token expiry and retention sweeps are all clock-driven and all table-tested.
- **Concurrency-sensitive behaviour is tested under genuine concurrency against a real database, never mocked.** Duplicate signup and duplicate entry accrual are the canonical cases — both rely on database constraints, and a mocked test proves nothing about a constraint.
- **Top-level test files run serially.** Database fixtures create separate databases on one PostgreSQL cluster, but migrations provision the cluster-global `valstara_app` role; parallel files can otherwise race while updating that shared role. Tests that assert concurrency create genuine parallel database sessions inside the test.
- **Fixtures are explicit by default; generated only where the test asserts a property over many inputs.** An example test reads better with literal values a person can check at a glance, and `crypto.randomUUID()` for an identifier nobody asserts on is fine. **A generated fixture must be seeded** — a fixed seed, so a failure reproduces. Do not convert working example fixtures to generated ones; that trades clarity for nothing.
- **A flake is a finding, not noise.** Fix the nondeterminism; quarantining requires an explicit follow-up.

## What a reviewer may require

**This section exists to make review decidable.** A ticket that can fail review on a rule nobody can bound is a ticket that never finishes, and that is a defect in this document rather than in the branch.

A pre-PR reviewer may raise a blocker on exactly three grounds:

1. **An acceptance criterion on the ticket is not met, or is met but not demonstrated** by a named test or a reproducible command.
2. **A test named on the ticket's Tests line is missing, or would still pass if the behaviour it names broke.**
3. **A standing rule in `docs/plan/development-plan.md#4-standing-rules-for-every-ticket` is violated by this diff.**

**Nothing else is a blocker.** Specifically, a reviewer may **not** require:

- a test style the ticket did not ask for — property-based, generated fixtures, table-driven — where example tests demonstrate the criterion
- coverage of code the ticket did not touch
- work owned by another ticket, whether earlier or later
- a refactor, a rename, or a structural preference
- rework of something a previous review on the same ticket already passed, unless this diff changed it

Anything real but outside those three grounds goes under **Non-blocking findings**, or under **Plan tensions** where the plan itself is at fault. The integrated QA gate is where the repository is audited as a whole.

## Definition of done

A ticket is done when **all** of the following hold:

1. Every acceptance criterion is met and **demonstrated by a named test or a reproducible command**
2. Every test on the ticket's **Tests** line exists and passes
3. `npm run check` and `npm run test:changed`, naming the Tests-line files (it also runs the test files the branch adds or changes, and nothing else), clean locally, and every CI check green on the pull request, where the full suite runs across eight shards (`docs/engineering/ci-cd.md#local-checks`)
4. Coverage bars hold
5. Security and privacy gates green
6. The ticket's flag is wired with a code-level fail-safe default, **and the flag-off path is tested**
7. **Docs and ADRs updated in the same PR**
8. No forbidden copy string, no placeholder value, no TODO in in-scope work
9. Deviations reported explicitly — **honest incompleteness is acceptable, silent gaps are not**

## Known flakes

Recorded by E11.6-11a on 2026-11-20 (founder-authorised 2026-11-19). **A flake is fixed only at a cause shown with evidence**: a reproduction, a log or an injected fault, then a change at that cause and, where the cause reproduces, a test that fails before the fix. A retry, a longer timeout, a sleep or fixed wait, a skip, `--test-force-exit`-style masking, a weakened assertion or a gate exception is never a fix. **A flake whose cause cannot be shown gets no change**: it is recorded here, with what was tried, for a founder decision. The evidence below was gathered on the development host: WSL 2 with Docker Desktop 29.5.3.

| Flake | Status |
|---|---|
| a. "refused 300 connection attempts" | **Cause not proven.** Containers a dead run leaves behind are removed by owner label, as leak hygiene, not as its fix (D-035 Q1), `test/helpers/container-owner.mjs` |
| b. "Unable to capture screenshot" | **Cause not proven.** A failed capture now names what it was capturing (D-035 Q2), `scripts/design/contact-sheet.mjs` |
| c. The browser container cannot reach the app | **Fixed at its cause**, `test/helpers/listen-port.mjs`, and every server the browser container reaches uses it (D-035 Q3) |
| d1. `test/e1-11-rendered-page.test.mjs` cancelled in CI | **Already fixed**; no change |
| d2. `EADDRINUSE` on 127.0.0.1:62001 | **Fixed at its cause**, `test/helpers/landing-render.mjs` |

### a. "refused 300 connection attempts"

**Seen.** Every test in a Playwright-backed file fails because `publishedPort()` finds the container's published port refused for 300 attempts. On 2026-11-19, in E11.6-10's pre-push run of 135 files, it hit `test/member-leaderboard-final-design-rendered.test.mjs` (container `valstara-member-final-playwright-4074468`, published on 127.0.0.1:50122); the file passed 15/15 alone. On 2026-11-07 it hit `test/landing-rewards-rendered.test.mjs` and `test:a11y` while an orphaned `valstara-member-design-*` container from a stopped run was still up; both passed once it was removed.

**What was tried, 2026-11-20.**

- **An orphaned container.** A Node parent that had started an attached `docker run --rm` Playwright container, as every browser suite does, was killed with SIGKILL. The container and its `docker run` client stayed up until removed by hand: the leak is real. A SIGTERM to the client does not stop the container either, because the container's PID 1 ignores it, which is why each suite's `after()` removes its container with `docker rm`. Three new Playwright containers started beside the orphan. Each published port accepted on its first attempt.
- **A port collision.** Docker Desktop publishes host ports in sequence from a random start: ports from 4062 to 59241 in these runs. 150 tiny containers published in a row all accepted from WSL, and Docker skipped the ports it could not expose (33027, 16473). A fixed host port already held by a WSL listener, or inside a Windows excluded port range, fails `docker run` at once with "ports are not available", never with a silent refusal. An outgoing WSL connection that holds the port number does not block the forward.

**Not proven.** Neither an orphan's presence nor a port collision reproduced the refusal, so **no change was made for the refusal itself**, and none is claimed.

**Leak hygiene (founder decision D-035 Q1, 2026-11-20).** The leak is proven, so containers a dead run leaves behind are removed, **as hygiene, not as this flake's fix**. Every per-process container a test or script starts with `docker run` (each `valstara-…-<pid>` container, in 35 files, whatever its name) carries owner labels from `containerOwnerArguments()` in `test/helpers/container-owner.mjs`: `com.valstara.test-owner.host`, `.boot-id` (`/proc/sys/kernel/random/boot_id`), `.pid-namespace` and `.pid`. Each of those files calls `removeOrphanedContainers()` before its own `docker run`. It force-removes only a labelled container whose host name is this host's and whose boot ID differs, or whose owning process no longer runs in this PID namespace. It never removes an unlabelled container, another host's or a live owner's. The PID namespace is read because WSL distributions share a host name, a boot ID and one Docker daemon, but not process IDs, so a process ID from another distribution cannot be judged and its container is kept. Removing a dead run's container also ends that run's orphaned `docker run` client. The three Compose-project runners (`infra/compose/assert-production-stack.mjs`, `infra/compose/assert-maintenance-start.mjs`, `scripts/chaos/e11-02-run.mjs`) start no container with `docker run`, and are not labelled. **Test:** `test/container-owner.test.mjs`, against real Docker: a dead owner's container and a previous boot's are removed, and a live owner's, an unlabelled one and another host's are kept.

**Manual cleanup**, for a container started before the labels existed or one the removal step has not yet reached: list the labelled containers with `docker ps --all --filter label=com.valstara.test-owner.pid --format '{{.Names}} {{.Label "com.valstara.test-owner.pid"}}'`, and remove only those whose owning process is gone. Match by label, never by a name pattern: `valstara-*-playwright-*` misses most of them, including the 2026-11-07 `valstara-member-design-*` orphan. A killed Compose runner leaves its whole project behind, containers, networks and volumes, and once its owning process is gone the project is removed with `docker compose -p <project> down -v`, or found by its `com.docker.compose.project` label (founder decision D-036 Q1, 2026-11-20).

### b. "Unable to capture screenshot"

**Seen.** CI `test (2/4)` of run 44509384078, 2026-11-19: `page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot`, from `captureContactSheet` (`scripts/design/contact-sheet.mjs`, the full-page capture) called by `test/member-leaderboard-redesign.test.mjs`. The call log shows the fonts had loaded. The job passed when re-run.

**What was tried.** The CI log names neither the state nor the page size being captured, and no artifact holds the page. On 2026-11-20 the file ran three times locally, with the screenshots taken at every state, width and theme each time, and passed 3/3 (about 100 seconds per run). The failure did not reproduce, and no fault that would produce it could be injected without guessing its condition.

**Not proven.** Chromium refuses a capture it cannot composite, but no evidence shows which condition held on the runner. **No fix is claimed.**

**Context for the next occurrence (founder decision D-035 Q2, 2026-11-20).** `captureContactSheet()` throws a failed `page.screenshot()` again, with a message naming the state, the width, the theme, the full-page flag and the page's scroll height, and with Chromium's own error as `cause`. The height read is limited to 2 seconds, and if it fails or times out the height reads "unknown"; it never replaces the original error. There is no retry and no catch-and-continue, and a capture that succeeds is unchanged. **Test:** "a failed capture names its state, width, theme, full-page flag and page height, with the original error as cause" in `test/layout-checks.test.mjs`, which injects the fault through the entry's `run` hook, including a page that never answers the height read.

### c. The browser container cannot reach the app

**Seen.** On 2026-10-29 the browser container in `test/signup-states-rendered.test.mjs` got `ERR_CONNECTION_REFUSED` from `host.docker.internal:<appPort>` for 30 seconds while the app had logged that it was listening. In the same family: 30-second `page.goto` timeouts in `test/verification-redesign.test.mjs`, including when it ran alone; `Cannot read properties of null (reading 'clientWidth')` in `checkLayout` (`scripts/design/layout-checks.mjs`), a read of a document that never loaded; and the six `page.goto` failures recorded in `docs/testing/e11-5-design-qa.md` on 2026-11-13.

**Cause.** On a WSL host with Docker Desktop, a browser container reaches a test server through Windows. `host.docker.internal` is the Windows host, and WSL relays each WSL listener to Windows localhost. `reserveListenPort()` checked only that a port was free in WSL. A port that Windows has reserved cannot be relayed. Windows re-draws its excluded port ranges at each boot inside its dynamic port range, which on this host is 1024–65535. A port a Windows process already listens on cannot be relayed either. The container is then refused, or reaches the Windows process instead.

**Evidence, 2026-11-20.** HTTP servers in WSL on three ports, each fetched from a container through `host.docker.internal`:

| Port | On the Windows side | From the container |
|---|---|---|
| 23456 | Free | Answered |
| 48800 | Inside the excluded range 48791–48890 | Refused after 2 ms |
| 15292 | A Windows process listening | Reached that process; no bytes in 5 s |

The refusal is the signup-states symptom, and the hang is the `page.goto` timeouts.

**Fix.** On WSL, `reserveListenPort()` reads Windows' excluded port ranges (`netsh interface ipv4 show excludedportrange protocol=tcp`) and its listening ports (`netstat -ano`, IPv4 and IPv6) once per reservation, in about 0.1 s, and never hands out a port Windows holds. If Windows' port use cannot be read on WSL, the reservation fails with that reason rather than guess. Off WSL, as on CI's Linux runners, nothing changes. Every server started through `startAppServer()` or `reserveListenPort()` gets it. Since D-035 Q3 (2026-11-20), every server the browser container reaches is started that way, including the five that listened on port 0 and so took a port from the ephemeral range, where Windows' excluded ranges on this host lie: the Astro fixture servers of `test/interface-primitives.test.mjs` and `test/provider-showcase-rendered.test.mjs` (now `startAppServer()`), and the in-process servers of `scripts/design/full-contact-sheet.mjs` (its email previews), `test/price-index/fetcher-browser.test.ts` and `test/price-index/cli-exit.test.ts` (now `reserveListenPort()`). Servers bound only to 127.0.0.1, which the browser container does not reach, are unchanged. **Test:** "a port Windows reserves or listens on is never reserved for a server the browser reaches" in `test/listen-port.test.mjs`; with the check removed, it fails by returning the Windows-held port.

**Not changed, and why.**

- **The null `clientWidth`** was not reproduced separately. It follows a navigation that never loaded a document, so it is expected to stop with the cause above. If it recurs on a port the Windows check cleared, it has a new cause.
- **The 2026-11-13 failures** happened while another checkout's suite ran on the same host, which is the environmental cause below. They are consistent with this cause too, but not proven to be it.
- **The relay delay.** WSL relays a new listener to Windows about 0.5–1 s after it starts listening. Measured from a container, a new server was refused in that window. The browser suites start their browser container, which takes over a second, between starting the app and their first navigation, and the suites that start a server after the browser poll it from the browser first (`test/layout-checks.test.mjs`, `test/signup-states-rendered.test.mjs`). No recorded failure traces to the delay, so nothing was built for it.

### d. Older flakes, confirmed

**d1. The `test/e1-11-rendered-page.test.mjs` cancellation in CI (2026-09-06)** — **already fixed; no change.** The cause was cleanup that awaited the server's exit event unconditionally, so a server that had already exited left the file waiting until the runner cancelled it. In the current code, `stopServer()` returns at once when the server has exited or has no PID. The file starts its server through `startAppServer()`, whose `stop()` awaits an exit promise taken when the server was spawned, so an exit cannot be missed.

**d2. `EADDRINUSE` on 127.0.0.1:62001 in `test/landing-hero-rendered.test.mjs` (2026-11-02)** — **not fixed until E11.6-11a; now fixed at its cause.** `test/helpers/landing-render.mjs` started its server on a fixed port, counting up from 62001 in every test process, and never checked that the port was free. Any other listener there failed every test that rendered the landing page. That could be an orphaned server from a stopped run, a port Docker Desktop published, or the same helper in a concurrent run: `skinwhale-prelaunch` carries an identical copy. With 127.0.0.1:62001 held, `renderLanding()` failed with "Landing test server exited (code 1, signal null): Error: listen EADDRINUSE: address already in use 127.0.0.1:62001". With a holder that accepted connections without answering, it hung, because its `fetch` has no timeout. **Fix:** the helper starts its server through `startAppServer()`, on a reserved port that is confirmed free (and on WSL also free on the Windows side), with a lost bind race retried on a fresh port. It reads `/robots.txt` for readiness, so readiness never renders the landing page. **Test:** "the landing render server starts while another process holds the fixed port it once used" in `test/landing-rendered-page.test.mjs`, which failed before the fix with the message above.

### Known environmental causes, out of scope

Interference from another project's test run on the same Docker host is a known environmental cause, not a flake of this suite. Examples are `skinwhale-prelaunch`'s Playwright containers and app servers (eleven of its servers from 17–18 November were still listening, orphaned, on 2026-11-20), and the Docker daemon that stopped answering on 2026-11-12 while both projects' browser suites ran. It belongs to the local-concurrency question, which the founder has deferred, and E11.6-11a builds nothing for it.
