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
| `email` | text not null | **As entered.** What we display and mail to |
| `email_normalised` | text not null **unique** | Lowercased, `+tag` stripped, dots removed for Gmail-family domains. **The uniqueness key** |
| `email_domain` | text not null | Denormalised for blocklist and analytics queries |
| `status` | text not null | `pending` · `verified` · `expired` · `unsubscribed` · `bounced` · `disqualified` |
| `country` | char(2) | ISO 3166-1 alpha-2. **Confirmed by the person**, never by detection |
| `country_detected` | char(2) | Reserved for the `CF-IPCountry` suggestion at signup — diagnostic only, never drives eligibility. **Unpopulated as of E3-04**: the geo module (`src/server/geo`) returns the suggestion for prefill only, and no ticket yet stamps it onto the row. Column exists from E1-03 so a later ticket can write it additively |
| `region` | text | Only collected where it changes eligibility — currently Canada, for Quebec (ADR-018) |
| `category_preference` | text[] | From the survey. Carried into the handoff |
| `source` | text | Bucketed acquisition source |
| `utm` | jsonb | `source`, `medium`, `campaign`, `content`, `term`; null when none. Captured server-side with the signed referral field; each value is trimmed, control-character-free and capped at 128 characters, with the serialized object capped at 512 bytes. Analytics-only |
| `referral_code` | text unique **nullable** | **Null until verification.** The code is generated when a subscriber verifies, never for a `pending` row — so it cannot be `NOT NULL` (ADR-011, `docs/modules/referral.md`). Founder-authorised 2026-08-26, resolving the E1-03/E4-01 conflict; see E1-03's acceptance criteria |
| `referred_by_id` | uuid null → `subscriber(id)` | Set once at signup; **never reassigned** |
| `referral_tier` | int not null default 0 | **Derived** from settled milestones |
| `confirmed_referrals` | int not null default 0 | **Derived** from `referral_edge`; recomputable |
| `access_window` | text | `wave-1`…`wave-4`. Assigned at verification from tier and verification order; band thresholds are config (ADR-025) |
| `subslush_customer` | boolean not null default false | Provenance. Becomes the `subslush-legacy` group at handoff |
| `giveaway_eligible` | boolean | Decided **at signup** against the rules version then in force |
| `giveaway_rules_version` | text | **The rules version that decided `giveaway_eligible`.** Written with it at signup, so an eligibility decision stays explainable after the rules change. Distinct from `giveaway_entry.rules_version`, which stamps each accrual |
| `signup_ip_prefix_hash` | bytea | See *IP handling*. Purged at 90 days |
| `verified_at` `unsubscribed_at` `expired_at` `disqualified_at` | timestamptz | |
| `disqualification_previous_status` | text null | Status restored only by reversing the flag that disqualified the subscriber |
| `disqualified_by_flag_id` | uuid null → `fraud_flag` | The human-reviewed flag that caused the current disqualification |
| `created_at` `updated_at` | timestamptz not null | |

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
| `purpose` | text not null | `verify` · `status` · `unsubscribe` |
| `expires_at` | timestamptz not null | |
| `consumed_at` | timestamptz null | Single use. A second consume is a **no-op that reports success** |
| `created_at` | timestamptz not null | |

For `unsubscribe` tokens, E8-01 adds the token-to-`email_send` binding with the token-minting path. The bound send row is the authoritative originating-template source used by E6-06; no caller-controlled value may determine a suppression's `source`.

The same table shape backs the signed status link for `/me` with a longer expiry and a `purpose` discriminator (`verify` · `status` · `unsubscribe`), so there is one token lifecycle to reason about rather than three.

`GET /verify?token=` never reads or mutates this table; it renders a confirmation form so mail scanners and prefetchers are inert. Only the token-authenticated `POST /verify` consumes. Invalid and expired posts render identical copy and the same request-new-link control. `src/server/verification/retention.ts` invokes `purgeExpired()` daily through the maintenance scheduler with the shared 1,000-row batch cap, deleting rows 30 days after expiry; failure follows the P1 compliance-alert path.

---

## `referral_edge` — the record referrals are recomputed from

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `referrer_id` | uuid not null → `subscriber` | |
| `referred_id` | uuid not null → `subscriber` **unique** | **One edge per referred person, forever.** The unique constraint is the anti-fraud primitive |
| `state` | text not null | `attributed` · `confirmed` · `rejected` |
| `reward_state` | text not null | `none` · `settled` · `held` · `void` |
| `rejected_reason` | text null | `self_referral` · `duplicate_identity` · `referrer_disqualified` · `manual` |
| `state_before_rejection` | text null | `attributed` or `confirmed`, retained only for a reversible referrer disqualification |
| `confirmed_at` `created_at` | timestamptz | |

