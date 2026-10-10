# Feature: Legal pages and data-subject rights

## Summary
`/terms`, `/privacy` and `/giveaway/rules` (with immutable `/giveaway/rules/<rules_version>` revisions) at their permanent URLs, plus working export and erasure. ADR-029 records the founder's decision not to appoint EU or UK Article 27 representatives and removes the former representative gate.

## Feature flag
None.

## User flows
1. **Privacy policy** — what is collected, why, the lawful basis, retention periods, and how to exercise rights. It states the ADR-027 split plainly: joining and entering run on contract, marketing on separate optional consent, and withdrawing marketing never affects the waitlist or entries. It also says that only a country of residence is collected from provisional winners, at award time; no postal address is collected (ADR-026). E9-03 embeds the two-entry browser-storage inventory in this page: Valstara's theme preference and Cloudflare Turnstile's protected-form `cf.turnstile.u` value (founder-authorised 2026-10-10). E9-04 publishes the same inventory and no-banner reasoning at `/privacy/storage`, linked from the policy. Valstara's source-code gate still permits only the theme write.
2. **Terms** — site terms for a pre-launch waitlist. Distinct from the store's terms, which are the storefront's.
3. **Giveaway rules** — **one global page under Hong Kong law** at `/giveaway/rules` (ADR-026), carrying every section listed in `docs/legal/compliance.md#4`, including the disqualification rule and the promoter's identity.

The rules source is a versioned Markdown file in `src/content/giveaway-rules/`. Its frontmatter records the `rulesVersion`, prize values, conservative USD/EUR conversion assumption and SHA-256 of the rendered rules article. The build checks all required sections, statements, prize limits and the hash. `/giveaway/rules` serves the latest published revision; `/giveaway/rules/<rules_version>` keeps each published revision at its permanent URL. New revisions are appended as new files, while CI rejects edits or deletion of files already present on the base branch. The server's `currentRules()` reads that same validated collection for the entry ledger.

**Founder-authorised 2026-10-09:** `VAL-GW-LAUNCH-20261009-r1` is current. It removes only the superseded representative sentence from the 2026-10-01 text. The two older files remain unchanged. Every superseded URL remains reachable and self-canonical, with the approved archive notice outside its hashed article, `noindex`, and no sitemap entry. The current URL and current revision's permanent URL have no archive notice and remain indexable.
4. **Rights** — a request from `/me` or by email triggers a signed confirmation link; export returns the subject's data, erasure removes it.

## Content sourcing — a named dependency
The founder waived the representative prerequisite and authorised temporary draft text for `/terms` and `/privacy` on 2026-10-01 (ADR-029). Reviewed replacement wording remains a founder input. The draft status is visible on each page and must be addressed in the E11-05 privacy audit.

## Edge cases and error states
Erasure requested for a subscriber with referral edges → **anonymise rather than drop.** The edge survives with its subject nulled, so counts stay defensible. Erasure leaves no personal data outside the documented award-record retention. Export requested for an unknown address → the same response as for a known one. Rules revised → a new immutable revision at its own URL; the old one is never overwritten. Public retention elapsed (12 months after the final award) → return `410`, not `404`, and not a silent delete; the revisions stay in the internal record for 6 years.

**Founder-authorised 2026-10-01 (E9-05):** erasure removes everyone's email and other personal fields, including winners', except `giveaway_award` and `giveaway_award_candidate` records for anyone who reached the award stage. Those records remain unchanged for six years, including country of residence, age confirmation, check outcomes, substitution, values and timestamps, and reference only the opaque subscriber ID, never an email. GDPR Art. 17(3)(b) (sanctions checks) and Art. 17(3)(e) (legal claims) are the recorded bases; `/privacy` discloses this exception. Draw snapshot and selection rows retain only the opaque subscriber ID as the subject reference, with no remaining mapping to a person.

Erasure before snapshot commitment voids the subject's ledger entries (`giveaway_entry.voided_at`), so the snapshot excludes them. Erasure after commitment never changes the draw, snapshot rows or selection: **an immutable, append-only void record** stores the draw ID, opaque subscriber ID, reason `erasure`, void timestamp and actor. Reproduction and publication must still pass exactly. A current provisional winner is replaced from the next unclaimed reserve with candidate reason `erasure`; erased reserves are skipped. Confirmed and delivered awards are never reassigned, and their award records remain intact. The provisional replacement follows the award workflow while retaining its evidence. No rules revision is needed because Section 9 already advances to the next reserve when a winner cannot receive the prize.

## Acceptance criteria

