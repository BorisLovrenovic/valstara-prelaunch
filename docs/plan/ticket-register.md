# Ticket register — execution order and status

**This file says what runs next and what is finished.** `docs/plan/development-plan.md` says what each ticket builds; this register says in which order the tickets run and which are done. A person or the orchestrator takes **the first row whose Status is `todo`**, and nothing else.

## Rules

1. **Rows are in execution order**, not ID order. E6-06 runs inside Epic E8, S-01 runs before E7, E11.5 ran in the order its founder authorisations set (plan, Epic E11.5), E11.6 and E11.7 run between GATE-7 and E12 (both founder-authorised 2026-11-17), E11.6-11a (test and CI tooling) runs between E11.6-11 and E11.6-12 (founder-authorised 2026-11-19), with one gate, GATE-8, after E11.7 that audits both epics together (founder-authorised 2026-11-17).
2. **Two kinds of row.** A ticket row's ID and Title match a `### <ID> — <Title>` heading in the plan exactly. A gate row (`GATE-<n>`) is a QA gate from plan §6; it audits every ticket row between the previous gate row and itself, and its Epic column is the `{EPICS}` value for `03-integrated-qa.md`.
3. **Status** is `todo`, `done` or `removed`. **Mode** is `auto` (the orchestrator may run it, with the founder approving each step) or `manual` (the founder runs it; the orchestrator stops and says so).
4. **Who changes a row:**
   - A ticket row becomes `done` **on the ticket's own branch**, in the pre-push step (`docs/engineering/prompts/07-pre-push-checks.md`), so it reaches `main` in the same squash merge as the work.
   - A gate row becomes `done` when the gate reaches GO, in a docs-only pull request `docs(plan): record QA gate <n> GO [GATE-<n>]`.
   - **Adding, removing or reordering a row, or changing its Mode, needs founder authorisation**, and happens in the same change that edits the plan (plan §0). A ticket added to the plan gets its row in the same commit.
5. **The register and the plan must agree.** A plan ticket with no row, a row with no plan ticket, or a title that differs stops the orchestrator until the founder fixes it.
6. **The Epic column** is the epic label passed to every prompt as `{EPIC}`.

Gates 1 to 6 are recorded `done` because every later epic has merged and no epic opens on a NO-GO (plan §6). E2-02 is recorded `done`: its fonts are in `public/fonts/`, although no commit on `main` carries its ID.

## Register

