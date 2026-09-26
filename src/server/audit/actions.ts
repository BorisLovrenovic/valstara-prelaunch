export const auditActions = [
  'subscriber.disqualified',
  'subscriber.disqualification_reversed',
  'subscriber.anonymised',
  'fraud.reviewed',
  'fraud.domain_allowed',
  'referral.access_window_promoted',
  'referral.milestone_backfilled',
  'referral.counters_repaired',
  'survey.response_replaced',
  'flag.changed',
  'export.run',
  'draw.executed',
  'giveaway.top_twenty_reviewed',
  'giveaway.top_twenty_review_invalidated',
  'giveaway.entries_backfilled',
  'consent.marketing_granted',
  'consent.marketing_withdrawn',
  'dsr.requested',
  'dsr.fulfilled',
  'handoff.frozen',
] as const;

export type AuditAction = (typeof auditActions)[number];

const auditActionSet = new Set<string>(auditActions);

export function isAuditAction(action: string): action is AuditAction {
  return auditActionSet.has(action);
}
