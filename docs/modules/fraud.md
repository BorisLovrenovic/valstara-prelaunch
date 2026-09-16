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
  flagDuplicateIdentity(subscriberId: string): Promise<boolean>
  raise(subscriberId: string, kind: FlagKind, detail: object): Promise<void>
  review(flagId: string, outcome: 'dismissed' | 'upheld', actor: string): Promise<void>
  openFlags(limit: number): Promise<FraudFlag[]>
  purgeIpHashes(before: Date, limit: number): Promise<number>
}
```

## Rules
- Screening order is fixed: normalise the domain; honour `domain_allow`; check
  the versioned blocklist; then perform the MX lookup. The operator invokes
  `npm run fraud:allow-domain -- <domain> <actor>`; actor is required, and the
  override plus `fraud.domain_allowed` audit record commit atomically.
- **Only two outcomes reject at signup**: a disposable domain, and an address with no MX record. Everything else flags and lets the signup through.
- The review queue returns at most **50 open flags**. It orders explicit manual
  flags first, then IP velocity, duplicate identity, self-referral, disposable
  domain, challenge timeout and no-MX signals; equal-priority flags are oldest
  first. Each item carries the structured flag detail plus the subject's
  status, domain, country, referral count, tier and verification timestamps, so
  the operator can decide without opening the database. Evidence is recursively
  redacted before it reaches the response, so a legacy/manual detail cannot
  expose a token or raw IP address.
- A newly inserted subscriber raises `duplicate_identity` when the local part of
  `email_normalised` matches an existing subscriber on a different
  `email_domain`. The functional local-part index keeps the lookup off a full
  table scan. Evidence is capped at 20 matched subscriber IDs and records the
  complete match count, local part, rule name and rule version. A repeat signup
  for an existing subscriber is not a new identity and raises no new flag.
- **An MX lookup timeout accepts and flags.** A slow resolver must never cost a real signup — the asymmetry of those two errors is not close.
- MX lookups wait at most 1.5 seconds and cache their result per normalised
  domain for 15 minutes in a 10,000-entry bounded cache. A definitive
  `ENODATA`/`ENOTFOUND` is no MX; other DNS failures take the timeout-style
  accept-and-flag path. That review flag uses the existing `no_mx` kind with an
  `mx_lookup_timeout` reason; a definitive no-MX rejection creates no subscriber
  row and therefore no flag row.
- **`review(_, 'upheld')` is the only path to `disqualified`**, and it requires an actor and writes an audit record.
- At the signup request boundary, **`hashIpPrefix()` truncates before hashing** — IPv4 to /24, IPv6 to /64 — with a server-side pepper held outside the database. Fraud receives only the hash. **A full IP address is never returned, stored or logged.**
- **`purgeIpHashes()` runs daily and its failure is a compliance alert**, not a hygiene one.
- **The site runs no device-fingerprinting API.** No canvas, font, WebGL or timing entropy collection is invoked by site code. Cloudflare's disclosed server-side IP/TLS/UA security processing under its processor role is separate.
- A velocity flag on a shared network is expected. That is why it is a flag.

## Dependencies
`db`, `audit`, `subscriber`, `referral` (rejecting edges on an upheld flag).

## Contract tests
Blocklist hit rejects · allow override wins and is audited with its actor · MX absent rejects · **MX timeout accepts and flags** · MX timeout is bounded and results are cached per domain · cross-domain normalised local-part matches raise a bounded, complete `duplicate_identity` flag without changing subscriber status · dismiss and uphold both record the authenticated actor and an append-only audit entry · the open queue honours its 50-row cap and priority order · fraud responses redact tokens and raw IP addresses · no write path sets `disqualified` outside `review()` · IP hashing is truncated and peppered, and the raw value never appears in any output · purge honours its limit · a repository-wide scan finds no fingerprinting API usage.
