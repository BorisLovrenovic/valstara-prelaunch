# Data Model

Status: authoritative. PostgreSQL 17, database **`valstara_waitlist`**, on the existing VPS instance — **never tables inside Medusa's database** (ADR-004). Schema changes are forward-only checked-in SQL migrations with a ledger; additive first (`docs/engineering/standards.md`).

**This schema is designed against the launch-day import.** Every field the handoff needs exists from the first migration, so the handoff is a script rather than a modelling exercise. That is the single design constraint that outranks tidiness here.

---

## Conventions

- Primary keys are UUID v7 (time-ordered), generated in the application.
- Timestamps are `timestamptz`, stored UTC, named `*_at`.
- Enumerations are `text` with a `CHECK` constraint, not PostgreSQL enums — a campaign that has to add a state mid-flight should not need a type migration.
- **No column stores a raw IP address.** See *IP handling* below.
- Money does not appear in this schema. There are no payments in pre-launch.

---

## `subscriber`

The waitlist row.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `email` | text; null only when erased | **As entered.** What we display and mail to |
| `email_normalised` | text **unique**; null only when erased | Lowercased, `+tag` stripped, dots removed for Gmail-family domains. **The uniqueness key** |
| `email_domain` | text; null only when erased | Denormalised for blocklist and analytics queries |
| `signup_had_ref` | boolean, default false; null when erased | Whether the initial signup carried a valid signed ref; supports later anonymous source classification even while attribution is flag-off, and is cleared on erasure |
| `status` | text not null | `pending` · `verified` · `expired` · `unsubscribed` · `bounced` · `disqualified` · `erasure_pending` · `erased` |
| `category_preference` | text[] | From the survey. Carried into the handoff |
| `source` | text | Bucketed acquisition source |
| `utm` | jsonb | `source`, `medium`, `campaign`, `content`, `term`; null when none. Captured server-side with the signed referral field; each value is trimmed, control-character-free and capped at 128 characters, with the serialized object capped at 512 bytes. Analytics-only |
| `referral_code` | text unique **nullable** | **Null until verification.** The code is generated when a subscriber verifies, never for a `pending` row — so it cannot be `NOT NULL` (ADR-011, `docs/modules/referral.md`). Founder-authorised 2026-08-26, resolving the E1-03/E4-01 conflict; see E1-03's acceptance criteria |
| `referred_by_id` | uuid null → `subscriber(id)` | Set once at signup; **never reassigned** |
| `referral_tier` | int not null default 0 | **Derived** from settled milestones |
| `confirmed_referrals` | int not null default 0 | **Derived** from `referral_edge`; recomputable |
| `access_window` | text | `wave-1`…`wave-4`. Assigned at verification from tier and verification order; band thresholds are config (ADR-025) |
| `subslush_customer` | boolean not null default false | Provenance. Becomes the `subslush-legacy` group at handoff |
| `giveaway_rules_version` | text | **The global rules version in force when the subscriber first became a giveaway entrant** (E7-03, on first accrual). Written once and never overwritten while active; nulled on erasure. Null until first accrual. Distinct from `giveaway_entry.rules_version`, which stamps each accrual |
| `marketing_consent_at` | timestamptz null | **When the current marketing consent took effect** — at verification for a signup opt-in, or immediately for an opt-in from `/me`. Null means no marketing consent (ADR-027) |
| `marketing_consent_version` | text null | The version of the opt-in wording the person agreed to |
| `marketing_consent_source` | text null | `signup` · `member_status`. `marketing_consent_at`, `_version` and `_source` are all null or all set (check constraint) |
| `marketing_opt_in_pending` | boolean not null default false | The box was ticked at signup and is waiting for verification. **No marketing consent exists until verification confirms it** |
| `marketing_opt_in_pending_version` | text null | The wording version shown at the latest ticked signup while the row is pending. Non-null exactly when `marketing_opt_in_pending` is true; copied to `marketing_consent_version` at verification, then cleared (S-01 founder amendment, 2026-09-25) |
| `signup_ip_prefix_hash` | bytea | See *IP handling*. Purged at 90 days |
| `verified_at` `unsubscribed_at` `expired_at` `disqualified_at` | timestamptz | |
| `disqualification_previous_status` | text null | Status restored only by reversing the flag that disqualified the subscriber |
| `disqualified_by_flag_id` | uuid null → `fraud_flag` | The human-reviewed flag that caused the current disqualification |
| `created_at` `updated_at` | timestamptz; null on erasure | |

