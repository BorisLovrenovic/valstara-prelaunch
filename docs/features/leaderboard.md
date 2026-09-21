# Feature: Leaderboard

## Summary
A public top-10 by confirmed referrals, **cached and anonymised**. It exists to motivate sharing; it carries a credibility exposure in exchange, which is why it is flag-killable and why flagged accounts never appear on it (ADR-024).

## Feature flag
`leaderboard.public` — default on. **Off during a credibility incident**: the section disappears within the cache window with no deploy, and the top-10 block in the weekly email becomes the fallback surface.

## User flows
1. **Snapshot** — a job recomputes the ranked top 10 every 5 minutes into a cached structure. **The public route never runs a live query**; the leaderboard is the one route a viral spike can hammer. Each entry has a deterministic SHA-256-derived display handle; the subscriber UUID is discarded before the snapshot is retained.
2. **Render** — the island shows rank, an anonymised display value and the confirmed count, with a visible "as of" timestamp.
3. **Own position** — a verified visitor arriving from their status link sees their own rank highlighted, computed from the same snapshot.

The snapshot candidates and the internal prize ranking share one integrity
boundary. Only verified subscribers with no active (`open` or `upheld`) fraud
flag are ranked; a dismissed false positive is eligible again. Filtering happens
before ranks are assigned, and neither result carries an exclusion reason or an
excluded-account count.

## Edge cases and error states
Snapshot job stops → **the last good snapshot keeps serving with its timestamp shown.** Stale is acceptable; a live query during a spike is not. Ties → ordered by earliest verification, deterministically, so the board does not shuffle between refreshes. Flagged or disqualified subscribers → **excluded from the snapshot entirely**, not shown greyed. Fewer entries than N → the board renders short; it is never padded. Flag off → `503` from the route with honest copy, and the section is absent from the page rather than broken.

## Acceptance criteria
- [ ] The public route **reads only the cached snapshot** — asserted by a test that fails if the route touches the subscriber table
- [ ] **No email address, country, referral code or exact signup time** appears in the response
- [ ] Flagged and disqualified subscribers are excluded — asserted by test
- [ ] Ties are broken deterministically
- [ ] The **snapshot age is displayed**, and a stale snapshot still serves
- [ ] Turning the flag off removes the section without a deploy — drilled, not assumed
- [ ] **No inflated, offset or manufactured position appears anywhere** — the count shown is the count in the database

## Telemetry
Leaderboard views, share actions from the leaderboard, snapshot age distribution, correlation between board visits and subsequent referral confirmations.
