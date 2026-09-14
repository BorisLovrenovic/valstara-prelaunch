export const auditActions = [
  'subscriber.disqualified',
  'subscriber.anonymised',
  'fraud.reviewed',
  'fraud.domain_allowed',
  'referral.access_window_promoted',
  'referral.milestone_backfilled',
  'referral.counters_repaired',
  'flag.changed',
  'export.run',
  'draw.executed',
  'dsr.requested',
  'dsr.fulfilled',
  'handoff.frozen',
] as const;

export type AuditAction = (typeof auditActions)[number];

const auditActionSet = new Set<string>(auditActions);

export function isAuditAction(action: string): action is AuditAction {
  return auditActionSet.has(action);
}