Indexes: `email_normalised` (unique) · `referral_code` (unique) ·
`referred_by_id` · `(status, created_at)` ·
`(status, confirmed_referrals desc)` for the leaderboard snapshot ·
`signup_ip_prefix_hash` partial where not null · functional
`split_part(email_normalised, '@', 1)` for bounded duplicate-identity evidence.

**`referral_tier` and `confirmed_referrals` are caches.** `referral_edge` and `milestone_award` are the record. A daily repair job recomputes both idempotently and alerts on any non-zero delta (`docs/architecture/fallbacks.md`).

---

## `verification_token`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `subscriber_id` | uuid not null → `subscriber` | |
| `token_hash` | bytea not null unique | **SHA-256 of the token. The plaintext is never stored** — it exists only in the emailed URL |
| `purpose` | text not null | `verify` · `status` · `unsubscribe` · `dsr_export` · `dsr_delete` |
| `expires_at` | timestamptz not null | |
| `consumed_at` | timestamptz null | Single use. A second consume is a **no-op that reports success** |
| `created_at` | timestamptz not null | |

For `unsubscribe` tokens, E8-01 adds the token-to-`email_send` binding with the token-minting path. The bound send row is the authoritative originating-template source used by E6-06; no caller-controlled value may determine a suppression's `source`.

E8-01 derives verify, status and unsubscribe token plaintext as base64url `HMAC-SHA256(EMAIL_TOKEN_SECRET, token_id)`. The database stores only `SHA-256(token)` and the UUID token ID; the server secret is separate from the IP pepper and never enters the database or logs. This permits retry reconstruction from an ID without persisting plaintext. Rotating the secret invalidates all outstanding tokens; this is an accepted operational cost.

The same table shape backs the signed status link for `/me` with a longer expiry and a `purpose` discriminator (`verify` · `status` · `unsubscribe`), so there is one token lifecycle to reason about rather than three.

`GET /verify?token=` never reads or mutates this table; it renders a confirmation form so mail scanners and prefetchers are inert. Only the token-authenticated `POST /verify` consumes. Invalid and expired posts render identical copy and the same request-new-link control. `src/server/verification/retention.ts` invokes `purgeExpired()` daily through the maintenance scheduler with the shared 1,000-row batch cap, deleting rows 30 days after expiry; failure follows the P1 compliance-alert path.

---

## `referral_edge` — the record referrals are recomputed from

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `referrer_id` | uuid nullable → `subscriber` | Nulled on erasure; when the referrer is erased, both endpoints are nulled so an immutable draw source-edge ID cannot identify the referred person | |
| `referred_id` | uuid nullable → `subscriber` **unique** | **One edge per referred person, forever.** The unique constraint is the anti-fraud primitive |
| `state` | text not null | `attributed` · `confirmed` · `rejected` |
| `reward_state` | text not null | `none` · `settled` · `held` · `void` |
| `rejected_reason` | text null | `self_referral` · `duplicate_identity` · `referrer_disqualified` · `manual` |
| `state_before_rejection` | text null | `attributed` or `confirmed`, retained only for a reversible referrer disqualification |
| `confirmed_at` `created_at` | timestamptz | |

**Cheap rewards settle on confirmation; milestone discounts enter `held` and only settle when any one of the owner's confirmed referred people places a first order within 90 days after store launch** (ADR-012). The pre-launch repository carries export-set owners' held discounts at handoff with that qualification deadline. The storefront owns settlement and deadline-driven voiding. Ineligible owners' discounts and legacy bonus-entry awards are voided with audited reasons at handoff, never deleted.

---

## `milestone_award`

`id` · `subscriber_id` · `tier` int · `reward_kind` (`entries` · `discount` · `wave_upgrade` · `merch`) · `state` (`settled` · `held` · `void`) · `awarded_at`. Unique on `(subscriber_id, tier, reward_kind)`. The historical schema admits `entries`, but the configured ladder creates only a settled wave upgrade and a held discount. E11-06 voids legacy held or settled `entries` rows with an audited reason. The pre-launch repository never settles a held discount; it voids one only when the owner is disqualified or outside the handoff export set.

## `survey_response`

`id` · `subscriber_id` unique · `answers` jsonb · `version` · `created_at` · `first_answered_at` nullable. Answers are validated against a versioned question set; `version` is stored so a mid-campaign question change does not corrupt the earlier answers. `first_answered_at` is set on the first saved answer and is never cleared by a replacement or all-skip submission; it gates the once-per-subscriber `survey_completed` event. E10-03 backfills existing currently answered rows from `created_at`.

## `giveaway_entry`

