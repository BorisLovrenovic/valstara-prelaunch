# Module: subscriber

Kind: domain.

## Responsibility
The waitlist row and its lifecycle: create, normalise, verify, expire, unsubscribe, disqualify, anonymise.

## Data owned
`subscriber` — see `docs/data/model.md#subscriber`.

## Exposed interface
```ts
interface SubscriberService {
  // Discriminated outcome: created | existing | already_verified |
  // invalid_email | blocked_domain
  signup(input: SignupInput): Promise<SignupOutcome>
  findByNormalised(email: string): Promise<Subscriber | null>
  markVerified(id: string, at: Date): Promise<void>
  assignAccessWindow(id: string): Promise<AccessWindow>
  expireUnverified(before: Date, limit: number): Promise<number>   // batch-capped
  unsubscribe(id: string, reason: SuppressionReason): Promise<void>
  disqualify(id: string, actor: string, reason: string): Promise<void>
  anonymise(id: string, actor: string): Promise<void>              // DSR erasure
}
```

E3-08 adds two scheduled interfaces beside the request-facing service:

```ts
interface VerificationReminderJob {
  run(limit: number): Promise<{ scanned: number; queued: number }>
}

interface UnverifiedExpiryJob {
  run(limit: number): Promise<number>
}
```

The maintenance process runs the reminder job hourly and the expiry job once per
UTC day. Each invocation is explicitly capped. The reminder offsets are exactly
`+1h`, `+24h` and `+72h`; their immutable business keys are
`verify-reminder:{subscriber_id}:{offset}h`, so the `email_send.business_key`
constraint is the final deduplication guard. The expiry horizon defaults to 30
days and changes only `pending` rows strictly past it.

## Rules
- **`normaliseEmail()` runs before any uniqueness check.** Lowercase, strip `+tag` (all domains), remove dots for **Gmail-family domains only** — `gmail.com` and `googlemail.com`; every other provider keeps its dots. The family is not cross-canonicalised (a `googlemail.com` address is not rewritten to `gmail.com`). The normalised form is the unique key; the raw form is what is displayed and mailed. A malformed address, or one whose local part is emptied by tag/dot removal, is rejected (the function returns `null`); Unicode and internationalised domains never throw. This one step removes the cheapest referral attack entirely.
- After normalisation and before the subscriber upsert, `signup()` invokes the
  fraud domain screen. A blocklist hit returns `blocked_domain`; a definitive
  no-MX result returns `invalid_email`; a DNS timeout continues the upsert and
  raises an open review flag after the row exists.
- **`signup()` is idempotent on `email_normalised`.** A repeat for a `pending` row re-queues the verification mail subject to its own rate limit; a repeat for a `verified` row does not. Its internal outcome remains `created`, `existing` (a pending repeat, whether the mail was re-queued or throttled), `already_verified`, or `invalid_email`, so mail suppression does not depend on the public response. The route maps `invalid_email` to the closed error set and collapses every non-error outcome to the same accepted response. The per-address send window has a limit of one, which is also what makes a concurrent double-submit produce exactly one verification email.
- **`referred_by_id` is write-once**, enforced in the schema. Reassignment is a defect, not a feature.
- **`disqualify()` requires an actor and writes an audit record.** There is no code path that sets `disqualified` without one.
- **`anonymise()` never deletes the row** where referral edges reference it — it nulls the personal fields, so counts stay defensible and no personal data remains.
- E6-06's explicit `leave_waitlist` action writes global suppression and moves a `verified` subscriber to `unsubscribed`, stamping `unsubscribed_at` in the same audited transaction. A message unsubscribe without an explicit leave action follows its email type and does not change waitlist status.
- `referral_tier` and `confirmed_referrals` are **caches** owned by the referral module. This module never writes them directly.
- Every sweep is batch-capped and takes an explicit limit.
- **Only `verified` is a counted subscriber status.** The canonical value lives
  in the subscriber database query layer and is shared by current and future
  count consumers; `pending` and `expired` never enter a counted query.

## Dependencies
`db`, `audit`, `fraud` (signals at signup), `referral` (edge creation), `email` (queue verification).

## Contract tests
`user+tag@gmail.com`, `u.s.e.r@gmail.com` and `user@gmail.com` collide on one row · a non-Gmail domain keeps its dots · double signup produces one row and one email · `referred_by_id` cannot be updated · `disqualify()` without an actor throws · `anonymise()` leaves edges intact and personal fields null · reminder offsets and business-key deduplication · reminder stop on verification · `expireUnverified()` honours its limit · expired rows fail the shared counted-status filter.
