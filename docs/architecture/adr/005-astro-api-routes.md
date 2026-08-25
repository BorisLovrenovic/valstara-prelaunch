# ADR-005: Astro API routes rather than a separate waitlist service

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
Signup, verification, referral confirmation and survey submission need server endpoints. They could live in the Astro app or in a small Node service beside it.

## Decision
**Astro API routes, same origin.** No CORS, no second deploy unit, no service boundary between a form and the endpoint it posts to.

## Alternatives rejected
- **A separate Node service** — a second image, a second health check and a network hop, to separate two things that ship and fail together.
- **Serverless functions elsewhere** — reintroduces a hosting line and a cold-start on the campaign's most important write.

## Consequences
The route layer stays thin by rule: **validate, call one server module, shape the response** (`docs/architecture/modules.md`). All campaign logic lives in `src/server/`, which is what would be lifted if a service were ever genuinely needed — so this is reversible by construction rather than by luck.

One real constraint: because the routes are same-origin, moving to Cloudflare Pages (ADR-003) means moving the data layer too. That is the cost of the alternative, and it is recorded rather than discovered.