`id` · `subscriber_id` · `method` (`base` · `referral`) · `entries` int **always 1, enforced by a validated check constraint (E7-04)** · `rules_version` text · `rules_sha256` bytea not null, exactly 32 bytes (added by E7-03) · `source_edge_id` uuid null · `voided_at` · `voided_by_disqualification_flag_id` uuid null → `fraud_flag` · `created_at`. Unique with `NULLS NOT DISTINCT` on `(subscriber_id, method, source_edge_id)` so a retry cannot double-credit when `source_edge_id` is null.

**`rules_version` and `rules_sha256` are stamped at accrual.** There is one global rules page (ADR-026) and no jurisdiction column; S-01 dropped `jurisdiction` and the `amoe` method, because the ordinary verified signup is the free entry route. Entries keep the rules that were in force when they accrued — that is what makes a mid-campaign rules revision survivable (`docs/architecture/fallbacks.md`).

E7-03 accrues one base entry on fresh verification and one referral entry for each confirmed edge while `giveaway.open` is on. The verification transaction also writes the subscriber's first `giveaway_rules_version`; a database trigger rejects any later change to it. The application role may insert entries and update only that subscriber column, with no broad giveaway table write grant.

The 2026-09-26 founder decision makes verification and edge confirmation within the published entry period the entitlement source. A bounded hourly reconciliation and the flag-on action fill missing rows, including events from when `giveaway.open` was off. Backfilled rows stamp the rules revision current when written. Rows verified or confirmed after the close are excluded, and every reconciliation run is audited with counts.

When a human upholds a fraud flag, only that referrer's `referral` entries are
voided and tied to the flag. Reversing that decision restores those entries;
the referred subscribers' entries are never affected.

## `giveaway_draw`

E7-05 records one active draw (`pending` or `published`; an attempt whose target round was already available is retained as `aborted`). The row stores `entry_snapshot_hash`, `snapshot_committed_at`, `snapshot_count`, `prize_count`, the current rules version and hash, drand `chain_hash` and verified chain info, `target_round` and its scheduled time **before** any seed exists. A database advisory lock serialises entry inserts with the snapshot transaction; an entry-insert trigger closes the ledger after the first committed snapshot, including an aborted commitment awaiting a later round. `giveaway_draw_snapshot_row` retains every non-voided ledger row, including its owner, method, source edge, rules version and hash. It is copied in batches of 1,000, hashed in entry-ID order and immutable after commitment, apart from the derived selection score.

After the future round is published, the same draw row stores its verified round number, randomness, signature, optional previous signature, the relay used, both agreeing relays, the derived SHA-256 seed, `seed_generated_at`, ordered winner IDs, `reproduced_at`, and `published_at`. `giveaway_draw_selection` retains **one row per person** in deterministic draw order, with a winner marker for the first `prize_count` rows and all remaining rows as ordered reserves. Positions may have gaps because they follow the sorted entry tickets; their order is authoritative. `attempt_count`, `next_attempt_at`, and `last_alert_at` preserve bounded retry state during a beacon outage. **Publication requires offline signature verification and exact reproduction of the snapshot hash, every entry score, winners and reserves.** No fresh draw or local seed replaces a pending one. Draw records and snapshots are retained for six years under the policy in `docs/legal/compliance.md`.

**E9-05 erasure contract (founder-authorised 2026-10-01):** before commitment, erasure sets the subject's `giveaway_entry.voided_at`, excluding those entries from the snapshot. After commitment, erasure never modifies `giveaway_draw`, `giveaway_draw_snapshot_row` or `giveaway_draw_selection`. Snapshot and selection rows retain only the opaque subscriber ID as the subject reference; no mapping from that ID back to a person may remain after erasure. Their original evidence continues to reproduce exactly, including before publication.

E9-05 creates a separate immutable, append-only draw-void record containing `draw_id`, opaque subscriber ID, reason `erasure`, `voided_at` and actor. Its database permissions and constraints ship with the table under standing rule 19. This appended record records erasure without changing the committed snapshot or selection.

## `giveaway_award`

Created by E7-06. One row per prize: the draw, the current provisional or confirmed winner, the award state (`notified` · `confirmed` · `delivered` · `exhausted`), the winner's **country of residence — the only location data the campaign holds, collected from provisional winners at award time; no postal address, because prizes are delivered electronically** (ADR-026), the delivery timestamp field, the age confirmation, the sanctions-check and Canadian skill-testing outcomes, any substitution, and optional publicity permission. Replaced candidates and their reasons live in the candidate history. Kept 6 years with the draw records.

