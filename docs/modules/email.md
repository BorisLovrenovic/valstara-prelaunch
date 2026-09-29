# Module: email

Kind: cross-cutting service. Implements ADR-009. ADR-028 keeps `subslush.com` out of this module entirely.

## Responsibility
Queue, send, retry, suppress, and reconcile — across two providers on two sending domains (`send.valstara.com`, `mail.valstara.com`), without either provider's reputation being able to damage the other's.

## Data owned
`email_send`, `suppression`.

## Exposed interface
```ts
interface EmailService {
  queue(input: { template: TemplateId; subscriberId: string; businessKey: string; provider: ProviderId; payload: ReferencePayload }, transaction?: DatabaseConnection): Promise<boolean>
  dispatch(limit: number): Promise<DispatchSummary>     // batch-capped
  health(): Promise<{ unregisteredQueued: number }>
  suppress(emailNormalised: string, reason: SuppressionReason, source: string): Promise<void>
  isSuppressed(emailNormalised: string): Promise<boolean>
  ingestWebhook(provider: ProviderId, payload: unknown, signature: string): Promise<void>
  quotaProjection(): Promise<ProviderQuota[]>
}

interface EmailProvider {
  readonly id: ProviderId
  readonly sendingDomain: string
  readonly capabilities: { broadcast: boolean; contactSync: boolean; dailyFreeCap: number }
  send(input: { message: Message; idempotencyKey: string; headers: Record<string, string> }): Promise<{ providerMessageId: string }>
}
```

E8-01 dispatch takes injected `EmailProvider` and template-renderer registries.
The renderer produces a typed `Message` with a required plain-text body.
Founder-authorised 2026-09-28, with a same-day URL correction: its `render()`
input also includes `unsubscribePageUrl: string`. Dispatch derives both the
body confirmation URL (`GET /unsubscribe?t=…`) and the RFC 8058 header URL
(`POST /api/unsubscribe?token=…`) once from the same bound token and configured
base URL. The template receives only the confirmation URL and does not mint
tokens or construct unsubscribe URLs. Each template's HTML and plain-text body uses it.
Its delivered subset is `queue({ template, subscriberId, businessKey, provider,
payload }, transaction?)`, `dispatch(limit)` and `health()`; the remaining
target-state methods arrive with their owning tickets. `queue()` returns whether
it inserted a row, so the award workflow audits a notification only once.

