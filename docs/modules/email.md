# Module: email

Kind: cross-cutting service. Implements ADR-009 and ADR-010.

## Responsibility
Queue, send, retry, suppress, and reconcile — across two providers on three sending domains, without either provider's reputation being able to damage the other's.

## Data owned
`email_send`, `suppression`.

## Exposed interface
```ts
interface EmailService {
  queue(template: TemplateId, subscriberId: string, businessKey: string, data: object): Promise<void>
  dispatch(limit: number): Promise<DispatchSummary>     // batch-capped
  suppress(emailNormalised: string, reason: SuppressionReason, source: string): Promise<void>
  isSuppressed(emailNormalised: string): Promise<boolean>
  ingestWebhook(provider: ProviderId, payload: unknown, signature: string): Promise<void>
  quotaProjection(): Promise<ProviderQuota[]>
}

interface EmailProvider {
  readonly id: ProviderId
  readonly sendingDomain: string
  readonly capabilities: { broadcast: boolean; contactSync: boolean; dailyFreeCap: number }
  send(message: Message): Promise<{ providerMessageId: string }>
}
```

## Rules
- **`businessKey` is unique.** One email per key, enforced by the database. A retry with the same key never produces a second send.
- **Suppression is checked at dispatch, not only at queue time.** A suppression written after queueing must still stop the send — that is the whole point of checking twice.
- Each queued message has an `unsubscribe`-purpose token bound to its `email_send` row. The binding resolves the originating template server-side when the token is consumed; a request body never supplies the recorded source.
- **A send failure never rolls back or blocks the caller's transaction.** The subscriber row is committed first, always.
- **Transactional and broadcast use different providers and different domains** — asserted by a config test, because the isolation is the entire rationale.
- **The migration send's `From` domain is `subslush.com`** — a constant with a test on it, because getting it wrong once is unrecoverable.
- **Vendor SDKs live only in `providers/`.** Lint-enforced.
- Every message carries a plain-text alternative and a working RFC 8058 one-click unsubscribe.
- **Webhook signatures are verified before the payload is parsed**, and ingestion is idempotent on the provider event id.
- `quotaProjection()` alerts at a week's headroom. Resend free is 100/day, Brevo free is 300/day — **upgrade before the giveaway opens, not when the limits hit.**

## Dependencies
`db`, `audit`, `subscriber`, `flags`.

## Contract tests
Duplicate business key rejected by the database · suppression written between queue and dispatch stops the send · a provider outage leaves the subscriber row committed · config test on domains and providers · **the migration `From` domain assertion** · webhook signature verified before parse · replayed webhook is a no-op · dispatch honours its limit · quota projection triggers at the documented headroom.