E7-06 stores one `giveaway_award` row per `(draw_id, prize_slot)`, with a write-protected `entry_snapshot_hash` equal to the published draw's hash and foreign keys to the selected row and entry in that snapshot. The award row records `notified_at` and the Section 9 response deadline. A separate `giveaway_award_candidate` claim is unique on `(draw_id, selection_position)` and records every checked or replaced person, so a reserve cannot be reused for another prize. On failed or missed Section 9 checks the award row moves to the next unclaimed reserve; if none remains it becomes `exhausted`. Passing checks sets `confirmed` and never reassigns the prize for substitution.

`country_of_residence` is a two-letter code and is written only after status-token authentication and a Section 9 check. `substitution_state` is `none`, `offered`, `replacement`, or `cash`. An offer records its own timestamp, configured deadline and an immutable copy of the approved catalog options and values presented to that winner. A replacement stores the selected product IDs and delivered retail value; an explicit decline or offer expiry stores cash equal only to the unavailable products' value in that recorded offer, even if the catalog later changes. Both remain attached to the same confirmed winner. The award and candidate records remain in the six-year manual retention set. No postal address is stored.

**E9-05 retention exception (founder-authorised 2026-10-01):** `giveaway_award` and `giveaway_award_candidate` rows for anyone who reached the award stage are retained unchanged for six years on erasure. This includes country of residence, age confirmation, check outcomes, substitution, values and timestamps. They reference only the opaque subscriber ID, never an email. Every email and other personal field outside this award-record exception is erased, winners included. GDPR Art. 17(3)(b) for sanctions checks and Art. 17(3)(e) for legal claims are the recorded bases in `docs/legal/compliance.md` §2 and `/privacy`.

The award workflow adds candidate reason `erasure`: a current provisional winner who is erased is replaced by the next unclaimed reserve, and erased reserves are skipped when reached. This required replacement changes the candidate outcome through the award workflow; erasure does not scrub the retained evidence. Confirmed or delivered awards are never reassigned and their award data remains intact. Section 9 already covers advancement to the next reserve, so no rules revision is needed.

## `top_twenty_review_batch` and `top_twenty_review`

`top_twenty_review_batch` stores the SHA-256 membership hash for one current top-20 review and an `invalidated_at` timestamp. Only one active batch exists. `top_twenty_review` records one non-empty outcome and its human actor for every member of that batch. The top 20 is calculated directly from non-voided `giveaway_entry` totals, including flagged accounts; it is not the leaderboard snapshot. A changed membership invalidates the active batch and E7-05 must call E5-07's current-review precondition before draw publication.

## `fraud_flag`

`id` · `subscriber_id` · `kind` (`disposable_domain` · `no_mx` · `self_referral` · `duplicate_identity` · `ip_velocity` · `manual` · `challenge_timeout`) · `detail` jsonb · `state` (`open` · `dismissed` · `upheld`) · `reviewed_by` · `reviewed_at` · `created_at`.

**A flag never changes `subscriber.status` by itself.** Only a human upholding a flag can produce a `disqualified` subscriber, and that action is audited.

`duplicate_identity` is raised for a newly inserted subscriber when its
normalised local part matches an existing subscriber on a different email
domain. Its structured evidence records rule name and version, local part,
complete match count and at most 20 matched subscriber IDs. It never rejects a
signup.

**Two kinds are written outside the fraud module.** `challenge_timeout` is
raised by the signup route when Cloudflare Turnstile is unavailable: the signup
is accepted under strict rate limits and the row is flagged (ADR-006;
`fallbacks.md` assigns P1 to a secret configuration fault and P2 to other
unavailable outcomes). `self_referral` is raised by the
referral attribution transaction, which rejects the edge atomically while the
signup still completes (E4-03). The fraud module reviews both like any other
flag but does not raise them. It owns every other kind.

## `domain_allow`

`domain` normalised text primary key · `allowed_by` text not null ·
`created_at` timestamptz not null. This is the durable false-positive override
for the versioned disposable-domain dataset. The application role may select
and insert only; an override is created atomically with an append-only
`fraud.domain_allowed` audit record carrying the required actor. The operator
surface is the E5-01 CLI, not a public or admin HTTP route.

## `email_send`

`id` · `subscriber_id` · `template` · `provider` · `business_key` text **unique** · `payload` jsonb **not null** · `unsubscribe_token_id` uuid foreign key to an unsubscribe-purpose `verification_token` · `provider_message_id` · `state` (`queued` · `sent` · `delivered` · `bounced` · `complained` · `failed`) · `attempts` int · `next_attempt_at` · `expires_at` · `last_error` · `created_at` · `updated_at` · `accepted_at` (set when the provider accepts a send; write-once by trigger and requires a provider message ID; preserved across later webhook updates).

