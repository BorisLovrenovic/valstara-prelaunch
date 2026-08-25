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
  purgeExpired(before: Date, limit: number): Promise<number>
}
```

## Rules
- **Only the SHA-256 of the token is stored.** The plaintext exists in the emailed URL and nowhere else — not in a log line, not in an audit detail, not in an analytics event.
- **`consume()` is single-use and returns `already` on replay**, which the caller renders as success. A person clicking their confirmation link twice has not made a mistake.
- **`expired` and `invalid` produce the identical customer-facing response.** Distinguishing them tells an attacker which tokens exist.
- Tokens carry a **purpose**, and a token issued for one purpose is invalid for another — asserted by test, because a status link that could verify an address would be an account-takeover primitive.
- Expiry is configuration: 7 days for `verify`, 30 for `status`, 90 for `unsubscribe`.

## Dependencies
`db`, `subscriber`, `referral` (confirm edges on verification), `audit`.

## Contract tests
Replay returns `already` · a `status` token rejected by `consume(_, 'verify')` · plaintext absent from every persisted field · expiry honoured under an injected clock · `purgeExpired()` honours its limit · a tampered token and an expired token produce identical output.
