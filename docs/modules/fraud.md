# Module: fraud

Kind: domain. Implements ADR-013.

## Responsibility
Signals that make referral fraud visible, and the review workflow that decides what to do about it. **This module flags. It never bans.**

## Data owned
`fraud_flag`; the disposable-domain blocklist as configuration.

**One `fraud_flag` kind is written outside this module:** `challenge_timeout`, raised by the signup route when Cloudflare Turnstile is unreachable (ADR-006, E3-03). This module owns every other kind and the whole review workflow — it reviews `challenge_timeout` flags like any other, it simply does not raise them.

## Exposed interface
```ts
interface FraudService {
  screen(input: ScreenInput): Promise<ScreenResult>    // { reject?: 'blocked_domain' | 'invalid_email', flags: FlagKind[] }
  raise(subscriberId: string, kind: FlagKind, detail: object): Promise<void>
  review(flagId: string, outcome: 'dismissed' | 'upheld', actor: string): Promise<void>
  openFlags(limit: number): Promise<FraudFlag[]>
  hashIpPrefix(ip: string): Buffer
  purgeIpHashes(before: Date, limit: number): Promise<number>
}
```

## Rules
- **Only two outcomes reject at signup**: a disposable domain, and an address with no MX record. Everything else flags and lets the signup through.
- **An MX lookup timeout accepts and flags.** A slow resolver must never cost a real signup — the asymmetry of those two errors is not close.
- **`review(_, 'upheld')` is the only path to `disqualified`**, and it requires an actor and writes an audit record.
- **`hashIpPrefix()` truncates before hashing** — IPv4 to /24, IPv6 to /64 — with a server-side pepper held outside the database. **A full IP address is never returned, stored or logged.**
- **`purgeIpHashes()` runs daily and its failure is a compliance alert**, not a hygiene one.
- **No fingerprinting.** No canvas, font, WebGL or timing entropy collection exists anywhere in the codebase — it would require consent, and reward gating already makes the fraud class unprofitable.
- A velocity flag on a shared network is expected. That is why it is a flag.

## Dependencies
`db`, `audit`, `subscriber`, `referral` (rejecting edges on an upheld flag).

## Contract tests
Blocklist hit rejects · MX absent rejects · **MX timeout accepts and flags** · no write path sets `disqualified` outside `review()` · IP hashing is truncated and peppered, and the raw value never appears in any output · purge honours its limit · a repository-wide scan finds no fingerprinting API usage.