`payload` holds references only, such as `token_id`, `tier` or `award_id`, with a database check rejecting email addresses, token plaintext and copy text. E8-03a extends the check for UUID `status_token_id` and a validated `rules_version` reference. Welcome has `{ status_token_id }`; milestone has `{ tier, status_token_id }`; entry receipt has `{ rules_version, status_token_id }`. The unsubscribe-token foreign key is purpose-checked in the database. E8-01's forward-only migration marks old queued rows that have no reconstructible payload `failed` with `last_error = 'legacy_unrecoverable'` before enforcing the new contract; there is no production data yet.

The unsubscribe binding is unique per send and subject-bound. When the token-retention sweep removes an expired unsubscribe token, a still-queued send becomes failed with `unsubscribe_token_expired`; the reference is then cleared without deleting email history. Dispatch checks token expiry and the current secret before sending, so rotation or an expired link never produces mail with a broken link.

**`business_key` is the idempotency primitive** — e.g. `verify:{subscriber_id}:{token_id}`, `milestone:{subscriber_id}:{tier}`. A retry with the same key never produces a second email.

E8-03a's producer keys are `welcome:{subscriber_id}`, `milestone:{subscriber_id}:{tier}`, and `giveaway-receipt:{subscriber_id}:{rules_version}`. The database uniqueness constraint applies to all three.

E8-07 adds `weekly:{ISO-8601 UTC week}:{subscriber_id}`. Its payload is `{ snapshot_id, status_token_id }`, both UUID references. `expires_at` is the weekly schedule plus 24 hours; dispatch fails an expired row before any provider call. The other templates leave it null.

## `leaderboard_snapshot`

E8-07's persisted source for both the public leaderboard cache and weekly email. `id` UUID primary key · `as_of` timestamptz · `entries` JSONB containing at most ten objects, each with **only** contiguous `rank`, a twelve-character SHA-256-derived `display_handle`, and exact nonnegative `confirmed_referrals`. A database check rejects extra fields, so an address, referral code or signup time cannot enter the row. Maintenance computes it every five minutes regardless of `leaderboard.public`; the web process loads the latest row into its in-process cache. A batch-capped daily sweep purges rows older than 14 days. The email resolves its queued `snapshot_id` on every render, preserving retry content.

## `leaderboard_served_snapshot`

One permissioned singleton pointer to the snapshot ID actually loaded by the web cache. The weekly job selects this ID when starting a run; if the web cache has not started, it selects the latest persisted snapshot. From the scheduled time, the web cache holds the published ID until a run exists; during the remainder of the 24-hour window, it loads the run's fixed ID. Purging a referenced snapshot clears the pointer by foreign key.

## `weekly_campaign_run`

One row per ISO UTC week, holding `state` (`started`, `completed`, `skipped`), the fixed `snapshot_id` for that week's send, `recorded_at` and `alerted_at`. It records missed 24-hour windows and deduplicates the P2 alert across maintenance restarts. The snapshot foreign key clears on the 14-day purge while the run record remains. The audience is selected afresh from verified, unsuppressed, currently marketing-consented subscribers at queue time; dispatch independently re-checks it.
The hourly job also checks up to 12 preceding ISO weeks, back to the first recorded run. If no run exists yet, it uses retained snapshot history to decide whether the previous window was active. Unrecorded expired windows are skipped and alerted; they never queue late mail.

## `email_seed_test`

One internal delivery placement record per `(week_start, provider)` for Gmail,
Outlook, GMX and Web.de. `week_start` is a Monday UTC date; `marker` is a unique
random UUID used only to find that week's message. `placement` is `pending`,
`inbox`, `spam` or `missing`; `sent_at`, `checked_at` and `alerted_at` record
progress. The table contains no recipient address, mailbox credential, message
body or subscriber reference. App-role writes are limited to the placement and
timestamp fields; the provider and marker are immutable after insert.

## `email_broadcast_seed_test`

One Brevo broadcast MIME inspection record per `(week_start, provider)` for the
same four seed mailboxes. It stores a random marker, send/check/alert timestamps,
and one state: `pending`, `passed`, `missing_plain_part`, `tracking_pixel`,
`rewritten_link` or `missing`. It stores no mailbox address, MIME source or
subscriber data. This internal probe runs before customer broadcasts are enabled.

## `email_quota_alert`

One deduplication record per provider, UTC day and severity. It stores only the provider (`resend` or `brevo`), date, alert severity (`P1` or `P2`) and alert timestamp. The quota health query aggregates `email_send.accepted_at` and the two seed tables' `sent_at` timestamps by UTC day. No address or subscriber identifier enters this table.

## `brevo_contact_sync`

