# Module: fraud

Kind: domain. Implements ADR-013.

## Responsibility
Signals that make referral fraud visible, and the review workflow that decides what to do about it. **This module flags. It never bans.**

## Data owned
`fraud_flag`; the disposable-domain blocklist as configuration; `domain_allow`
for durable operator-approved false-positive overrides.

The blocklist is the `disposable-email-domains` dataset under CC0 1.0, pinned
to commit `28bb67b2b6398e87d6f0ee5bf4f6096420d456ee` (2026-09-14). Its versioned,
checksummed JSON snapshot and provenance notice live beside the module. It is
loaded into an in-memory `Set` at boot and is never fetched at runtime.

**Two `fraud_flag` kinds are written outside this module:** `challenge_timeout`, raised by the signup route when Cloudflare Turnstile is unreachable (ADR-006, E3-03), and `self_referral`, raised by the referral attribution transaction (E4-03). This module owns the remaining kinds and the whole review workflow — it reviews both of these flags like any other, it simply does not raise them.

## Exposed interface
```ts
interface FraudService {
  screen(input: ScreenInput): Promise<ScreenResult>    // { reject?: 'blocked_domain' | 'invalid_email', flags: FlagKind[] }
  allowDomain(domain: string, actor: string): Promise<void>
  raise(subscriberId: string, kind: FlagKind, detail: object): Promise<void>
  review(flagId: string, outcome: 'dismissed' | 'upheld', actor: string): Promise<void>
  openFlags(limit: number): Promise<FraudFlag[]>
  hashIpPrefix(ip: string): Buffer
  purgeIpHashes(before: Date, limit: number): Promise<number>
}
```

## Rules
- Screening order is fixed: normalise the domain; honour `domain_allow`; check
  the versioned blocklist; then perform the MX lookup. The operator invokes
  `npm run fraud:allow-domain -- <domain> <actor>`; actor is required, and the
  override plus `fraud.domain_allowed` audit record commit atomically.
- **Only two outcomes reject at signup**: a disposable domain, and an address with no MX record. Everything else flags and lets the signup through.
- **An MX lookup timeout accepts and flags.** A slow resolver must never cost a real signup — the asymmetry of those two errors is not close.
- MX lookups wait at most 1.5 seconds and cache their result per normalised
  domain for 15 minutes in a 10,000-entry bounded cache. A definitive
  `ENODATA`/`ENOTFOUND` is no MX; other DNS failures take the timeout-style
  accept-and-flag path. That review flag uses the existing `no_mx` kind with an
  `mx_lookup_timeout` reason; a definitive no-MX rejection creates no subscriber
  row and therefore no flag row.
- **`review(_, 'upheld')` is the only path to `disqualified`**, and it requires an actor and writes an audit record.
- **`hashIpPrefix()` truncates before hashing** — IPv4 to /24, IPv6 to /64 — with a server-side pepper held outside the database. **A full IP address is never returned, stored or logged.**
- **`purgeIpHashes()` runs daily and its failure is a compliance alert**, not a hygiene one.
- **The site runs no device-fingerprinting API.** No canvas, font, WebGL or timing entropy collection is invoked by site code. Cloudflare's disclosed server-side IP/TLS/UA security processing under its processor role is separate.
- A velocity flag on a shared network is expected. That is why it is a flag.

## Dependencies
`db`, `audit`, `subscriber`, `referral` (rejecting edges on an upheld flag).

## Contract tests
Blocklist hit rejects · allow override wins and is audited with its actor · MX absent rejects · **MX timeout accepts and flags** · MX timeout is bounded and results are cached per domain · no write path sets `disqualified` outside `review()` · IP hashing is truncated and peppered, and the raw value never appears in any output · purge honours its limit · a repository-wide scan finds no fingerprinting API usage.
