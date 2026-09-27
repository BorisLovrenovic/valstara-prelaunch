# ADR Index

Architecture decision records for the Valstara pre-launch site. One file per significant decision.

**These record `prelaunch-stack-decisions.md` v2 (25 August 2026); they do not re-litigate it.** Where an ADR adds reasoning the stack document did not carry, it is reasoning about *how to build the decision*, not about whether to make it.

## Rules

1. **Every significant decision has an ADR here.** "Significant" = affects the data store, a vendor, a security or privacy property, the campaign mechanics, or what the storefront inherits.
2. **When a decision changes, the ADR and every affected doc under `docs/` is updated in the same ticket as the code change.** A PR that changes behaviour without touching the ADR fails review.
3. **Superseding: never edit history.** Add a new ADR and mark the old one `Superseded by ADR-XXX`.
4. **A new paid service requires founder approval before status can move Proposed → Accepted.**
5. **A `Proposed` ADR is not a licence to build.** An agent encountering one stops and asks.

## Index

| # | Title | Status |
|---|---|---|
| **Platform** | | |
| 001 | Astro with the Node adapter, and only three islands | Accepted |
| 002 | A separate repository from the storefront | Accepted |
| 003 | Self-hosted on the existing VPS, behind Cloudflare | Accepted |
| 004 | A separate `valstara_waitlist` PostgreSQL database | Accepted |
| 005 | Astro API routes rather than a separate waitlist service | Accepted |
| **Privacy and integrity** | | |
| 006 | Cloudflare Turnstile for bot defence | Accepted |
| 007 | Cookieless analytics and no consent banner | Accepted |
| 008 | Server-side referral attribution via a signed field, never a cookie | Accepted |
| 011 | Double opt-in, unconditional | Accepted — amended by 027 |
| 027 | Joining and entering are separate from marketing consent | Accepted |
| 012 | Reward gating — high-value rewards held to a post-launch first order | Accepted |
| 013 | No device fingerprinting | Accepted |
| **Email** | | |
| 009 | Split providers — Resend transactional, Brevo broadcast | Accepted |
| 010 | The SubSlush migration send goes from `subslush.com` | Superseded by 028 |
| 028 | The SubSlush announcement is sent manually, outside the Valstara email system | Accepted |
| **Content, brand and presentation** | | |
| 014 | English only, served at the root | Accepted |
| 015 | Design tokens in one framework-free CSS file | Accepted |
| 016 | Self-hosted OFL fonts; Söhne deferred to store launch | Accepted |
| 017 | Trust and legal copy as content files at permanent URLs | Accepted |
| 024 | No countdown timers, inflated positions or manufactured scarcity | Accepted |
| **Campaign mechanics and law** | | |
| 018 | Giveaway jurisdiction exclusions enforced at point of entry | Superseded by 026 |
| 019 | EU and UK Article 27 representatives named before the first signup | Accepted |
| 020 | Build the waitlist rather than buy a hosted one | Accepted |
| 023 | Campaign flags with code-level fail-safe defaults | Accepted |
| 025 | Campaign business config — tier ladder, wave bands, survey v1 | Accepted |
| 026 | One global giveaway under Hong Kong law, with no jurisdiction gating | Accepted |
| **Transition** | | |
| 021 | Launch is a host cutover at the DNS layer, not a deploy | Accepted |
| 022 | The waitlist database is frozen read-only for 90 days after handoff | Accepted |

26 Accepted · 2 Superseded · 0 Proposed.

## Open items

| Ref | Item | Nature | Blocks |
|---|---|---|---|
| ADR-019 | Appoint the EU and UK representatives | **Procurement** — longest lead time of any prerequisite | **The privacy policy, which gates the first signup** |
| ADR-016 | Söhne web licence price — Klim prices interactively at checkout | **Cost confirmation** | Nothing pre-launch; the campaign ships on Instrument Sans |
| ADR-009 | Brevo tier above 100k emails/month is interpolated, not published | **Cost confirmation** | Nothing — the upgrade decision is already made |
| ADR-003 | Cloudflare Pages as the alternative host | **Recorded alternative**, not a pending decision | Nothing |

## Reading order for a new agent

1. **001** and **005** — what this application is and where its logic lives
2. **004** — why the database is separate, and what it is designed against
3. **007**, **008** and **013** — the three decisions that together mean no consent banner. **Read these before writing anything that reaches a browser**
4. **011** and **012** — verification as the boundary, and reward gating as the answer to fraud
5. **015** and **017** — the two artifacts that survive into the storefront