`email_normalised` is the primary key and a foreign key to `subscriber`;
`email`, `listed` and `synced_at` record the last **successfully applied** Brevo
broadcast-list state. The table is a retry cache, not the consent authority.
The authoritative eligibility query joins `subscriber` to `suppression` and
requires verified status plus current marketing consent. A provider failure
leaves this row unchanged so the next bounded batch resumes the contact.

## `suppression`

`email_normalised` pk · `reason` (`unsubscribe` · `bounce_hard` · `complaint` · `manual`) · `source` · `created_at`. **Checked at dispatch, not only at queue time** — a suppression written after queueing must still stop the send.

E8-06 adds `email_webhook_event`, whose sole column is an opaque idempotency key, and bounded reconciliation cursors. Resend uses its Svix event ID; Brevo stores SHA-256 of provider, message ID and event. No webhook payload, address or provider timestamp is persisted there. Authenticated bounce and complaint events write suppression and update matching `email_send` state in one transaction. Resend missing-terminal-event gap detection stamps a sent row once for one aggregated P2 task; `delivered` counts as terminal for gap detection but can later be followed by a complaint.

## `campaign_flag`

`key` pk · `enabled` boolean · `updated_at` · `updated_by`. The database value is an **override**; the code-registered default is the fallback (ADR-023).

## `audit_log`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `at` | timestamptz not null | |
| `actor` | text not null | |
| `action` | text not null | From the registered action set below |
| `subject_type` | text not null | Discriminates what `subject_id` refers to |
| `subject_id` | **text null** | **Text, not uuid — the subject is polymorphic.** A subscriber is a UUID, a flag is a key like `leaderboard.public`, and an export has no natural subject at all. `subject_type` says which. Nullable for the same reason |
| `detail` | jsonb | |
| `request_id` | text | |

**Append-only, enforced by database permissions** — the application role holds `INSERT` and `SELECT` only. Records: disqualifications, flag decisions, exports, draw execution, flag changes, DSR requests and their fulfilment, and the handoff freeze. **`detail` never contains a token, a secret or a full IP address**; a redaction test asserts this over every call site.

E6-06 also records `consent.marketing_withdrawn` or `subscriber.unsubscribed` with the originating `email_send` ID and server-resolved template for email links, or source `member_status` for the `/me` leave action. Token consumption, preference or suppression write, an explicit leave's `status = 'unsubscribed'` and `unsubscribed_at` stamp, and the audit insert share one transaction.

## `rate_limit_bucket`

`key` pk (hashed IP prefix or normalised email + route) · `window_start` · `count`. `src/server/ratelimit/retention.ts` deletes buckets older than seven days once per UTC day through the maintenance scheduler. Each run is batch-capped; a failed run raises the compliance-alert path.

## `purge_job_run`

One row per scheduled purge job. `job_key` text primary key with a finite CHECK over `ip_prefix_retention` (the fraud IP-prefix retention job), `rate_limit_retention`, `verification_token_retention` (verification and status tokens), and `leaderboard_snapshot_purge`. `last_started_at` · nullable `last_finished_at` · nullable `last_succeeded_at` · nullable `last_outcome` (`succeeded` or `failed`) · `rows_purged` integer at least zero · nullable sanitized `last_error_code`. No personal data. Each job upserts at start and finish; a record-write failure cannot fail the purge. The application role has SELECT, INSERT and UPDATE, never DELETE. Health treats a missing success as stale and a daily job's last success as stale only after 48 hours. The clock is injected. The subscriber expiry sweep changes status and is not a purge job.

## `migration_ledger`

`filename` pk · `applied_at` · `checksum` · `applied_by_release`. **A checksum mismatch on an already-applied migration aborts the deploy** — an edited migration is a defect, not a difference to tolerate.

---

## IP handling

The site needs IP-derived signals for velocity flags and rate limiting, and IP addresses are personal data. The resolution:

- **Truncate first** — IPv4 to /24, IPv6 to /64 — then hash with a **server-side pepper held outside the database**. Only `signup_ip_prefix_hash` is stored.
- **A full IP address is never written** to any table, log line or analytics event.
- **Purge stored subscriber prefix hashes at 90 days**, by a daily job. Rate-limit buckets have the shorter seven-day retention in the summary below. A failure of either job is a **compliance alert**, not a hygiene one.
- Velocity review uses optional `IP_VELOCITY_WINDOW_MINUTES` (default `60`) and `IP_VELOCITY_THRESHOLD` (default `10`) configuration. Reaching the threshold raises an `ip_velocity` flag only.
- The purpose (fraud prevention on a prize giveaway) and the retention period are stated in the privacy policy. `docs/legal/compliance.md` carries the lawful-basis reasoning.

