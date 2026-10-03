# Module: verification

Kind: domain. Implements ADR-011.

## Responsibility
Single-use, hashed, expiring tokens for three purposes — `verify`, `status`, `unsubscribe` — and the consumption path that turns a pending row into a subscriber.

## Data owned
`verification_token` — see `docs/data/model.md#verification_token`.

## Exposed interface
```ts
interface VerificationService {
  issue(subscriberId: string, purpose: TokenPurpose): Promise<{ token: string; expiresAt: Date }>
  consume(token: string, purpose: TokenPurpose): Promise<ConsumeResult>  // 'verified' | 'already' | 'expired' | 'invalid'
  consumeForVerification(token: string): Promise<{ outcome: ConsumeResult; subscriberId: string | null }>
  consumeForPurpose(token: string, purpose: TokenPurpose): Promise<{ outcome: ConsumeResult; subscriberId: string | null }>
  purgeExpired(before: Date, limit: number): Promise<number>
}

// Collapses a ConsumeResult to what the visitor may see: 'verified'/'already'
// → 'ok', and 'expired'/'invalid' → the identical 'rejected'. The endpoint
// renders from this, so it cannot leak which token hashes exist.
function customerOutcome(result: ConsumeResult): 'ok' | 'rejected'

interface StatusLinkService {
  authenticate(token: string): Promise<
    | { kind: 'authenticated'; subscriberId: string }
    | { kind: 'disabled' }
    | { kind: 'rejected' }
  >
  requestReplacement(input: { token: string; ipPrefixHash: string; challengeTimedOut: boolean }): Promise<'accepted' | 'disabled' | 'rate_limited'>
}
```

`createVerificationService(db, { clock? })` builds the service. It takes a
`DatabaseConnection` (not a pool), so a caller inside a transaction — the
`/verify` transaction (E3-07) — can bind the service to its own connection and
consume a token atomically with the other state transitions. The clock is
injected; nothing calls `Date.now()`. The token is base64url HMAC-SHA256 of its
UUID token ID under the required `EMAIL_TOKEN_SECRET`, generated in this module
and hashed (SHA-256) before it reaches the data layer. The secret is separate
from the IP pepper and is never stored or logged. Rotating it invalidates
outstanding tokens, an accepted cost.

`consumeForVerification()` is the E3-07 transaction-only variant. It returns a
subscriber id only for `verified` and `already`, so the completion service can
apply or render that subscriber's own state without making an invalid or expired
token an existence oracle.

`consumeForPurpose()` exposes the same subject-bound result to token-authenticated
write modules. E6-03 uses it before rate limiting or survey work. A replay remains
a no-op with the same subject, while an invalid, expired or cross-purpose token
never yields a subscriber id.

`createStatusLinkService()` is the E6-04 browser boundary. It authenticates only
the subject bound to a `status` token and never accepts a caller-supplied subject.
An expired status token may request a replacement for that same subject. The
public recovery boundary verifies Turnstile before constructing or calling any
flag, rate-limit, token or email dependency. A provider timeout proceeds under
the strict IP-prefix limit and flags a recognised subscriber for review. The
request is also rate-limited per subscriber and queues a `status_link` email
request; invalid, tampered and cross-purpose values queue nothing and receive
the same public acknowledgement. E8 owns rendering and dispatch of that queued
message.

## Rules
- **Only the SHA-256 of the token is stored.** The plaintext exists in the emailed URL and nowhere else — not in a log line, not in an audit detail, not in an analytics event.
- **`consume()` is single-use and returns `already` on replay**, which the caller renders as success. A person clicking their confirmation link twice has not made a mistake.
- A reusable `status` token still expires on schedule even if it was consumed on an earlier visit. Its expiry is checked before replay classification.
- **`expired` and `invalid` produce the identical customer-facing response.** Distinguishing them tells an attacker which tokens exist.
- Tokens carry a **purpose**, and a token issued for one purpose is invalid for another — asserted by test, because a status link that could verify an address would be an account-takeover primitive.
- Expiry is configuration: 7 days for `verify`, 30 for `status`, 90 for `unsubscribe`.

## Dependencies
`db`, `subscriber`, `referral` (confirm edges on verification), `audit`.

## Contract tests
Replay returns `already` · a `status` token rejected by `consume(_, 'verify')` · plaintext absent from every persisted field · expiry honoured under an injected clock · `purgeExpired()` honours its limit · a tampered token and an expired token produce identical output.

## E9-05 rights links

`dsr_export` and `dsr_delete` are separate single-use purposes with a 24-hour lifetime. Emailed links render an inert confirmation form; POST consumes the matching purpose before rate limiting and rights work, in the same transaction. Replay does not repeat fulfilment. Pending or erased subscribers cannot authenticate with any earlier link. Recovery is a fresh request after expiry.
