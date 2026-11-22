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
| `referral_code` | text unique **nullable** | **Null until verification.** The code is generated when a subscriber verifies, never for a `pending` row — so it cannot be `NOT NULL` (ADR-011, `docs/modules/referral.md`). Founder-authorised 2026-08-26, resolving the E1-03/E4-01 conflict; see E1-03's acceptance criteria. Every write is mirrored into the shared `referral_code` registry in the same transaction (E11.7-01) |
| `referred_by_id` | uuid null → `subscriber(id)` | Set once at signup; **never reassigned** |
| `referral_tier` | int not null default 0 | **Derived** from settled milestones. Since E11.7-03 retired the milestone tiers, none is settled, so it is 0 |
| `confirmed_referrals` | int not null default 0 | **Derived** from `referral_edge`; recomputable |
| `access_window` | text | `wave-1`…`wave-4`. **Derived** (E11.7-03): `verification_order_window`, or `wave-1` while another wave-1 reason holds — 3 or more confirmed, non-voided referrals (partner reasons are added by E11.7-07). Recomputed with the coupon ladder up to handoff, so a void can take it back to `verification_order_window`, and never below it |
| `verification_order_window` | text null | `wave-1`…`wave-4`. **The window the subscriber's verification order gave them**, from ADR-025's bands, written once at verification (E11.7-03, founder D1). `wave-1` is the first-1,000 place, which no void removes. Write-once by trigger, cleared by the same trigger on erasure. Backfilled by migration 0061 from the earliest recorded promotion's starting window, or else the access window then held |
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

**`referral_tier`, `confirmed_referrals`, `access_window` and `referral_coupon` are derived.** `referral_edge`, `milestone_award` and `verification_order_window` are the record. One recompute (`src/server/referral/rewards.ts`) rewrites them from the confirmed, non-voided edges inside every confirmation, void and un-void transaction, and the daily repair job runs the same recompute idempotently and alerts on any non-zero correction (`docs/architecture/fallbacks.md`).

---