The pepper is a secret with a handling procedure of its own: rotating it invalidates every existing prefix hash, which is acceptable, but it must be done deliberately and recorded.

---

## Retention summary

**E9-05 backup and processor contract (founder-authorised 2026-10-02):** stop processing immediately, remove the local Brevo contact cache, and erase live personal data including `suppression` after Brevo confirms deletion. A new signup must complete double opt-in again. Brevo contact deletion uses DELETE by `ext_id`, with bounded retries, 404 as success and a P1 operator task after seven days. Completion requires Brevo confirmation. Resend has no deletion call and its sending-only key is unchanged. Both providers' delivery logs expire under processor retention.

E9-05 creates an append-only erasure ledger whose only fields are opaque subscriber ID and `erased_at`; no email or other personal data is allowed. Permissions and constraints ship with the table. The idempotent, batch-capped re-apply command processes every ledger ID, including against a restored database where the subject is still present. No restored database serves traffic until the newest available ledger has been applied. E12-04 owns the scheduled off-host ledger copy to R2.

Existing pgBackRest backups are unmodified, encrypted and beyond use, never read for ordinary processing, and expire through weekly full backup rotation with `retention-full=2`. The disclosed window is **up to 30 days**. Backup expiry and processor delivery-log retention are the only additions to the 2026-10-01 award-record exception.

| Data | Retention | Mechanism |
|---|---|---|
| `signup_ip_prefix_hash` | 90 days | Daily purge job |
| Unverified `pending` subscribers | Campaign-configured horizon (default 30 days) | Daily expiry sweep → `expired` |
| Verification and status tokens | Purged 30 days after expiry | Daily, 1,000-row-capped sweep; P1 on failure |
| `rate_limit_bucket` | 7 days | Daily cleanup |
| Personal data in existing encrypted backups after erasure | Up to 30 days, beyond use | Weekly full backup rotation, `retention-full=2`; re-apply newest erasure ledger before restored traffic |
| Provider delivery logs after erasure | Limited period under processor retention | Resend and Brevo processor expiry; no Resend deletion call |
| The public giveaway rules page | 12 months after the final award, then `410` (Valstara policy, not a statute) | Manual, checklisted |
| Every rules revision, entry snapshot, seed, reserve list and award record | 6 years internally (Valstara policy) | Manual, checklisted |
| Marketing-consent evidence | While consent is relied on, plus the evidential period after withdrawal | Audit log |
| The whole database after handoff | **Read-only for 90 days as the audit trail**, then reviewed for deletion | ADR-022 |
| Everything else | Until handoff, then per the storefront's policy | — |

---

## The launch-day handoff contract

This is what the schema exists to make trivial. Prelaunch owns the export and the rehearsal; the Medusa-side import lives in the storefront repository.

**Export set:** subscribers where `status = 'verified'`, not present in `suppression`, and not `disqualified`.

**Per-row payload:**

| Field | Becomes |
|---|---|
| `email` (raw) | The customer email |
| `email_normalised` | **The idempotency key for the import** |
| `referral_tier`, `referral_code`, `confirmed_referrals` | Customer metadata |
| `category_preference`, `source` | Customer metadata |
| `marketing_consent_at`, `marketing_consent_version`, `marketing_consent_source` | Customer metadata. **The storefront may send marketing only where consent is present** (ADR-027) |
| `access_window` | Customer metadata **and** the customer group |
| `subslush_customer` | The `subslush-legacy` group |

**E10-04 admin CSV encoding.** `GET /api/admin/export.csv` emits exactly the twelve fields above, in table order, with a header row and CRLF line endings. It uses standard CSV quoting for commas, quotes and line breaks. Nullable fields are empty cells; a present `category_preference` is a JSON array inside one CSV cell, so `[]` remains distinct from null. `marketing_consent_at` is RFC 3339 UTC, booleans are lowercase `true`/`false`, and integer counts remain decimal integers. The export is a snapshot of the verified, unsuppressed set; the later E11-06 cutover export and import rehearsal own the launch-day handoff procedure.

**Held-discount handoff payload (E11-06):** each held `milestone_award` with `reward_kind = 'discount'` whose owner is in the customer export set is exported separately with `award_id` and `subscriber_id` UUIDs, owner `email_normalised` as the storefront import key, `tier` integer, `discount_percent` integer from the configured tier, `state = 'held'`, `outcome = 'carried_to_storefront'`, and `qualification_deadline` as an RFC 3339 UTC instant exactly 90 days after the supplied store-launch instant. The store-launch instant is a required handoff parameter, never a code literal. Each carried outcome and deadline is audited against the award ID. A disqualified owner's held discount becomes `void` with audited reason `owner_disqualified`; a suppressed or departed owner's becomes `void` with audited reason `owner_not_in_handoff`. Both are excluded from export and never deleted. An erased owner has no award to export under E9-05. A marketing-withdrawn owner who remains verified and unsuppressed is carried normally. No bonus-entry reward is exported. Any historical bonus-entry award still `held` or `settled` is voided in bounded batches with an audited reason before export.

