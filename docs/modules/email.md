# Module: email

Kind: cross-cutting service. Implements ADR-009. ADR-028 keeps `subslush.com` out of this module entirely.

## Responsibility
Queue, send, retry, suppress, and reconcile — across two providers on two sending domains (`send.valstara.com`, `mail.valstara.com`), without either provider's reputation being able to damage the other's.

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
- **E7-06 queues provisional winner notices directly in `email_send`**, following the existing verification and status-link pattern. Each uses a deterministic business key; concurrent repeats are no-ops. The recorded notification time starts the award response deadline. E8-01 takes over all existing direct inserts (verification, status link and giveaway winner notification) through `queue()` and owns operational dispatch. E8-03 supplies the seventh template, with a plain-text alternative, status link, response deadline and governing rules-version link.
- **`businessKey` is unique.** One email per key, enforced by the database. A retry with the same key never produces a second send.
- **Suppression is checked at dispatch, not only at queue time.** A suppression written after queueing must still stop the send — that is the whole point of checking twice.
- **Broadcast (marketing) sends also re-check current marketing consent at dispatch** (ADR-027). A withdrawal written after queueing stops a broadcast but never a transactional message. An unsubscribe from a marketing message withdraws consent; an unsubscribe from a transactional message, or leaving the waitlist, writes `suppression`.
- Each queued message has an `unsubscribe`-purpose token bound to its `email_send` row. The binding resolves the originating template server-side when the token is consumed; a request body never supplies the recorded source.
- **A send failure never rolls back or blocks the caller's transaction.** The subscriber row is committed first, always.
- **Transactional and broadcast use different providers and different domains** — asserted by a config test, because the isolation is the entire rationale.
- **No sending domain outside `valstara.com` is configured** (ADR-028). The SubSlush announcement is a manual founder send, not a module path.
- **Vendor SDKs live only in `providers/`.** Lint-enforced.
- Every message carries a plain-text alternative and a working RFC 8058 one-click unsubscribe.
- **Webhook signatures are verified before the payload is parsed**, and ingestion is idempotent on the provider event id.
- `quotaProjection()` alerts at a week's headroom. Resend free is 100/day, Brevo free is 300/day — **upgrade before the giveaway opens, not when the limits hit.**

## Dependencies
`db`, `audit`, `subscriber`, `flags`.

## Contract tests
Duplicate business key rejected by the database · suppression written between queue and dispatch stops the send · a provider outage leaves the subscriber row committed · config test on domains and providers · webhook signature verified before parse · replayed webhook is a no-op · dispatch honours its limit · quota projection triggers at the documented headroom.
