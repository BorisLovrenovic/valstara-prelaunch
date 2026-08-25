# ADR-011: Double opt-in, unconditional

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
A single-opt-in list is larger and worthless: it contains typos, bot rows and addresses whose owners never asked, and broadcasting to it destroys the sending reputation the campaign depends on.

## Decision
**Every signup is verified by a single-use, hashed, expiring emailed token before it counts as anything.** No flag. It cannot be switched off.

**Nothing counts an unverified row** — not the leaderboard, not a referral tier, not a giveaway entry, not the broadcast list, not the export.

The verification record is also **the consent record** (`docs/legal/compliance.md`): the timestamp, the token consumed and the address it went to are what make consent demonstrable rather than asserted.

## Alternatives rejected
- **Single opt-in** — larger number, worse list, and it puts the sending reputation at risk on the first broadcast.
- **Optional verification** — the same as single opt-in with extra code.
- **Verification only before the giveaway** — creates an unverified population that has already been counted, ranked and shown a position, which cannot be walked back honestly.

## Consequences
The reported list is smaller than the signup count, and that gap is a real metric worth watching rather than a number to hide.

**It creates the campaign's most dangerous silent failure**: if verification mail stops arriving, the site looks like it simply is not converting. That is why verification *rate* is alerted on hourly, why seed tests run weekly, and why the providers are split (ADR-009).

Unverified rows have a **defined expiry and fallback** — reminders at +1h, +24h and +72h, then expiry.