**Founder-authorised 2026-10-02:** processing stops immediately; local erasure, including suppression, waits for Brevo contact deletion by `ext_id` (not list unlinking). Brevo confirmation or 404 completes the provider step; bounded retries run for up to seven days, then raise a P1 operator task with only the opaque subscriber ID. No Resend deletion call or broader key is added. The only additional retention exceptions are provider delivery logs under processor retention and encrypted backups beyond use for up to 30 days. Backups rotate normally (weekly full, `retention-full=2`). An append-only ledger of opaque subscriber IDs and erasure timestamps, with database permissions and constraints, supports an idempotent, batch-capped restore re-apply command. A restored database cannot serve traffic until the newest available ledger has been re-applied. The scheduled off-host ledger copy belongs to E12-04.
- [ ] `/terms` and `/privacy` exist at their **permanent URLs** with content-file prose
- [ ] Neither legal page implies an appointed EU or UK representative
- [ ] The signup route has no representative-dependent gate
- [ ] Every collected field, its purpose, its lawful basis and its retention period appears in the policy — reconciled against `docs/data/model.md` by a test
- [ ] Export returns the subject's complete data within the statutory window, audited
- [ ] Erasure **anonymises referral edges rather than dropping them**, preserves counts, and leaves no personal data outside the documented award-record retention
- [ ] An erased winner retains the intact award record, with no email or other personal field remaining outside that exception
- [ ] Erasure before commitment excludes the entries; erasure after commitment appends a constrained, permissioned, append-only void record and preserves exact reproduction and publication
- [ ] An erased provisional winner is replaced by the next unclaimed reserve, erased reserves are skipped, and confirmed or delivered awards are not reassigned
- [ ] Suppression is erased; re-signup requires double opt-in, and the absence-of-personal-data assertion covers suppression and the Brevo deletion call
- [ ] Brevo deletion succeeds, retries boundedly, accepts 404 and raises a P1 operator task after seven days; erasure is not complete before provider confirmation
- [ ] The append-only erasure ledger contains only opaque subscriber ID and `erased_at`, with database-enforced permissions and constraints
- [ ] Restore re-application erases a still-present subject and is idempotent; the runbook prohibits traffic until the newest available ledger has been applied
- [ ] `/privacy` discloses limited processor delivery-log retention and the backup window of up to 30 days
- [ ] The global rules page carries every required section — schema-validated — and every revision is immutable at its versioned URL

## Telemetry
Policy page views, DSR request volume and fulfilment time, rules-page views.

## E9-05 implemented contract

The final founder decision of 2026-10-02 supersedes immediate local erasure and the earlier P2 fallback: processing stops on signed confirmation, while local erasure waits for Brevo success/404. `erasure_pending` and the permissioned `dsr_erasure` row are written with the request audit. No retry identifier is copied; the original subscriber address supplies DELETE by `ext_id`. The worker resumes after restart, backs off up to one hour for seven days, then raises P1 with only the opaque ID. An operator completes after manual dashboard deletion through `scripts/complete-erasure.ts --subscriber-id <uuid> --actor <operator>`. P1 alerts repeat from day 28 ahead of the 30-day hard deadline. Fulfilment, suppression deletion and append-only ledger insertion share one transaction and an audit failure rolls them all back.

`/dsr` provides the email request and non-mutating signed-link confirmation pages; `/me` links to both operations. Request POSTs use Turnstile first and hashed-prefix limits. A storage failure raises a sanitized P1 while known and unknown addresses retain the same bounded acknowledgement. Confirmation POSTs consume a purpose-bound token first and apply the IP limit on every outcome before responding; valid tokens also receive a subject limit before fulfilment. `dsr_export` and `dsr_delete` tokens expire after 24 hours; request a fresh link after expiry. A replay never repeats fulfilment. The export is NDJSON, streamed in 100-row pages under a consistent transaction; all subject table columns are included, with third-party identities redacted. Duplicate-identity flags that list the subject among matched subscribers are included with other subscribers' IDs redacted. Cancellation or an export error rolls back consumption and fulfilment audit.

Pending subjects receive no queued or dispatched email, no Brevo upsert, no `/me` access and no leaderboard, entry or award eligibility. Existing stored snapshots and the web cache are redacted; a trigger prevents stale computations from reintroducing the subject. Public leaderboard responses are `no-store`. Erasure after snapshot commitment appends `giveaway_draw_void`, and committed review evidence remains the publication reference. `scripts/reapply-erasures.ts --ledger-file <newest-ledger.jsonl> --actor <operator>` imports the newest available ledger and re-applies every recorded opaque ID without contacting a provider.