**Confirmed-referral handoff payload (E11-06):** `confirmed_referral` records carry exactly `referrer_email_normalised` and `referred_email_normalised`. An edge is exported only if its state is `confirmed` and both endpoints belong to the verified, unsuppressed customer export set. The storefront imports each pair idempotently by its two normalised emails, then settles an owner's held discount when **any one** of that owner's exported confirmed referred people places a first order before `qualification_deadline`. The storefront voids still-held discounts after the deadline. No pre-launch path settles them or reads or writes Medusa.

**Sequence:** freeze writes → pgBackRest snapshot → export → idempotent import keyed on `email_normalised` → `createCustomersWorkflow` with metadata → assign customer groups `wave-1`…`wave-4` and `subslush-legacy` → transfer eligible held-discount records and confirmed referral pairs for storefront qualification → set the waitlist database read-only for 90 days. The storefront issues a held discount only after its qualifying first-order condition is met.

**Groups, not metadata, are what promotions and price lists target.** Metadata carries provenance; the group carries the access it grants. Both are written, and the group assignment is the one the store actually uses.

**Rehearsed twice against a scratch database before launch day** (E11-06). A rehearsal that is not idempotent — running it twice produces duplicate customers — is a blocking finding.

## E9-05 erasure and export structures

The final 2026-10-02 founder decision supersedes immediate local erasure and the earlier P2 failure path. The pending state preserves the original subscriber identity until Brevo DELETE by `ext_id` succeeds or returns 404. Nothing copies that identifier into retry metadata. Pending subjects are excluded from mail, sync upserts, `/me`, leaderboard and draw/award/entry eligibility. The status cannot return to active processing. A deferred database constraint requires pending-request evidence and requires an erasure-ledger entry for an erased row. The erasure transaction nulls identifying subscriber fields and referral endpoints, removes survey, milestone, email and token records, scrubs fraud evidence, deletes suppression and the Brevo cache, and clears related rate buckets. Existing confirmed edges remain countable for their surviving referrer. Immutable audit records retain only their opaque links and redacted evidence; award/candidate evidence is the explicit six-year exception.

### `dsr_erasure`

`subscriber_id` UUID primary key and subscriber foreign key · `requested_at` not-null timestamp · `attempts` nonnegative integer, default 0 · `next_attempt_at` not-null timestamp at or after request · nullable `escalated_at`, `deadline_alerted_at`, `completed_at`. A partial due index covers unfinished requests. The application may SELECT, INSERT and update only retry/completion fields. No email or encrypted identifier is stored. Completion is atomic with local erasure and audit. Retry delay starts at one minute and caps at one hour. Seven-day expiry raises P1; day-28 and subsequent daily P1 alerts protect the 30-day hard deadline. The operator completion CLI records its human actor.

### `erasure_ledger`

`subscriber_id` UUID primary key · `erased_at` not-null timestamp, and no other fields. SELECT/INSERT only for the application; UPDATE/DELETE are also rejected by an immutability trigger. No foreign key requires the subject to exist in a restored database. Re-application imports the newest available ledger and processes all IDs in bounded batches, idempotently. E12-04 owns its scheduled off-host copy.

### `giveaway_draw_void`

`draw_id` UUID foreign key · `subscriber_id` opaque UUID · `reason` constrained to `erasure` · `voided_at` not-null timestamp · nonempty `actor`. Primary key `(draw_id, subscriber_id)`. A trigger requires a committed snapshot row for that subject. The application has SELECT/INSERT only; UPDATE/DELETE are rejected by an immutability trigger. Original draw/snapshot/selection evidence remains unchanged. Award candidate reasons now also accept `erasure`.

### Export coverage

`src/server/db/dsr-export.ts` registers subject-scoped tables. Every row includes every column through `to_jsonb`, reconciled against the model and schema by test. Referral counterparts, other winners, operator identities and third-party fraud evidence are redacted. NDJSON is streamed in 100-row pages under a repeatable-read transaction, with a fulfilment audit at successful completion. DSR tokens use distinct `dsr_export` and `dsr_delete` purposes with a 24-hour lifetime. An export replay is acknowledged without exporting again; invalid/expired links use one response. No plaintext token is persisted.
