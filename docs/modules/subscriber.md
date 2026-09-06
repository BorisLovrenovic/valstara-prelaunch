# Module: subscriber

Kind: domain.

## Responsibility
The waitlist row and its lifecycle: create, normalise, verify, expire, unsubscribe, disqualify, anonymise.

## Data owned
`subscriber` — see `docs/data/model.md#subscriber`.

## Exposed interface
```ts
interface SubscriberService {
  signup(input: SignupInput): Promise<{ subscriber: Subscriber; created: boolean }>
  findByNormalised(email: string): Promise<Subscriber | null>
  markVerified(id: string, at: Date): Promise<void>
  assignAccessWindow(id: string): Promise<AccessWindow>
  expireUnverified(before: Date, limit: number): Promise<number>   // batch-capped
  unsubscribe(id: string, reason: SuppressionReason): Promise<void>
  disqualify(id: string, actor: string, reason: string): Promise<void>
  anonymise(id: string, actor: string): Promise<void>              // DSR erasure
}
```

## Rules
- **`normaliseEmail()` runs before any uniqueness check.** Lowercase, strip `+tag` (all domains), remove dots for **Gmail-family domains only** — `gmail.com` and `googlemail.com`; every other provider keeps its dots. The family is not cross-canonicalised (a `googlemail.com` address is not rewritten to `gmail.com`). The normalised form is the unique key; the raw form is what is displayed and mailed. A malformed address, or one whose local part is emptied by tag/dot removal, is rejected (the function returns `null`); Unicode and internationalised domains never throw. This one step removes the cheapest referral attack entirely.
- **`signup()` is idempotent on `email_normalised`.** A repeat for a `pending` row re-queues the verification mail subject to its own rate limit; a repeat for a `verified` row does not.
- **`referred_by_id` is write-once**, enforced in the schema. Reassignment is a defect, not a feature.
- **`disqualify()` requires an actor and writes an audit record.** There is no code path that sets `disqualified` without one.
- **`anonymise()` never deletes the row** where referral edges reference it — it nulls the personal fields, so counts stay defensible and no personal data remains.
- `referral_tier` and `confirmed_referrals` are **caches** owned by the referral module. This module never writes them directly.
- Every sweep is batch-capped and takes an explicit limit.

## Dependencies
`db`, `audit`, `fraud` (signals at signup), `referral` (edge creation), `email` (queue verification).

## Contract tests
`user+tag@gmail.com`, `u.s.e.r@gmail.com` and `user@gmail.com` collide on one row · a non-Gmail domain keeps its dots · double signup produces one row and one email · `referred_by_id` cannot be updated · `disqualify()` without an actor throws · `anonymise()` leaves edges intact and personal fields null · `expireUnverified()` honours its limit.