## `verification_token`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `subscriber_id` | uuid not null → `subscriber` | |
| `token_hash` | bytea not null unique | **SHA-256 of the token. The plaintext is never stored** — it exists only in the emailed URL |
| `purpose` | text not null | `verify` · `status` · `unsubscribe` · `dsr_export` · `dsr_delete` · `partner_application` (E11.7-05: a partner application's confirmation link, seven days) |
| `expires_at` | timestamptz not null | |
| `consumed_at` | timestamptz null | Single use. A second consume is a **no-op that reports success** |
| `created_at` | timestamptz not null | |

For `unsubscribe` tokens, E8-01 adds the token-to-`email_send` binding with the token-minting path. The bound send row is the authoritative originating-template source used by E6-06; no caller-controlled value may determine a suppression's `source`.

E8-01 derives verify, status and unsubscribe token plaintext as base64url `HMAC-SHA256(EMAIL_TOKEN_SECRET, token_id)`. The database stores only `SHA-256(token)` and the UUID token ID; the server secret is separate from the IP pepper and never enters the database or logs. This permits retry reconstruction from an ID without persisting plaintext. Rotating the secret invalidates all outstanding tokens; this is an accepted operational cost.

The same table shape backs the signed status link for `/me` with a longer expiry and a `purpose` discriminator (`verify` · `status` · `unsubscribe`), so there is one token lifecycle to reason about rather than three.

`GET /verify?token=` never reads or mutates this table; it renders a confirmation form so mail scanners and prefetchers are inert. Only the token-authenticated `POST /verify` consumes. Invalid and expired posts render identical copy and the same request-new-link control. `src/server/verification/retention.ts` invokes `purgeExpired()` daily through the maintenance scheduler with the shared 1,000-row batch cap, deleting rows 30 days after expiry; failure follows the P1 compliance-alert path.

---

## `referral_code`

**The one namespace for every referral code, member and partner alike** (E11.7-01). A partner code can never equal a member code, or the reverse, and two codes that differ only in case can never both exist.

| Column | Type | Notes |
|---|---|---|
| `code` | text **primary key** | **Upper case** (`code = upper(code)`, checked). Lookup upper-cases the input, so it is case-insensitive. A partner code must also match `^[A-Z0-9]{4,16}$` (checked); a member code is the E4-01 12-character code |
| `owner_kind` | text not null | `member` · `partner` |
| `owner_id` | uuid null | A member row's owner is `subscriber(id)`; a partner row's owner is its `partner` record, registered at approval by E11.7-06 (D-050: E11.7-05 checks the requested code but writes no row). Null only for a **retired** code: a member code whose subscriber was erased, or a partner code whose partner's personal data was purged or erased (E11.7-06). No foreign key, because the owner table depends on the kind; an active member row is checked against its subscriber instead |
| `active` | boolean not null default true | Whether the code resolves to its owner. A member code is active exactly while its subscriber holds it (checked). **A partner code always enters inactive**, whoever inserts it (trigger, D-044); only partner activation makes it live (E11.7-07) |
| `created_at` | timestamptz not null | When the code was registered. Backfilled member codes take their subscriber's `verified_at` |

Constraints: `owner_id` may be null only when `active` is false · one member code per subscriber (partial unique index on `owner_id` where `owner_kind = 'member'`) · one partner code per partner (`uq_referral_code_partner_owner`, E11.7-06) · `code`, `owner_kind` and `created_at` are immutable, and an owner can only be cleared, never set or changed (trigger) · **an active member row must be its subscriber's current `referral_code`** (deferred constraint trigger, checked at commit) · **a partner row is inserted inactive** (`BEFORE INSERT` trigger, migration 0059; member rows still insert active).

Permissions: the application role has `SELECT`, and `INSERT` on `code`, `owner_kind` and `owner_id` only, with no `UPDATE` or `DELETE`. Nothing in the application can therefore make a partner code live; E11.7-07 adds the activation path and the narrow permission it needs (an `UPDATE (active)` grant or a definer function). The one write the application can cause is E11.7-06's purge trigger on `partner`, a definer function that only **retires** the purged partner's own row (inactive, owner cleared) and can never make a code live.

**Member codes are mirrored, never written separately.** Generation (E4-01) claims the registry row first, with `ON CONFLICT DO NOTHING`, then writes `subscriber.referral_code` in the same transaction. A collision with any existing code, member or partner, regenerates without aborting the verification transaction. A trigger on `subscriber` mirrors every other write of `referral_code` in the same transaction and refuses, with `unique_violation`, a code another owner already holds in any case. When the subscriber's code is cleared (E9-05 erasure), the trigger **retires** the row: `active` false and `owner_id` null. A retired code no longer resolves, holds no link to the person, and is never reissued. Codes cleared by an erasure before this table existed were never registered.

Permissions: the application role may `SELECT`, and `INSERT` only `code`, `owner_kind` and `owner_id`. It cannot update or delete a row. Migration `0058` backfilled every member code that existed when it ran.

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
| `voided_at` | timestamptz null | Set when the founder voids the referral (E11.7-02); cleared by an un-void. A voided edge is kept and counts nowhere |
| `void_reason` | text null | The founder's reason: one line of 1–200 characters, refused if it holds an email or IP address |
| `voided_by` | text null | The authenticated human actor (`admin.operator`); never a `system:` actor |
| `confirmed_at` `created_at` | timestamptz | |

**A void is a flag over the edge, not a state** (E11.7-02). The check `referral_edge_void_recorded` requires all three void columns together, a non-blank reason of at most 200 characters and a non-`system:` actor, or none of them. `state` and `reward_state` are never changed by a void, so the reward-gating transitions are untouched. **Every consumer of the confirmed count reads only `state = 'confirmed' AND voided_at IS NULL`**: `confirmed_referrals` and its daily repair, the coupon ladder and wave 1 (E11.7-03), giveaway referral entitlement and accrual, and the handoff's confirmed referral pairs. The leaderboard, `/me`, rank and the admin CSV read the recomputed `confirmed_referrals`, which the void transaction recomputes. The application role may update only the three void columns. Every void and un-void is audited as `referral.voided` or `referral.unvoided` with before and after values.

**Cheap rewards settle on confirmation; coupons are `held`, and become usable only when any one of the owner's confirmed referred people places a first order, until five years after the configured public launch** (ADR-012, as amended by E11.7-03). The pre-launch repository carries export-set owners' held coupons at handoff with that expiry. The main platform owns making them usable. Nothing here settles a coupon.

---

## `milestone_award`

`id` · `subscriber_id` · `tier` int · `reward_kind` (`entries` · `discount` · `wave_upgrade` · `merch`) · `state` (`settled` · `held` · `void`) · `awarded_at` · `void_reason` (null, or `ladder_replaced` on a `void` row, checked). Unique on `(subscriber_id, tier, reward_kind)`.

**Retired by E11.7-03** (founder, 2026-11-17): the coupon ladder replaces ADR-025's tiers. Migration 0061 voided every award not already void with `void_reason = 'ladder_replaced'`, wrote one `referral.milestone_retired` audit row per award with its state before and after, and deleted none. The application role has `SELECT` and `UPDATE (state)` and no `INSERT`, so no new award can be made; confirmations create none. Erasure still deletes a subject's awards (E9-05). The E11-06 handoff passes that void an ineligible owner's held discount or a legacy `entries` award still run, and find none.

## `referral_coupon`

**The referrer coupon ladder** (E11.7-03; `docs/features/partner-programme.md#the-referrer-coupon-ladder-members-and-partners`). **Derived state**: each owner's rows equal the ladder computed from their confirmed, non-voided referral count, rewritten in the same transaction as every confirmation, void and un-void, and by the daily repair.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | The handoff's `coupon_id` |
| `subscriber_id` | uuid not null → `subscriber` | The owner, the referrer |
| `coupon_number` | smallint not null | 1, 2, 3 … in ladder order, `>= 1`. Unique with `subscriber_id` |
| `percent` | smallint null | 1–100. Set exactly when `state = 'held'` (checked) |
| `state` | text not null | **`held` · `void` only** (checked): the database cannot store `settled`. `void` means the count fell below the coupon's unlock; a later confirmation or an un-void returns it to `held` |
| `expiry_basis` | text not null default `public_launch` | The expiry is five years (configured) after the configured public-launch date, computed when exported. The row records only the basis |
| `created_at` `updated_at` | timestamptz not null | `updated_at >= created_at` (checked) |

A coupon row is created when the count first reaches its unlock and is never deleted except by erasure, so a void coupon stays visible as `void`. The only transitions are `none → held`, `held → held` (a percent step), `held → void` and `void → held` (`couponTransitions` in `src/server/referral/reward-state.ts`). The ladder's figures are configuration in `src/server/referral/config.ts` (ADR-025, as amended), so changing a threshold, the step or the launch date needs no migration. The launch date is read when the handoff export computes the expiry. A changed threshold or step reaches an owner's stored rows only at that owner's next recompute — a confirmation, void or un-void — or at the daily repair, which checks at most 1,000 verified subscribers per run, lowest IDs first, and so does not reach every owner. The handoff first recomputes everyone: before its snapshot it recomputes every verified subscriber's coupons and wave under the configured ladder, in batches of at most 1,000, and audits each change as `handoff.rewards_recomputed` (D-047), so the export follows the configured ladder.

Permissions: the application role has `SELECT`, `INSERT` of every column but `expiry_basis`, `UPDATE (percent, state, updated_at)` and `DELETE` (erasure only). It cannot change a row's owner, number or basis. Personal data: a member's rewards, covered by the privacy policy's referral row, the E9-05 export and erasure.

## `partner`

E11.7-05 (founder decisions D-050, 2026-11-22). One row per submitted partner application; the later lifecycle tickets (E11.7-06 and E11.7-07) move it through review and activation. **Personal data**, disclosed in the privacy notice and covered by the E9-05 export and erasure.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `subscriber_id` | uuid null → `subscriber` | The member record for the applicant's normalised email, found or created `pending` on submit. **The partner's email is the subscriber's**: it is not copied here. Not null until the personal fields are purged; it can only be cleared |
| `status` | text not null | `unconfirmed` · `applied` · `approved` · `contract_sent` · `active` · `paused` · `terminated` · `rejected`. A submission is `unconfirmed`; **only a confirmed application reaches `applied`**. The founder's commands (E11.7-06) set the rest, and **only the eleven documented transitions are allowed** (trigger below; `docs/features/partner-programme.md#partner-lifecycle`) |
| `status_changed_at` | timestamptz not null | When the row reached its current status; it changes only with the status and never moves backwards. The retention purge and `partners list --stale` read it |
| `submitted_at` | timestamptz not null | Immutable |
| `applied_at` | timestamptz null | Set exactly when the status leaves `unconfirmed` |
| `created_subscriber` | boolean not null | True when the submission created its pending subscriber. Such a subscriber gets no waitlist verification reminder (the 1, 24 and 72-hour ladder and the final reminder): it receives the application's link instead, and expires by the 30-day pending sweep. Immutable |
| `confirmation_token_id` | uuid null → `verification_token`, `ON DELETE SET NULL` | The `partner_application` token the confirmation email carries. Unique while set |
| `full_name` | text null | 1–200 characters |
| `country_of_residence` | text null | ISO 3166-1 alpha-2, from `src/content/partner-countries.json`. **The only country the site stores outside a provisional winner's award record** (ADR-026 as amended), for the partner contract. In no analytics event |
| `partner_type` | text not null | `standard` · `student_ambassador` · `creator` |
| `channels` | text[] null | 1–9 of `tiktok` · `youtube` · `instagram` · `x` · `discord` · `telegram_whatsapp` · `newsletter_blog` · `campus_offline` · `other` |
| `handles` | text[] null | 1–10 handles or URLs |
| `audience_size` | text null | `under_1k` · `1k_10k` · `10k_50k` · `50k_150k` · `150k_plus` |
| `promotion_plan` | text null | 1–500 characters |
| `requested_code` | text null | The preferred code after the E11.7-01 rules, upper case, `^[A-Z0-9]{4,16}$`. **Checked, not reserved**: no uniqueness constraint and no `referral_code` row; E11.7-06's `approve <id> [--code]` registers it, re-running the rules (D-050 Q3) |
| `university` | text null | Required for a `student_ambassador`. Set at application, or by `set-type student_ambassador --university` (E11.7-06); changing to another type keeps it as stored |
| `student_email` | text null | Optional, student ambassadors only |
| `company_name` | text null | Optional, for an applicant applying as a business |
| `age_confirmed`, `programme_terms_agreed` | boolean null | Both true on every unpurged row |
| `contract_sent_at` | timestamptz null | E11.7-06 `contract-sent`. Set exactly for `contract_sent`, `active`, `paused` and `terminated`, and kept on a partner rejected after it; written once, by that transition |
| `contract_signed_at` | date null | E11.7-06 `contract-signed`: the signing date, never before the UTC day the contract was sent. Set exactly for `active`, `paused` and `terminated`; written once, by `contract_sent` → `active` |
| `contract_version` | text null | The contract's version label, `^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$`. The database refuses labels containing IP addresses. Set exactly with `contract_signed_at` |
| `contract_reference` | text null | The optional signfree reference or link, 1–200 characters. **Personal data** (it identifies the person's signed contract): cleared by the purge and erasure, and recorded in the audit log only as its length and SHA-256 |
| `notes` | text null | The founder's internal notes, one field of 1–2,000 characters replaced whole by `note` (E11.7-06, D-052 Q4e), refused if it holds an email or IP address. **Personal data**: in the subject's data export, cleared by the purge and erasure, and recorded in the audit log only as its length and SHA-256, never as text |
| `personal_data_purged_at` | timestamptz null | Set when the retention purge or erasure clears every personal field and the member link together |
| `created_at` | timestamptz not null | |

**Checks:** every required field is present until purged, and every personal field, the contract reference, the notes and the member link are null once purged; a student ambassador has a university; the contract record matches the status as described above; the closed value sets above. No address, phone, payout, tax or bank field exists. **Indexes:** one live application or partnership per member (`subscriber_id` unique where the status is neither `unconfirmed` nor `rejected`), a unique confirmation token, the member lookup, the purge scan, and the review list (status, `applied_at`, id). **Triggers** (migration 0063's `partner_lifecycle_guard` replaces 0062's guard): **a status change must be one of the eleven documented transitions**, and every other pair is refused, including a write that sets the status to its current value (`partner_status_must_change`); a row leaves `unconfirmed`, or is inserted past it, only while its subscriber is `verified`; `approved` is reached only with a registered partner code; the status time changes only with the status; the contract record is written only by its own transition; the id, submission and creation facts are immutable, and a purged row keeps its status. **Purging retires the partner's code** (`partner_purge_retires_code`, a narrowly scoped `SECURITY DEFINER` function): when `personal_data_purged_at` is set, the partner's `referral_code` row becomes inactive and loses its owner, so the code is never reissued. **Permissions:** the application role has `SELECT`, column-scoped `INSERT` and column-scoped `UPDATE` (status, the confirmation time, the token link, the personal fields for the purge and erasure, and since E11.7-06 the type, the contract record and the notes), and no `DELETE`.

**Retention:** rejected and unconfirmed applications have their personal fields and member link cleared 90 days after they reached that state (`partnerApplicationRetentionMs` in `src/server/partner/config.ts`), by the daily `partner_application_purge` job (at most 500 rows a run, recorded in `purge_job_run`). The row, with its status, type, timestamps, signing date and version, stays for the programme's counts. **Erasure** clears the same fields, the requested code, contract reference and notes included, and both retire the partner's registered code. Confirmed applications are kept until handoff, like the member record.

## `survey_response`

`id` · `subscriber_id` unique · `answers` jsonb · `version` · `created_at` · `first_answered_at` nullable. Answers are validated against a versioned question set (`2026-09-08` v1 or `2026-10-19` digital-goods v2); `version` is stored so a mid-campaign question change does not corrupt the earlier answers. `first_answered_at` is set on the first saved answer and is never cleared by a replacement or all-skip submission; it gates the once-per-subscriber `survey_completed` event. E10-03 backfills existing currently answered rows from `created_at`.

## `giveaway_entry`

`id` · `subscriber_id` · `method` (`base` · `referral`) · `entries` int **always 1, enforced by a validated check constraint (E7-04)** · `rules_version` text · `rules_sha256` bytea not null, exactly 32 bytes (added by E7-03) · `source_edge_id` uuid null · `voided_at` · `voided_by_disqualification_flag_id` uuid null → `fraud_flag` · `voided_by_referral_void` boolean not null default false (E11.7-02) · `created_at`. Unique with `NULLS NOT DISTINCT` on `(subscriber_id, method, source_edge_id)` so a retry cannot double-credit when `source_edge_id` is null.

**`rules_version` and `rules_sha256` are stamped at accrual.** There is one global rules page (ADR-026) and no jurisdiction column; S-01 dropped `jurisdiction` and the `amoe` method, because the ordinary verified signup is the free entry route. Entries keep the rules that were in force when they accrued — that is what makes a mid-campaign rules revision survivable (`docs/architecture/fallbacks.md`).

E7-03 accrues one base entry on fresh verification and one referral entry for each confirmed edge while `giveaway.open` is on. The verification transaction also writes the subscriber's first `giveaway_rules_version`; a database trigger rejects any later change to it. The application role may insert entries and update only that subscriber column, with no broad giveaway table write grant.

The 2026-09-26 founder decision makes verification and edge confirmation within the published entry period the entitlement source. A bounded hourly reconciliation and the flag-on action fill missing rows, including events from when `giveaway.open` was off. Backfilled rows stamp the rules revision current when written. Rows verified or confirmed after the close are excluded, and every reconciliation run is audited with counts.

When a human upholds a fraud flag, only that referrer's `referral` entries are
voided and tied to the flag. Reversing that decision restores those entries;
the referred subscribers' entries are never affected.

**Referral voids (E11.7-02).** Before any draw snapshot is committed, voiding a referral also voids that edge's `referral` entry through `voided_at`, and sets `voided_by_referral_void`; an un-void clears both, and restores only an entry this marker identifies. An entry another decision already voided is left as it was. The check `giveaway_entry_referral_void_shape` allows the marker only on a voided `referral` entry with a source edge. The void takes the entry-ledger lock that serialises snapshot commitment, so it is decided either wholly before or wholly after the commit. **After commitment, a void or un-void never touches `giveaway_entry`, `giveaway_draw` or its snapshot and selection rows**, so the draw still reproduces (E9-05's precedent). A voided edge is not a referral entitlement, so reconciliation never accrues one for it; an un-voided edge becomes one again.

## `giveaway_draw`

E7-05 records one active draw (`pending` or `published`; an attempt whose target round was already available is retained as `aborted`). The row stores `entry_snapshot_hash`, `snapshot_committed_at`, `snapshot_count`, `prize_count`, the current rules version and hash, drand `chain_hash` and verified chain info, `target_round` and its scheduled time **before** any seed exists. A database advisory lock serialises entry inserts with the snapshot transaction; an entry-insert trigger closes the ledger after the first committed snapshot, including an aborted commitment awaiting a later round. `giveaway_draw_snapshot_row` retains every non-voided ledger row, including its owner, method, source edge, rules version and hash. It is copied in batches of 1,000, hashed in entry-ID order and immutable after commitment, apart from the derived selection score.

After the future round is published, the same draw row stores its verified round number, randomness, signature, optional previous signature, the relay used, both agreeing relays, the derived SHA-256 seed, `seed_generated_at`, ordered winner IDs, `reproduced_at`, and `published_at`. `giveaway_draw_selection` retains **one row per person** in deterministic draw order, with a winner marker for the first `prize_count` rows and all remaining rows as ordered reserves. Positions may have gaps because they follow the sorted entry tickets; their order is authoritative. `attempt_count`, `next_attempt_at`, and `last_alert_at` preserve bounded retry state during a beacon outage. **Publication requires offline signature verification and exact reproduction of the snapshot hash, every entry score, winners and reserves.** No fresh draw or local seed replaces a pending one. Draw records and snapshots are retained for six years under the policy in `docs/legal/compliance.md`.

**E9-05 erasure contract (founder-authorised 2026-10-01):** before commitment, erasure sets the subject's `giveaway_entry.voided_at`, excluding those entries from the snapshot. After commitment, erasure never modifies `giveaway_draw`, `giveaway_draw_snapshot_row` or `giveaway_draw_selection`. Snapshot and selection rows retain only the opaque subscriber ID as the subject reference; no mapping from that ID back to a person may remain after erasure. Their original evidence continues to reproduce exactly, including before publication.

Columns (0001, extended by E7-05): `id` uuid pk · `executed_by` text not null, the actor who started the draw; the draw worker reuses it as the actor of the beacon and publication audit records · `state` text not null default `pending` (`pending` · `published` · `aborted`), with at most one non-`aborted` row (partial unique index) · `snapshot_committed_at` · `snapshot_count` bigint not null default 0 · `entry_snapshot_hash` bytea · `prize_count` integer > 0 · `rules_version` text and `rules_sha256` bytea (32 bytes), the global rules revision current at commitment · `drand_chain_hash` bytea (32 bytes) and `drand_chain_info` jsonb, the verified drand chain parameters, including the public key used to verify the beacon · `target_round` bigint > 0 and `target_round_at` timestamptz, the future round and its scheduled time · `beacon_round` bigint, which must equal `target_round` at publication · `beacon_randomness` bytea (32 bytes) · `beacon_signature` bytea · `beacon_previous_signature` bytea null when the beacon carries none · `beacon_relay_used` text, the relay whose response was stored · `beacon_verified_relays` jsonb, the array of relays whose responses agreed (at least two, including the relay used) · `seed` text, hex SHA-256 of the snapshot hash, the round number and the beacon randomness · `seed_generated_at` · `executed_at` timestamptz, set to the same instant as `seed_generated_at` when the beacon is stored · `winners` jsonb, the ordered winner subscriber IDs · `reproduced_at` · `published_at` · `attempt_count` integer not null default 0 · `next_attempt_at` · `last_alert_at`. Check constraints require every commitment field together once `snapshot_committed_at` is set, and the seed, beacon, relay, winners, `reproduced_at` and `published_at` before `state = 'published'`. Every column is nullable until its step except `id`, `executed_by`, `state`, `snapshot_count` and `attempt_count`.

`giveaway_draw_snapshot_row` (E7-05): `draw_id` uuid → `giveaway_draw` · `entry_id` uuid, the copied `giveaway_entry.id` · `subscriber_id` uuid, the opaque owner ID (no foreign key) · `method` (`base` · `referral`) · `source_edge_id` uuid null · `rules_version` text not null · `rules_sha256` bytea not null (32 bytes) · `selection_score` double precision null, nonnegative and finite: the per-entry score derived from the seed (HMAC-SHA256 of the entry ID, mapped to an exponential variate), null until the seed exists. Primary key `(draw_id, entry_id)`; inserts are rejected after commitment, and the application may update only `selection_score`.

`giveaway_draw_selection` (E7-05): `draw_id` uuid → `giveaway_draw` · `position` bigint > 0, the person's place in draw order · `subscriber_id` uuid, opaque · `entry_id` uuid, the person's lowest-scoring entry, → `giveaway_draw_snapshot_row (draw_id, entry_id)` · `is_winner` boolean not null, true for the first `prize_count` rows and false for reserves. Primary key `(draw_id, position)`, unique `(draw_id, subscriber_id)`; the application may update only `is_winner`.

E9-05 creates a separate immutable, append-only draw-void record containing `draw_id`, opaque subscriber ID, reason `erasure`, `voided_at` and actor. Its database permissions and constraints ship with the table under standing rule 19. This appended record records erasure without changing the committed snapshot or selection.

## `giveaway_award`

Created by E7-06. One row per prize: the draw, the current provisional or confirmed winner, the award state (`notified` · `confirmed` · `delivered` · `exhausted`), the winner's **country of residence — the only location data the campaign holds, collected from provisional winners at award time; no postal address, because prizes are delivered electronically** (ADR-026), the delivery timestamp field, the age confirmation, the sanctions-check and Canadian skill-testing outcomes, any substitution, and optional publicity permission. Replaced candidates and their reasons live in the candidate history. Kept 6 years with the draw records.

E7-06 stores one `giveaway_award` row per `(draw_id, prize_slot)`, with a write-protected `entry_snapshot_hash` equal to the published draw's hash and foreign keys to the selected row and entry in that snapshot. The award row records `notified_at` and the Section 9 response deadline. A separate `giveaway_award_candidate` claim is unique on `(draw_id, selection_position)` and records every checked or replaced person, so a reserve cannot be reused for another prize. On failed or missed Section 9 checks the award row moves to the next unclaimed reserve; if none remains it becomes `exhausted`. Passing checks sets `confirmed` and never reassigns the prize for substitution.

`country_of_residence` is a two-letter code and is written only after status-token authentication and a Section 9 check. `substitution_state` is `none`, `offered`, `replacement`, or `cash`. An offer records its own timestamp, configured deadline and an immutable copy of the approved catalog options and values presented to that winner. A replacement stores the selected product IDs and delivered retail value; an explicit decline or offer expiry stores cash equal only to the unavailable products' value in that recorded offer, even if the catalog later changes. Both remain attached to the same confirmed winner. The award and candidate records remain in the six-year manual retention set. No postal address is stored.

`giveaway_award` columns (E7-06): `id` uuid pk · `draw_id` uuid → `giveaway_draw` · `prize_slot` integer > 0 · `entry_snapshot_hash` bytea (32 bytes) · `selection_position` bigint, `entry_id` uuid and `subscriber_id` uuid → `subscriber`, the current candidate's selection row, snapshot entry and opaque subject; all three move to the next reserve on replacement · `state` text not null default `notified` · `notified_at` timestamptz not null · `response_deadline_at` timestamptz not null, after `notified_at` (14 days from notification in code) · `country_of_residence` char(2) null, `^[A-Z]{2}$` · `age_confirmed` boolean null, the winner's 18-or-over confirmation · `sanctions_passed` boolean null, true once the country has passed the configured sanctioned-jurisdiction screen · `skill_passed` boolean null, true only for a Canadian resident who answered the skill-testing question correctly and null for other countries · `substitution_state` text not null default `none` · `substitution_offered_at` and `substitution_deadline_at` timestamptz null · `substitution_offer` jsonb null, the frozen offer (the catalog's recorded approver, unavailable product IDs, cash value, original and stated bundle values, and the replacement options with retail values), immutable once offered · `substitution` jsonb null, the outcome: replacement product IDs and delivered value, or the cash value and whether the winner declined or the offer expired · `publicity_permission` boolean not null default false, the winner's optional consent to be named · `delivered_at` timestamptz null, set exactly when `state = 'delivered'` (check constraint; no application path writes it yet) · `created_at` `updated_at` timestamptz not null. A confirmed or delivered award requires a country, `age_confirmed` and `sanctions_passed` true, and `skill_passed` true for `CA`. Checks are written only when all pass, so the stored values are true or null; a failed check replaces the candidate instead. Replacement resets every check field and the substitution fields to their defaults on the award row; the failed check survives as the candidate's reason. Values in the offer and outcome are integer euro cents.

`giveaway_award_candidate` columns (E7-06): `draw_id` uuid and `selection_position` bigint, primary key and foreign key to `giveaway_draw_selection` · `award_id` uuid → `giveaway_award` · `subscriber_id` uuid → `subscriber`, which must match the selection row · `outcome` text not null default `awaiting` (`awaiting` · `confirmed` · `replaced`) · `reason` text null (`age` · `sanctions` · `skill` · `deadline` · `erasure`), set exactly when `replaced` · `checked_at` timestamptz null, set once the candidate is confirmed or replaced.

**E9-05 retention exception (founder-authorised 2026-10-01):** `giveaway_award` and `giveaway_award_candidate` rows for anyone who reached the award stage are retained unchanged for six years on erasure. This includes country of residence, age confirmation, check outcomes, substitution, values and timestamps. They reference only the opaque subscriber ID, never an email. Every email and other personal field outside this award-record exception is erased, winners included. GDPR Art. 17(3)(b) for sanctions checks and Art. 17(3)(e) for legal claims are the recorded bases in `docs/legal/compliance.md` §2 and `/privacy`.

The award workflow adds candidate reason `erasure`: a current provisional winner who is erased is replaced by the next unclaimed reserve, and erased reserves are skipped when reached. This required replacement changes the candidate outcome through the award workflow; erasure does not scrub the retained evidence. Confirmed or delivered awards are never reassigned and their award data remains intact. Section 9 already covers advancement to the next reserve, so no rules revision is needed.

## `top_twenty_review_batch` and `top_twenty_review`

`top_twenty_review_batch` stores the SHA-256 membership hash for one current top-20 review and an `invalidated_at` timestamp. Only one active batch exists. `top_twenty_review` records one non-empty outcome and its human actor for every member of that batch. The top 20 is calculated directly from non-voided `giveaway_entry` totals, including flagged accounts; it is not the leaderboard snapshot. A changed membership invalidates the active batch and E7-05 must call E5-07's current-review precondition before draw publication.

`top_twenty_review_batch` columns (E5-07): `id` uuid pk · `membership_hash` bytea not null, SHA-256 of the ordered member subscriber IDs · `created_at` timestamptz not null default now · `invalidated_at` timestamptz null; a partial unique index allows one batch with null `invalidated_at`. The application may update only `invalidated_at`. `top_twenty_review` columns: `batch_id` uuid → `top_twenty_review_batch` · `subscriber_id` uuid → `subscriber` · `outcome` text not null, 1–128 non-blank characters written by the reviewer · `actor` text not null, 1–128 non-blank characters · `reviewed_at` timestamptz not null default now. Primary key `(batch_id, subscriber_id)`; insert-only for the application.

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

`id` · `subscriber_id` · `template` · `provider` · `business_key` text **unique** · `payload` jsonb **not null** · `unsubscribe_token_id` uuid foreign key to an unsubscribe-purpose `verification_token` · `provider_message_id` · `state` (`queued` · `sent` · `delivered` · `bounced` · `complained` · `failed`) · `attempts` int · `next_attempt_at` · `expires_at` · `last_error` · `created_at` · `updated_at` · `accepted_at` (set when the provider accepts a send; write-once by trigger and requires a provider message ID; preserved across later webhook updates) · `unsubscribe_token_purpose` text, a stored generated column always `'unsubscribe'` (E8-01), which exists only so the composite foreign key `(unsubscribe_token_id, subscriber_id, unsubscribe_token_purpose)` → `verification_token (id, subscriber_id, purpose)` purpose-checks the binding · `gap_alerted_at` timestamptz null (E8-06; stamped once when a Resend `sent` row has gone past the configured gap without a terminal event and is counted into the aggregated P2 task).

`payload` holds references only, such as `token_id`, `tier` or `award_id`, with a database check rejecting email addresses, token plaintext and copy text. E8-03a extends the check for UUID `status_token_id` and a validated `rules_version` reference. Welcome has `{ status_token_id }`; milestone has `{ tier, status_token_id }`; entry receipt has `{ rules_version, status_token_id }`. The unsubscribe-token foreign key is purpose-checked in the database. E8-01's forward-only migration marks old queued rows that have no reconstructible payload `failed` with `last_error = 'legacy_unrecoverable'` before enforcing the new contract; there is no production data yet.

The unsubscribe binding is unique per send and subject-bound. When the token-retention sweep removes an expired unsubscribe token, a still-queued send becomes failed with `unsubscribe_token_expired`; the reference is then cleared without deleting email history. Dispatch checks token expiry and the current secret before sending, so rotation or an expired link never produces mail with a broken link.

**`business_key` is the idempotency primitive** — e.g. `verify:{subscriber_id}:{token_id}`, `milestone:{subscriber_id}:{tier}`. A retry with the same key never produces a second email.

E8-03a's producer keys are `welcome:{subscriber_id}`, `milestone:{subscriber_id}:{tier}`, and `giveaway-receipt:{subscriber_id}:{rules_version}`. The database uniqueness constraint applies to all three.

E8-07 adds `weekly:{ISO-8601 UTC week}:{subscriber_id}`. Its payload is `{ snapshot_id, status_token_id }`, both UUID references. `expires_at` is the weekly schedule plus 24 hours; dispatch fails an expired row before any provider call. The other templates leave it null.

## `leaderboard_snapshot`

E8-07's persisted source for both the public leaderboard cache and weekly email. `id` UUID primary key · `as_of` timestamptz · `entries` JSONB containing at most ten objects, each with **only** contiguous `rank`, a twelve-character SHA-256-derived `display_handle`, and exact nonnegative `confirmed_referrals`. A database check rejects extra fields, so an address, referral code or signup time cannot enter the row. Maintenance computes it every five minutes regardless of `leaderboard.public`; the web process loads the latest row into its in-process cache. A batch-capped daily sweep purges rows older than 14 days. The email resolves its queued `snapshot_id` on every render, preserving retry content.

## `leaderboard_served_snapshot`

One permissioned singleton pointer to the snapshot ID actually loaded by the web cache: `singleton` boolean primary key, default and checked true, so only one row can exist · `snapshot_id` uuid null → `leaderboard_snapshot`, `ON DELETE SET NULL`. The application may update only `snapshot_id`. The weekly job selects this ID when starting a run; if the web cache has not started, it selects the latest persisted snapshot. From the scheduled time, the web cache holds the published ID until a run exists; during the remainder of the 24-hour window, it loads the run's fixed ID. Purging a referenced snapshot clears the pointer by foreign key.

## `weekly_campaign_run`

One row per ISO UTC week, keyed by `iso_week` text primary key in `YYYY-Www` form (checked), holding `state` (`started`, `completed`, `skipped`), the fixed `snapshot_id` for that week's send, `recorded_at` and `alerted_at`. It records missed 24-hour windows and deduplicates the P2 alert across maintenance restarts. The snapshot foreign key clears on the 14-day purge while the run record remains. The audience is selected afresh from verified, unsuppressed, currently marketing-consented subscribers at queue time; dispatch independently re-checks it.
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
same four seed mailboxes. It stores a random `marker`, send/check/alert timestamps,
and one `state`: `pending`, `passed`, `missing_plain_part`, `tracking_pixel`,
`rewritten_link` or `missing`. `sent_at` is set on the first send and is
required for any state other than `pending`; `checked_at` records the latest
inspection; `alerted_at` is set once per failing state, is cleared when the
state changes, and is allowed only for a failing state. It stores no mailbox
address, MIME source or subscriber data. This internal probe runs before customer broadcasts are enabled.

## `email_quota_alert`

One deduplication record per provider, UTC day and severity. It stores only the provider (`resend` or `brevo`), date, alert severity (`P1` or `P2`) and alert timestamp: `provider` · `day` date · `severity` · `alerted_at` timestamptz not null, with primary key `(provider, day, severity)`. The quota health query aggregates `email_send.accepted_at` and the two seed tables' `sent_at` timestamps by UTC day. No address or subscriber identifier enters this table.

## `brevo_contact_sync`

`email_normalised` is the primary key and a foreign key to `subscriber`;
`email`, `listed` and `synced_at` record the last **successfully applied** Brevo
broadcast-list state. The table is a retry cache, not the consent authority.
The authoritative eligibility query joins `subscriber` to `suppression` and
requires verified status plus current marketing consent. A provider failure
leaves this row unchanged so the next bounded batch resumes the contact.

## `suppression`

`email_normalised` pk · `reason` (`unsubscribe` · `bounce_hard` · `complaint` · `manual`) · `source` · `created_at`. **Checked at dispatch, not only at queue time** — a suppression written after queueing must still stop the send.

E8-06 adds `email_webhook_event`, whose sole column is an opaque idempotency key, and bounded reconciliation cursors. `email_webhook_event`: `event_key` text primary key, 1–256 characters. `email_reconciliation_cursor`: `stream` text primary key (`brevo_hard_bounce` · `brevo_spam` · `brevo_blocklist`) · `window_start` date not null, the start date of the look-back window being paged · `next_offset` integer not null default 0, at least zero, the provider page offset to resume from. A cursor resets to offset 0 when its window start changes, and advances only by compare-and-set on the expected offset in the same transaction as the suppressions it applied. Resend uses its Svix event ID; Brevo stores SHA-256 of provider, message ID and event. No webhook payload, address or provider timestamp is persisted there. Authenticated bounce and complaint events write suppression and update matching `email_send` state in one transaction. Resend missing-terminal-event gap detection stamps a sent row once for one aggregated P2 task; `delivered` counts as terminal for gap detection but can later be followed by a complaint.

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

One row per scheduled purge job. `job_key` text primary key with a finite CHECK over `ip_prefix_retention` (the fraud IP-prefix retention job), `rate_limit_retention`, `verification_token_retention` (verification and status tokens), `leaderboard_snapshot_purge` and `partner_application_purge` (E11.7-05). `last_started_at` · nullable `last_finished_at` · nullable `last_succeeded_at` · nullable `last_outcome` (`succeeded` or `failed`) · `rows_purged` integer at least zero · nullable sanitized `last_error_code`. No personal data. Each job upserts at start and finish; a record-write failure cannot fail the purge. The application role has SELECT, INSERT and UPDATE, never DELETE. Health treats a missing success as stale and a daily job's last success as stale only after 48 hours. The clock is injected. The subscriber expiry sweep changes status and is not a purge job.

## `maintenance_heartbeat`

One row per maintenance-worker loop (QA gate 7, G7-1-I2; founder decision 2026-11-13 on E10-05). `loop_key` text primary key with a finite CHECK over `scheduler_cycle` (the hourly scheduler cycle) and `email_dispatch` (the one-minute email dispatch pass) · nullable `last_beat_at` · nullable `stale_alerted_at`. No personal data. The worker upserts its loop's row after each completed pass, setting `last_beat_at` and clearing `stale_alerted_at`; an older beat never overwrites a newer one, and a failed write is logged as a sanitized code and never fails the pass. The app's watchdog stamps `stale_alerted_at` when it sends the one P1 for a stale episode, so repeated passes and app restarts send no second alert; it inserts a row with a NULL `last_beat_at` only for a loop that has never beaten past the start-up grace. The application role has SELECT, INSERT and UPDATE, never DELETE. The clock is injected.

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
| Rejected and unconfirmed partner applications (`partner` personal fields) | 90 days after rejection or submission | Daily, 500-row-capped `partner_application_purge`; P1 on failure (E11.7-05) |
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

**E11.5-02 launch export extension.** The launch customer NDJSON adds `survey_version` as metadata beside `category_preference`; this does not change the twelve-field admin CSV. `survey_version` is the version of the response that supplied the category answer, or null when no response exists. Exported `category_preference` accepts the union of v1 tokens (`apparel`, `footwear`, `accessories`, `home`, `beauty`) and v2 tokens (`ai`, `subscriptions`, `software`, `gift_cards`, `game_keys`, `game_top_ups`, `in_game_currency`). The paired version preserves which set applies; a skipped category answer may be null while its response still has a version.

**Held-coupon handoff payload (E11-06, amended by E11.7-03):** each `referral_coupon` in state `held` whose owner is in the customer export set is exported separately as `held_coupon` with `coupon_id` and `subscriber_id` UUIDs, owner `email_normalised` as the storefront import key, `coupon_number` and `percent` integers, `state = 'held'`, `outcome = 'carried_to_storefront'`, and `expires_at` as an RFC 3339 UTC instant five years after the configured public-launch date (`couponLadder.publicLaunchDate`, default 2027-10-01, so `2032-10-01T00:00:00.000Z`; founder, 2026-11-22). The founder sets the real date in that configuration at handoff; it is not a command argument. Each carried coupon is audited as `handoff.coupon_carried` with its expiry, after the output file finishes. A void coupon is never exported. A disqualified, suppressed or departed owner's coupons are not exported, and an erased owner has none (E9-05). A marketing-withdrawn owner who remains verified and unsuppressed is carried normally. The retired milestone awards were voided with `ladder_replaced` (migration 0061) and are never exported; the E11-06 passes that void an ineligible owner's held discount and any legacy bonus-entry award still run, batch-capped and audited, and find none. No bonus-entry reward is exported.

**Confirmed-referral handoff payload (E11-06):** `confirmed_referral` records carry exactly `referrer_email_normalised` and `referred_email_normalised`. An edge is exported only if its state is `confirmed` and both endpoints belong to the verified, unsuppressed customer export set. The storefront imports each pair idempotently by its two normalised emails, then makes all of an owner's held coupons usable when **any one** of that owner's exported confirmed referred people places a first order, until each coupon's `expires_at`. No pre-launch path settles them or reads or writes Medusa.

**Unsubscribe-token handoff payload (E11-07, founder-authorised 2026-10-12):** each unexpired, unconsumed `verification_token` with purpose `unsubscribe` becomes a separate `unsubscribe_token` NDJSON record with `token_sha256` (hex-encoded hash, never plaintext), owner `email_normalised`, `origin_kind` (`marketing` for Brevo, `transactional` for Resend) and `expires_at` as an RFC 3339 UTC instant. This token set is separate from the customer export set so a suppression or marketing withdrawal cannot invalidate an already-sent unsubscribe link. The storefront imports idempotently by `token_sha256`, hashes a presented token, withdraws marketing consent for either origin, and also suppresses non-essential mail for `transactional`; its POST is RFC 8058 one-click and consumes the token once. Both old unsubscribe paths remain handled by the storefront until each token's 90-day TTL expires, then redirect to storefront email preferences. Export refuses if the draw is not published or any `giveaway_award` is not terminal (`confirmed`, `delivered`, `exhausted`).

**Sequence:** close signups and audit → send final reminder to pending, unsuppressed rows → keep `/verify` live for the configured 72-hour window → block public writes, pause maintenance and audit the full freeze → pgBackRest snapshot → export → idempotent import keyed on `email_normalised` plus unsubscribe tokens keyed on hash → `createCustomersWorkflow` with metadata → assign customer groups `wave-1`…`wave-4` and `subslush-legacy` → transfer held-coupon records and confirmed referral pairs for storefront qualification → DNS/proxy cutover → set the waitlist database read-only for 90 days, except named-operator erasure through the verified-request and completion CLIs. Audited handoff operations remain permitted between the full freeze and read-only transition. The storefront makes an owner's coupons usable only after any one of that owner's confirmed referred people places a first order, until each coupon's `expires_at`.

**Groups, not metadata, are what promotions and price lists target.** Metadata carries provenance; the group carries the access it grants. Both are written, and the group assignment is the one the store actually uses.

**Rehearsed twice against a scratch database before launch day** (E11-06). A rehearsal that is not idempotent — running it twice produces duplicate customers — is a blocking finding.

## E9-05 erasure and export structures

The final 2026-10-02 founder decision supersedes immediate local erasure and the earlier P2 failure path. The pending state preserves the original subscriber identity until Brevo DELETE by `ext_id` succeeds or returns 404. Nothing copies that identifier into retry metadata. Pending subjects are excluded from mail, sync upserts, `/me`, leaderboard and draw/award/entry eligibility. The status cannot return to active processing. A deferred database constraint requires pending-request evidence and requires an erasure-ledger entry for an erased row. The erasure transaction nulls identifying subscriber fields and referral endpoints, removes survey, milestone, coupon, email and token records, scrubs fraud evidence, deletes suppression and the Brevo cache, and clears related rate buckets. Existing confirmed edges remain countable for their surviving referrer. Immutable audit records retain only their opaque links and redacted evidence; award/candidate evidence is the explicit six-year exception.

### `dsr_erasure`

`subscriber_id` UUID primary key and subscriber foreign key · `requested_at` not-null timestamp · `attempts` nonnegative integer, default 0 · `next_attempt_at` not-null timestamp at or after request · nullable `escalated_at`, `deadline_alerted_at`, `completed_at`. A partial due index covers unfinished requests. The application may SELECT, INSERT and update only retry/completion fields. No email or encrypted identifier is stored. Completion is atomic with local erasure and audit. Retry delay starts at one minute and caps at one hour. Seven-day expiry raises P1; day-28 and subsequent daily P1 alerts protect the 30-day hard deadline. The operator completion CLI records its human actor.

### `erasure_ledger`

`subscriber_id` UUID primary key · `erased_at` not-null timestamp, and no other fields. SELECT/INSERT only for the application; UPDATE/DELETE are also rejected by an immutability trigger. No foreign key requires the subject to exist in a restored database. Re-application imports the newest available ledger and processes all IDs in bounded batches, idempotently. E12-04 owns its scheduled off-host copy.

### `giveaway_draw_void`

`draw_id` UUID foreign key · `subscriber_id` opaque UUID · `reason` constrained to `erasure` · `voided_at` not-null timestamp · nonempty `actor`. Primary key `(draw_id, subscriber_id)`. A trigger requires a committed snapshot row for that subject. The application has SELECT/INSERT only; UPDATE/DELETE are rejected by an immutability trigger. Original draw/snapshot/selection evidence remains unchanged. Award candidate reasons now also accept `erasure`.

### Export coverage

`src/server/db/dsr-export.ts` registers subject-scoped tables. `referral_coupon` is registered by its owner (E11.7-03), and erasure deletes it. `referral_code` is registered by its member owner (E11.7-01), and since E11.7-06 also by the partner owner of any of the member's applications; an erased subject's codes are retired with their owners cleared, so they are no longer theirs to export. `partner` is registered by its member link (E11.7-05), with the founder's notes and the contract record since E11.7-06; erasure clears every personal field and the link, so an erased subject has no application to export. Every row includes every column through `to_jsonb`, reconciled against the model and schema by test. Referral counterparts, other winners, operator identities and third-party fraud evidence are redacted. NDJSON is streamed in 100-row pages under a repeatable-read transaction, with a fulfilment audit at successful completion. DSR tokens use distinct `dsr_export` and `dsr_delete` purposes with a 24-hour lifetime. An export replay is acknowledged without exporting again; invalid/expired links use one response. No plaintext token is persisted.
