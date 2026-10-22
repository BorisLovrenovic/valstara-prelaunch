# Feature: Leaderboard

## Summary
A public top-10 by confirmed referrals, **cached and anonymised**. It exists to motivate sharing; it carries a credibility exposure in exchange, which is why it is flag-killable and why flagged accounts never appear on it (ADR-024).

## Feature flag
`leaderboard.public` — default on. **Off during a credibility incident**: the section disappears within the cache window with no deploy, and the top-10 block in the weekly email becomes the fallback surface.

## User flows
1. **Snapshot** — a job recomputes the ranked top 10 every 5 minutes into a cached structure. **The public route never runs a live query**; the leaderboard is the one route a viral spike can hammer. Each entry has a deterministic SHA-256-derived display handle; the subscriber UUID is discarded before the snapshot is retained.

**E8-07 shared snapshot (founder-authorised 2026-09-30):** Maintenance now writes each five-minute computation to `leaderboard_snapshot` regardless of `leaderboard.public`. The web process loads a persisted row into its in-process cache and publishes the ID it serves; the public route still reads only that cache. If publication fails at commit, the cache returns to the previously served row before the publication lock is released, so weekly selection sees that same row. The row contains its ID, timestamp and anonymised rank, handle and exact confirmed count only. From the scheduled time, the site holds its published ID until the weekly run records that ID; then it holds the run's ID through the send window. The weekly email queues the published ID (or the latest row if the web cache has not started). Retries render the same persisted entries even while the public flag is off. A daily capped sweep removes rows older than 14 days.
2. **Render** — the island shows rank, an anonymised display value and the confirmed count, with a visible "as of" timestamp. Its live polls bypass the browser's HTTP cache so a response cached before a flag change cannot delay the kill switch by another polling interval.

**E11.5-08 page design.** The page renders the snapshot as a ranked list: rank, display handle and exact count, with the rank and count figures in mono tabular figures, and the snapshot time and age. Beside it, two lines say what counts (only referrals who verified; exact counts, anonymous handles) and a call to action links to `/#join`. For people already on the list, the call to action is a plain line pointing to the status link in their emails, not a link to `/me`: the member page authenticates only with that signed link, and a bare `/me` would be a dead end. All of it sits inside the flagged section, so the kill switch removes the whole surface, as before. The list renders exactly the snapshot's rows and is never padded.

The public leaderboard never identifies its visitor and never reads or validates a `status` token. **Founder-authorised 2026-09-21:** own-rank moved to `/me`; E6-04 authenticates the bearer and E6-05 computes the subscriber's rank server-side through the shared referral-status computation, independently of this snapshot and of `leaderboard.public`.

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
