# Module: audit

Kind: cross-cutting service.

## Responsibility
An append-only record of every decision a person made and every irreversible action the system took.

## Data owned
`audit_log`.

## Exposed interface
```ts
interface AuditService {
  record(entry: { actor: string; action: AuditAction; subjectType: string; subjectId: string | null; detail?: object }): Promise<void>
  query(filter: AuditFilter, limit: number): Promise<AuditEntry[]>   // admin only, batch-capped
}
```

## Rules
- **The application database role holds `INSERT` and `SELECT` only — no `UPDATE`, no `DELETE`.** Append-only is enforced by permission, not by convention, and a test asserts the rejection at the database level.
- **`detail` never contains a token, a secret, a raw IP address or a full email where the subject id already identifies the row.** A redaction test runs over every call site.
- **`record()` failure on a disqualification or its reversal, an export, a draw, a DSR fulfilment or a marketing-consent change raises an error**, never a warning. Those are exactly the actions whose absence from the record would matter.
- An admin export has no subject row: `export.run` uses `subjectType: 'export'`, a null `subjectId`, and a row count in `detail`, with the authenticated operator as actor. The handoff export uses `subjectType: 'handoff'`, customer, held-coupon and confirmed-referral counts, and the coupons' computed expiry. Each carried coupon records `handoff.coupon_carried` against its coupon ID with that expiry (E11.7-03); `handoff.discount_carried` stays registered for the history written before the milestone tiers were retired; each ineligible-owner void records `handoff.discount_voided` with `owner_disqualified` or `owner_not_in_handoff` in the same transaction as the state change. A legacy bonus-entry void records `handoff.bonus_entries_voided` against its award ID with the operator actor and the published-rules reason in the same transaction as the state change.
- Required actions include `subscriber.disqualified`, `subscriber.disqualification_reversed`, `subscriber.anonymised`, `subscriber.unsubscribed`, `fraud.reviewed`, `fraud.domain_allowed`, `referral.access_window_promoted`, `referral.milestone_backfilled`, `referral.counters_repaired`, `referral.voided`, `referral.unvoided`, `referral.milestone_retired`, `referral.access_window_recalculated`, `survey.response_replaced`, `flag.changed`, `flag.enable_refused`, `export.run`, `draw.executed`, `giveaway.entries_backfilled`, `award.replaced`, `consent.marketing_granted`, `consent.marketing_withdrawn`, `dsr.requested`, `dsr.fulfilled`, `handoff.frozen`, `handoff.bonus_entries_voided`, `handoff.discount_voided`, `handoff.discount_carried`, `handoff.coupon_carried`. Since E11.7-03, `referral.milestone_retired` is written once per retired award by migration 0061, and `referral.access_window_recalculated` by every wave change, with the confirmed count and the windows before and after; `referral.access_window_promoted` and `referral.milestone_backfilled` are no longer written. The code registry in `src/server/audit/actions.ts` is exhaustive; E6-06's unsubscribe event records the server-resolved source template and bound send ID. E8-09 records a refused giveaway enable with the requesting actor and free providers.

## Dependencies
`db` only. **Nothing depends on audit succeeding except the actions listed above** — it must never become a reason a signup fails.

## Contract tests
`UPDATE` and `DELETE` against `audit_log` are rejected **at the database level** · secret-shaped fields are redacted · a failed `record()` on a listed action propagates · access-window recalculations record the confirmed count and the previous and resulting wave · `query()` honours its limit.
