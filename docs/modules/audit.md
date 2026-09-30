# Module: audit

Kind: cross-cutting service.

## Responsibility
An append-only record of every decision a person made and every irreversible action the system took.

## Data owned
`audit_log`.

## Exposed interface
```ts
interface AuditService {
  record(entry: { actor: string; action: AuditAction; subjectType: string; subjectId: string; detail?: object }): Promise<void>
  query(filter: AuditFilter, limit: number): Promise<AuditEntry[]>   // admin only, batch-capped
}
```

## Rules
- **The application database role holds `INSERT` and `SELECT` only — no `UPDATE`, no `DELETE`.** Append-only is enforced by permission, not by convention, and a test asserts the rejection at the database level.
- **`detail` never contains a token, a secret, a raw IP address or a full email where the subject id already identifies the row.** A redaction test runs over every call site.
- **`record()` failure on a disqualification or its reversal, an export, a draw, a DSR fulfilment or a marketing-consent change raises an error**, never a warning. Those are exactly the actions whose absence from the record would matter.
- Required actions include `subscriber.disqualified`, `subscriber.disqualification_reversed`, `subscriber.anonymised`, `subscriber.unsubscribed`, `fraud.reviewed`, `fraud.domain_allowed`, `referral.access_window_promoted`, `referral.milestone_backfilled`, `referral.counters_repaired`, `survey.response_replaced`, `flag.changed`, `flag.enable_refused`, `export.run`, `draw.executed`, `giveaway.entries_backfilled`, `award.replaced`, `consent.marketing_granted`, `consent.marketing_withdrawn`, `dsr.requested`, `dsr.fulfilled`, `handoff.frozen`. The code registry in `src/server/audit/actions.ts` is exhaustive; E6-06's unsubscribe event records the server-resolved source template and bound send ID. E8-09 records a refused giveaway enable with the requesting actor and free providers.

## Dependencies
`db` only. **Nothing depends on audit succeeding except the actions listed above** — it must never become a reason a signup fails.

## Contract tests
`UPDATE` and `DELETE` against `audit_log` are rejected **at the database level** · secret-shaped fields are redacted · a failed `record()` on a listed action propagates · access-window promotions record their previous and resulting tier and wave · `query()` honours its limit.