| # | ID | Title | Epic | Status | Mode |
|---|----|-------|------|--------|------|
| 1 | E1-01 | Repository scaffold: Astro, Node adapter, strict TypeScript | Epic E1 — Foundations | done | auto |
| 2 | E1-02 | Local Compose stack: PostgreSQL, the app, Umami | Epic E1 — Foundations | done | auto |
| 3 | E1-03 | Data layer, migration runner and the initial schema | Epic E1 — Foundations | done | auto |
| 4 | E1-04 | CI PR pipeline: lint, typecheck, test, build, coverage | Epic E1 — Foundations | done | auto |
| 5 | E1-05 | CI security and privacy gates | Epic E1 — Foundations | done | auto |
| 6 | E1-06 | Image build, GHCR push, production Compose behind Cloudflare | Epic E1 — Foundations | done | auto |
| 7 | E1-07 | Deploy with a migration audit, and a drilled rollback | Epic E1 — Foundations | done | auto |
| 8 | E1-08 | Backups: the waitlist database into pgBackRest, and a proven restore | Epic E1 — Foundations | done | auto |
| 9 | E1-09 | Append-only audit log | Epic E1 — Foundations | done | auto |
| 10 | E1-10 | Campaign flags with code-level fail-safe defaults | Epic E1 — Foundations | done | auto |
| 11 | E1-11 | Thin end-to-end slice: signup → row → verification mail → verified | Epic E1 — Foundations | done | auto |
| 12 | E1-12 | Validated configuration and the environment inventory | Epic E1 — Foundations | done | auto |
| 13 | GATE-1 | QA gate 1 — E1 | E1 | done | auto |
| 14 | E2-01 | The portable token file | Epic E2 — Design system and site shell | done | auto |
| 15 | E2-02 | Self-hosted fonts with metric-matched fallbacks | Epic E2 — Design system and site shell | done | auto |
| 16 | E2-03 | Theme toggle island | Epic E2 — Design system and site shell | done | auto |
| 17 | E2-04 | Interface primitives | Epic E2 — Design system and site shell | done | auto |
| 18 | E2-05 | Layout, navigation and footer | Epic E2 — Design system and site shell | done | auto |
| 19 | E2-06 | The landing page | Epic E2 — Design system and site shell | done | auto |
| 20 | E2-07 | Accessibility baseline and the CI gate | Epic E2 — Design system and site shell | done | auto |
| 21 | E2-08 | The copy layer and the forbidden-copy scan | Epic E2 — Design system and site shell | done | auto |
| 22 | E3-01 | Email normalisation and the uniqueness rule | Epic E3 — Signup and double opt-in | done | auto |
| 23 | E3-02 | The signup route | Epic E3 — Signup and double opt-in | done | auto |
| 24 | E3-03 | Turnstile verification | Epic E3 — Signup and double opt-in | done | auto |
| 25 | E3-04 | Country selector with geo prefill | Epic E3 — Signup and double opt-in | done | auto |
| 26 | E3-05 | The signup form island | Epic E3 — Signup and double opt-in | done | auto |
| 27 | E3-06 | Verification tokens | Epic E3 — Signup and double opt-in | done | auto |
| 28 | E3-07 | The verify endpoint and the success page | Epic E3 — Signup and double opt-in | done | auto |
| 29 | E3-08 | The reminder ladder and unverified expiry | Epic E3 — Signup and double opt-in | done | auto |
| 30 | E3-09 | Resend-verification, without an enumeration oracle | Epic E3 — Signup and double opt-in | done | auto |
| 31 | E3-10 | Verification-rate monitoring | Epic E3 — Signup and double opt-in | done | auto |
| 32 | GATE-2 | QA gate 2 — E2 + E3 | E2 + E3 | done | auto |
| 33 | E4-01 | Referral code generation | Epic E4 — Referral engine | done | auto |
| 34 | E4-02 | Server-side ref capture and the signed field | Epic E4 — Referral engine | done | auto |
| 35 | E4-03 | Attribution and the edge | Epic E4 — Referral engine | done | auto |
| 36 | E4-04 | Confirmation on verification | Epic E4 — Referral engine | done | auto |
| 37 | E4-05 | Milestone ladder and tiers | Epic E4 — Referral engine | done | auto |
| 38 | E4-06 | Reward gating | Epic E4 — Referral engine | done | auto |
| 39 | E4-07 | Access-window assignment | Epic E4 — Referral engine | done | auto |
| 40 | E4-08 | Referral status in email and on `/me` | Epic E4 — Referral engine | done | auto |
| 41 | E4-09 | The counter repair job | Epic E4 — Referral engine | done | auto |
| 42 | E5-01 | Disposable-domain blocklist and MX check | Epic E5 — Fraud and integrity | done | auto |
| 43 | E5-02 | Self-referral and duplicate-identity flags | Epic E5 — Fraud and integrity | done | auto |
| 44 | E5-03 | IP velocity flags with truncated, hashed prefixes | Epic E5 — Fraud and integrity | done | auto |
| 45 | E5-03a | Admin authentication (the single-operator MFA boundary) | Epic E5 — Fraud and integrity | done | auto |
| 46 | E5-04 | The flag review queue | Epic E5 — Fraud and integrity | done | auto |
| 47 | E5-05 | Disqualification, audited, with the published rule | Epic E5 — Fraud and integrity | done | auto |
| 48 | E5-06 | Leaderboard integrity | Epic E5 — Fraud and integrity | done | auto |
| 49 | E5-07 | The top-20 review gate | Epic E5 — Fraud and integrity | done | auto |
| 50 | GATE-3 | QA gate 3 — E4 + E5 | E4 + E5 | done | auto |
| 51 | E6-01 | Leaderboard snapshot | Epic E6 — Leaderboard, survey and member area | done | auto |
| 52 | E6-02 | The leaderboard island and the kill switch | Epic E6 — Leaderboard, survey and member area | done | auto |
| 53 | E6-03 | Survey capture and write-back | Epic E6 — Leaderboard, survey and member area | done | auto |
| 54 | E6-04 | The signed status link | Epic E6 — Leaderboard, survey and member area | done | auto |
| 55 | E6-05 | The member dashboard | Epic E6 — Leaderboard, survey and member area | done | auto |
| 56 | S-01 | Align the built campaign with the Hong Kong giveaway strategy | Standalone ticket — outside every epic | done | auto |
| 57 | E7-01 | Entry eligibility: verified, 18+, one person | Epic E7 — Giveaway | done | auto |
| 58 | E7-02 | The global rules page (Hong Kong law) | Epic E7 — Giveaway | done | auto |
| 59 | E7-03 | The entry ledger | Epic E7 — Giveaway | done | auto |
| 60 | E7-04 | The free entry route and its disclosure | Epic E7 — Giveaway | done | auto |
| 61 | E7-05 | The reproducible draw | Epic E7 — Giveaway | done | auto |
| 62 | E7-06 | Award-time checks, notification and the award record | Epic E7 — Giveaway | done | auto |
| 63 | GATE-4 | QA gate 4 — S-01 + E6 + E7 | S-01 + E6 + E7 | done | auto |
| 64 | E8-01 | The email service | Epic E8 — Email | done | auto |
| 65 | E6-06 | Unsubscribe and preferences | Epic E8 — Email | done | auto |
| 66 | E8-02 | The Resend provider and domain authentication | Epic E8 — Email | done | auto |
| 67 | E8-03 | The seven transactional templates | Epic E8 — Email | done | auto |
| 68 | E8-03a | Transactional queue producers | Epic E8 — Email | done | auto |
| 69 | E8-04 | Rendering QA and seed tests | Epic E8 — Email | done | auto |
| 70 | E8-05 | The Brevo provider and contact sync | Epic E8 — Email | done | auto |
| 71 | E8-06 | Bounce and complaint handling | Epic E8 — Email | done | auto |
| 72 | E8-07 | The weekly campaign update | Epic E8 — Email | done | auto |
| 73 | E8-08 | Removed | Epic E8 — Email | removed | — |
| 74 | E8-09 | Quota projection and the free-tier gate | Epic E8 — Email | done | auto |
| 75 | GATE-5 | QA gate 5 — E8 | E8 | done | auto |
| 76 | E9-01 | The content pipeline | Epic E9 — Content, trust, legal and SEO | done | auto |
| 77 | E9-02 | Trust pages at permanent URLs | Epic E9 — Content, trust, legal and SEO | done | auto |
| 78 | E9-03 | Legal pages and the representative gate | Epic E9 — Content, trust, legal and SEO | done | auto |
| 79 | E9-04 | The cookie and storage inventory | Epic E9 — Content, trust, legal and SEO | done | auto |
| 80 | E9-05 | Data-subject rights | Epic E9 — Content, trust, legal and SEO | done | auto |
| 81 | E9-06 | SEO foundations | Epic E9 — Content, trust, legal and SEO | done | auto |
| 82 | E9-07 | OG images and social cards | Epic E9 — Content, trust, legal and SEO | done | auto |
| 83 | E9-08 | `llms.txt` and the Trustpilot link | Epic E9 — Content, trust, legal and SEO | done | auto |
| 84 | E10-01 | Umami deployment and the cookieless proof | Epic E10 — Analytics and admin | done | auto |
| 85 | E10-02 | The event schema and registry | Epic E10 — Analytics and admin | done | auto |
| 86 | E10-03 | Server-side funnel events | Epic E10 — Analytics and admin | done | auto |
| 87 | E10-04 | The CSV export | Epic E10 — Analytics and admin | done | auto |
| 88 | E10-05 | The health view | Epic E10 — Analytics and admin | done | auto |
| 89 | GATE-6 | QA gate 6 — E9 + E10 | E9 + E10 | done | auto |
| 90 | E11-01 | Load test at 10× expected peak | Epic E11 — Hardening and campaign launch | done | auto |
| 91 | E11-02 | Chaos drills | Epic E11 — Hardening and campaign launch | done | auto |
| 92 | E11-03 | Accessibility audit | Epic E11 — Hardening and campaign launch | done | auto |
| 93 | E11-04 | Claims and copy audit | Epic E11 — Hardening and campaign launch | done | auto |
| 94 | E11-05 | Privacy audit | Epic E11 — Hardening and campaign launch | done | auto |
| 95 | E11-06 | The handoff export and two rehearsed imports | Epic E11 — Hardening and campaign launch | done | auto |
| 96 | E11-07 | Cutover rehearsal and the port checklist | Epic E11 — Hardening and campaign launch | done | auto |
| 97 | E11-08 | Campaign launch readiness gate | Epic E11 — Hardening and campaign launch | done | auto |
| 98 | E11.5-01 | Design foundations: tokens, breakpoints, icons, layout checks and the extended literal-value scan | Epic E11.5 — Frontend design | done | auto |
| 99 | E11.5-02 | Survey v2: the digital-goods taxonomy | Epic E11.5 — Frontend design | done | auto |
| 100 | E11.5-03 | The site shell and the primitives | Epic E11.5 — Frontend design | done | auto |
| 101 | E11.5-04 | The provider showcase | Epic E11.5 — Frontend design | done | auto |
| 102 | E11.5-05 | The landing page | Epic E11.5 — Frontend design | done | auto |
| 103 | E11.5-06 | Signup form states and the mobile sticky signup bar | Epic E11.5 — Frontend design | done | auto |
| 104 | E11.5-07 | Verification and the success page | Epic E11.5 — Frontend design | done | auto |
| 105 | E11.5-08 | The member page and the leaderboard page | Epic E11.5 — Frontend design | done | auto |
| 106 | E11.5-09 | Trust, legal and giveaway rules pages | Epic E11.5 — Frontend design | done | auto |
| 107 | E11.5-10 | Task pages, and branded 404 and 500 pages | Epic E11.5 — Frontend design | done | auto |
| 108 | E11.5-11 | The email layout | Epic E11.5 — Frontend design | done | auto |
| 109 | E11.5-11a | Wireframe foundations: tokens, breakpoints, icons and primitives | Epic E11.5 — Frontend design | done | auto |
| 110 | E11.5-11b | Wireframe shell: header and footer | Epic E11.5 — Frontend design | done | auto |
| 111 | E11.5-11c | Wireframe hero and above-the-fold | Epic E11.5 — Frontend design | done | auto |
| 112 | E11.5-11d | Wireframe catalogue and "How it works" | Epic E11.5 — Frontend design | done | auto |
| 113 | E11.5-11e | Wireframe "What you get" and its feature-switch variants | Epic E11.5 — Frontend design | done | auto |
| 114 | E11.5-11f | Wireframe guarantee band, trust cards, FAQ and final call to action | Epic E11.5 — Frontend design | done | auto |
| 115 | E11.5-11g | Wireframe signup form states | Epic E11.5 — Frontend design | done | auto |
| 116 | E11.5-11h | Wireframe mobile sticky signup bar | Epic E11.5 — Frontend design | done | auto |
| 117 | E11.5-11i | The motion system: tokens, utilities, guards and at-rest measurement | Epic E11.5 — Frontend design | done | auto |
| 118 | E11.5-11j | Final-design foundations: the token delta, icons and primitives | Epic E11.5 — Frontend design | done | auto |
| 119 | E11.5-11k | Final-design shell: header and footer | Epic E11.5 — Frontend design | done | auto |
| 120 | E11.5-11l | Final-design hero: the text column, the entrance and the fold | Epic E11.5 — Frontend design | done | auto |
| 121 | E11.5-11m | Final-design signup form states and the mobile sticky bar | Epic E11.5 — Frontend design | done | auto |
| 122 | E11.5-11n | Final-design catalogue and "How it works" | Epic E11.5 — Frontend design | done | auto |
| 123 | E11.5-11o | Final-design "What you get" and its feature-switch variants | Epic E11.5 — Frontend design | done | auto |
| 124 | E11.5-11p | Final-design guarantee band, trust cards, FAQ and final call to action | Epic E11.5 — Frontend design | done | auto |
| 125 | E11.5-11q | Final-design verification and the success page | Epic E11.5 — Frontend design | done | auto |
| 126 | E11.5-11r | Final-design member page and leaderboard | Epic E11.5 — Frontend design | done | auto |
| 127 | E11.5-11s | Final-design trust, legal and giveaway rules pages | Epic E11.5 — Frontend design | done | auto |
| 128 | E11.5-11t | Final-design task pages, and the 404 and 500 pages | Epic E11.5 — Frontend design | done | auto |
| 129 | E11.5-12 | Design QA, the re-audits and founder sign-off | Epic E11.5 — Frontend design | done | auto |
| 130 | GATE-7 | QA gate 7 — E11 + E11.5 | E11 + E11.5 | done | auto |
| 131 | E11.6-01 | Discovery spike: the source site's structure, terms and fixtures | Epic E11.6 — Price index and price pages | done | auto |
| 132 | E11.6-02 | Markets, the catalogue and their schemas | Epic E11.6 — Price index and price pages | done | auto |
| 133 | E11.6-03 | Exact money, the price record and JSON storage | Epic E11.6 — Price index and price pages | done | auto |
| 134 | E11.6-04 | The browser fetcher: one page at a time, backoff and checkpoints | Epic E11.6 — Price index and price pages | done | auto |
| 135 | E11.6-05 | The source-adapter interface and the youfundceo adapter | Epic E11.6 — Price index and price pages | done | auto |
| 136 | E11.6-06 | Merge, validation and the publish gate | Epic E11.6 — Price index and price pages | done | auto |
| 137 | E11.6-07 | The scrape run: commands, run log, dry run and isolation from the site | Epic E11.6 — Price index and price pages | done | auto |
| 138 | E11.6-08 | The coverage report, spot checks and the override commands | Epic E11.6 — Price index and price pages | done | auto |
| 139 | E11.6-09 | The change log and the monthly report | Epic E11.6 — Price index and price pages | done | auto |
| 140 | E11.6-10 | The service × market page: route, flag, published-URL ledger and sitemap index | Epic E11.6 — Price index and price pages | done | auto |
| 141 | E11.6-11 | Service × market page content: history, comparison, related services, FAQ and the Valstara price | Epic E11.6 — Price index and price pages | done | auto |
| 142 | E11.6-11a | Faster local checks, eight CI shards and the known test flakes | Epic E11.6 — Price index and price pages | done | auto |
| 143 | E11.6-12 | The service hub, the market hub and `/prices` | Epic E11.6 — Price index and price pages | done | auto |
| 144 | E11.6-13 | `/price-index`, the methodology and the monthly report pages | Epic E11.6 — Price index and price pages | done | auto |
| 145 | E11.6-14 | Social cards for the price pages | Epic E11.6 — Price index and price pages | done | auto |
| 146 | E11.6-15 | The first monthly run and the monthly runbook | Epic E11.6 — Price index and price pages | todo | manual |
| 147 | E11.6-16 | Price-page audit and founder sign-off | Epic E11.6 — Price index and price pages | todo | auto |
| 148 | E11.7-01 | The shared code registry and the partner code rules | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 149 | E11.7-02 | Voiding a referral, and the founder command line | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 150 | E11.7-03 | The coupon ladder and wave 1 replace the milestone tiers | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 151 | E11.7-04 | Showing the ladder: `/me`, verification, the landing page, emails and the privacy policy | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 152 | E11.7-05 | The programme page and the partner application | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 153 | E11.7-06 | Founder review, contract tracking and lifecycle commands | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 154 | E11.7-07 | Activation: `/r/{CODE}`, partner attribution and retroactive attribution | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 155 | E11.7-08 | The typed referral code, and partner perks at signup | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 156 | E11.7-09 | The partner dashboard: private link, stats and settings | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 157 | E11.7-10 | The partner leaderboard | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 158 | E11.7-11 | The asset kit: QR codes, message templates and the print flyer | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 159 | E11.7-12 | The auto-invite and the first-signup email | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 160 | E11.7-13 | The partner digest | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 161 | E11.7-14 | The attribution export and the hand-over document | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 162 | E11.7-15 | Seed data, the partner-programme audit and founder sign-off | Epic E11.7 — Pre-launch partner programme | todo | auto |
| 163 | GATE-8 | QA gate 8 — E11.6 + E11.7 | E11.6 + E11.7 | todo | auto |
| 164 | E12-01 | Provision the host and run the production stack on it | Epic E12 — Production bring-up | todo | manual |
| 165 | E12-02 | Deploy from GHCR against the real host, with the migration audit | Epic E12 — Production bring-up | todo | manual |
| 166 | E12-03 | The timed rollback drill | Epic E12 — Production bring-up | todo | manual |
| 167 | E12-04 | Backups to R2, and a restore proven from the remote | Epic E12 — Production bring-up | todo | manual |
| 168 | E12-05 | Cloudflare: proxy, origin lock-down, Turnstile and Web Analytics | Epic E12 — Production bring-up | todo | manual |
| 169 | E12-06 | Chaos drills and the capacity run on the real box | Epic E12 — Production bring-up | todo | manual |
| 170 | E12-07 | Production readiness gate | Epic E12 — Production bring-up | todo | manual |