## Rules
- **E7-06's provisional winner notices use `EmailService.queue()`**, as do verification, reminder and status-link notices. Winner and reminder keys are deterministic per business event, so concurrent repeats are no-ops. The recorded notification time starts the award response deadline. E8-03 supplies the seventh renderer, with a plain-text alternative, status link, response deadline and governing rules-version link.
- **`businessKey` is unique.** One email per key, enforced by the database. A retry with the same key never produces a second send.
- Verify, status and unsubscribe tokens derive from token IDs with `EMAIL_TOKEN_SECRET`; only their hashes persist. Queue payloads contain reference IDs, never an address, plaintext token or copy. The service reconstructs identical tokens and messages for retries. Rotation invalidates outstanding tokens.
- E8-01 dispatch uses injected provider and template-renderer registries. An unregistered provider or renderer leaves the row queued, consumes no attempt, and is counted in the health signal. Ready rows are selected before unregistered or paused rows, so blocked backlog cannot starve registered mail. E8-02 registers Resend and removes the direct E1-11 test sender; E8-03 registers real renderers.
- E8-02 exports `domainAuthenticationHealth()` with SPF, DKIM and DMARC pass/fail, a sanitized reason code and an injected-clock `checkedAt` per sending domain. The public-DNS check uses no domain-read credential. It compares the DKIM TXT value and the `send.send.valstara.com` and `rsend.send.valstara.com` CNAME targets exactly with non-secret configured values, requires the resolved send return-path TXT to start with `v=spf1`, and reports the policy from a `v=DMARC1` record (`p=none` is valid). Its startup check logs only sanitized codes and raises P1 on a missing or mismatched record without blocking boot. E10-05 displays the exported result. E8-04 and E8-09 likewise export seed-test and quota-consumption/projection health results for E10-05 to display (founder-authorised 2026-09-28).
- Resend keys contain no sandbox marker. In production, boot requires `RESEND_KEY_MODE=live`, rejects any `RESEND_TEST_RECIPIENT`, and permits only the configured From domain `send.valstara.com`; outside production it rejects live mode. This marker proves the intended configuration, not which key is installed. E12-07 evidences in the Resend dashboard that the production key is sending-only and restricted to the transactional domain (founder-authorised 2026-09-28).
- Dispatch holds a bounded set of queued rows with `FOR UPDATE SKIP LOCKED` and retries provider failures using the same business key and deterministic message. Backoff starts at one minute, doubles to a one-hour cap, and gives up after five attempts with a sanitized error code and an operator task. Expired or invalidated tokens fail terminally before a provider call.
- **Suppression is checked at dispatch, not only at queue time.** A suppression written after queueing must still stop the send — that is the whole point of checking twice.
- **Broadcast (marketing) sends also require a verified recipient and re-check current marketing consent at dispatch** (ADR-027). A withdrawal written after queueing stops a broadcast but never a transactional message. An unsubscribe from a marketing message withdraws consent; an unsubscribe from a transactional message, or leaving the waitlist, writes `suppression`.
- Each queued message has an `unsubscribe`-purpose token bound to its `email_send` row. The binding resolves the originating template server-side when the token is consumed; a request body never supplies the recorded source.
- E6-06 consumes a bound unsubscribe token, applies the marketing withdrawal or global suppression, and records its source template and actor in one transaction. A failed write rolls back token consumption and audit; the link remains usable. The one-click `/api/unsubscribe` POST needs no JavaScript, Turnstile or browser `Origin` header. Middleware keeps the origin check on other writes. The confirmation page offers the separate leave-waitlist action.
- A failed unsubscribe emits a P1 alert through the existing webhook. Its task payload has `kind: operator_task`, `task: unsubscribe_apply_failed`, `unsubscribe_token_id`, `email_send_id`, `token_sha256` (hex of the stored token hash), `requested_action` (`message_unsubscribe` or `leave_waitlist`), and `occurred_at`. The IDs may be null if database failure prevented lookup; the member status-token action has no bound email send. The hash and action are always present and come from the request. The hash cannot authenticate and the alert contains no address, plaintext token or IP. The alert itself is the operator task; `npm run email:apply-unsubscribe -- --token-id <id> --actor <name>` or `--token-sha256 <hex>` reuses the transactional service. An explicit leave task adds `--action leave_waitlist`. E8-02 may use this alert format when wiring E8-01's operator-task callback; this ticket does not wire that callback.
- `/me` hosts its own Turnstile-first leave action using the reusable status token. It calls the same unsubscribe service, writes a global suppression with source `member_status`, and moves a verified subscriber to `unsubscribed` so the person is no longer draw-eligible; the email confirmation page accepts only unsubscribe-purpose tokens. Explicit leave from that page makes the same status transition.
- **A send failure never rolls back or blocks the caller's transaction.** The subscriber row is committed first, always.
- **Transactional and broadcast use different providers and different domains** — asserted by a config test, because the isolation is the entire rationale.
- **No sending domain outside `valstara.com` is configured** (ADR-028). The SubSlush announcement is a manual founder send, not a module path.
- **Vendor SDKs live only in `providers/`.** Lint-enforced.
- E8-01's `Message` requires a plain-text body. Dispatch refuses a missing text alternative or bound `unsubscribe` token, and builds RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers from the token and a configured base URL. E6-06 proves the one-click route works; E8-03 supplies real plain-text alternatives for every template.
- E8-03 registers seven real transactional renderers. They use the queued reference payload and the shared copy layer; welcome and milestone read current `ReferralService.status` through the status-token subject. Verification and reminder use the existing `verification_test` and `verification_reminder` queue identifiers. E8-03a later supplies the three missing queue producers and widens the reference-payload constraint for their fields.
- Verification and verification-reminder mail contain no `/me` link while the recipient is unverified; the other five transactional templates carry one (founder-authorised 2026-09-28). All seven contain the bound confirmation-page URL in both HTML and plain text. Its token matches the `List-Unsubscribe` header token, and a GET of the page does not consume it.
- **Webhook signatures are verified before the payload is parsed**, and ingestion is idempotent on the provider event id.
- `quotaProjection()` alerts at a week's headroom. Resend free is 100/day, Brevo free is 300/day — **upgrade before the giveaway opens, not when the limits hit.**

## Dependencies
`db`, `audit`, `subscriber`, `flags`.

## Contract tests
Duplicate business key rejected by the database · suppression written between queue and dispatch stops the send · a provider outage leaves the subscriber row committed · config test on domains and providers · webhook signature verified before parse · replayed webhook is a no-op · dispatch honours its limit · quota projection triggers at the documented headroom.
