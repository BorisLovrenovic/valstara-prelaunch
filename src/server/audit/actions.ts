export const auditActions = [
  'subscriber.disqualified',
  'subscriber.anonymised',
  'fraud.reviewed',
  'referral.milestone_backfilled',
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
