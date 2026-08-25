# ADR-004: A separate `valstara_waitlist` PostgreSQL database

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
The waitlist needs durable storage months before the store opens. Medusa's production database exists on the same instance.

## Decision
**Its own database, `valstara_waitlist`, on the existing PostgreSQL 17 instance** — never tables inside Medusa's. Same instance is preferred; a different host you control is fine.

**The schema is designed against the launch-day import from the first migration** (`docs/data/model.md`), so the handoff is a script rather than a modelling exercise.

## Alternatives rejected
- **Tables inside Medusa's database** — four independent reasons, each sufficient: schema churn from `db:migrate`, auth-identity pollution, a public writer pointed at the commerce database months before hardening, and a model mismatch, since referral edges, milestone state and fraud flags are not customer attributes.
- **A different provider (Neon, Supabase)** — works, and adds a DPA, a vendor and a separate backup story for no benefit.

## Consequences
Launch-day import is a local script, one connection away, and the database is already covered by the VPS's pgBackRest arrangement. The waitlist can be schema-churned freely during the campaign without touching commerce. **The handoff is a deliberate, rehearsed operation** (ADR-021, ADR-022) rather than a query across two schemas.