**Cheap rewards settle on confirmation; high-value rewards enter `held` and only settle on a post-launch first order** (ADR-012). The pre-launch repository implements the confirmation hold and campaign-close `void` transitions; the storefront owns first-order settlement after handoff. `held` reward records that never qualify become `void` at campaign close — recorded, not deleted, because the rule was published and must be checkable afterwards.

---

## `milestone_award`

`id` · `subscriber_id` · `tier` int · `reward_kind` (`entries` · `discount` · `wave_upgrade` · `merch`) · `state` (`settled` · `held` · `void`) · `awarded_at`. Unique on `(subscriber_id, tier, reward_kind)` — each configured reward kind is awarded once while one tier can durably hold its settled wave upgrade, held discount and held bonus-entry rows. E4-06 may transition `held` rows to `void` at campaign close; it never transitions them to `settled`.

## `survey_response`

`id` · `subscriber_id` unique · `answers` jsonb · `created_at`. Answers are validated against a versioned question set; `version` is stored so a mid-campaign question change does not corrupt the earlier answers.

## `giveaway_entry`

`id` · `subscriber_id` · `method` (`base` · `referral` · `amoe`) · `entries` int · `jurisdiction` char(2) · `rules_version` text · `source_edge_id` uuid null · `voided_at` · `voided_by_disqualification_flag_id` uuid null → `fraud_flag` · `created_at`. Unique with `NULLS NOT DISTINCT` on `(subscriber_id, method, source_edge_id)` so a retry cannot double-credit when `source_edge_id` is null.

**`rules_version` is stamped at accrual.** Entries keep the rules that were in force when they accrued — that is what makes a mid-campaign rules change survivable (`docs/architecture/fallbacks.md`).

When a human upholds a fraud flag, only that referrer's `referral` entries are
voided and tied to the flag. Reversing that decision restores those entries;
the referred subscribers' entries are never affected.

## `giveaway_draw`

`id` · `executed_at` · `seed` text · `entry_snapshot_hash` bytea · `winners` jsonb · `executed_by` · `reproduced_at`. **A draw is not published until it reproduces from its recorded seed and snapshot hash.**

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
raised by the signup route when Cloudflare Turnstile is unreachable: the signup
is accepted under strict rate limits and the row is flagged (ADR-006,
`fallbacks.md` "Turnstile unavailable" → P2). `self_referral` is raised by the
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

`id` · `subscriber_id` · `template` · `provider` · `business_key` text **unique** · `provider_message_id` · `state` (`queued` · `sent` · `delivered` · `bounced` · `complained` · `failed`) · `attempts` int · `last_error` · `created_at` · `updated_at`.

**`business_key` is the idempotency primitive** — e.g. `verify:{subscriber_id}:{token_id}`, `milestone:{subscriber_id}:{tier}`. A retry with the same key never produces a second email.

## `suppression`

`email_normalised` pk · `reason` (`unsubscribe` · `bounce_hard` · `complaint` · `manual`) · `source` · `created_at`. **Checked at dispatch, not only at queue time** — a suppression written after queueing must still stop the send.

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

## `rate_limit_bucket`

`key` pk (hashed IP prefix or normalised email + route) · `window_start` · `count`. `src/server/ratelimit/retention.ts` deletes buckets older than seven days once per UTC day through the maintenance scheduler. Each run is batch-capped; a failed run raises the compliance-alert path.

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

| Data | Retention | Mechanism |
|---|---|---|
| `signup_ip_prefix_hash` | 90 days | Daily purge job |
| Unverified `pending` subscribers | Campaign-configured horizon (default 30 days) | Daily expiry sweep → `expired` |
| Verification and status tokens | Purged 30 days after expiry | Daily, 1,000-row-capped sweep; P1 on failure |
| `rate_limit_bucket` | 7 days | Daily cleanup |
| Giveaway rules pages and entry records | The statutory retention period for the relevant jurisdictions, then `410` | Manual, checklisted |
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
| `country`, `category_preference`, `source` | Customer metadata |
| `access_window` | Customer metadata **and** the customer group |
| `subslush_customer` | The `subslush-legacy` group |

**Sequence:** freeze writes → pgBackRest snapshot → export → idempotent import keyed on `email_normalised` → `createCustomersWorkflow` with metadata → assign customer groups `wave-1`…`wave-4` and `subslush-legacy` → generate per-customer discount codes → set the waitlist database read-only for 90 days.

**Groups, not metadata, are what promotions and price lists target.** Metadata carries provenance; the group carries the access it grants. Both are written, and the group assignment is the one the store actually uses.

**Rehearsed twice against a scratch database before launch day** (E11-06). A rehearsal that is not idempotent — running it twice produces duplicate customers — is a blocking finding.
