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
  'flag.enable_refused',
  'export.run',
  'draw.executed',
  'giveaway.top_twenty_reviewed',
  'giveaway.top_twenty_review_invalidated',
  'giveaway.entries_backfilled',
  'giveaway.award_notified',
  'giveaway.award_checked',
  'giveaway.award_replaced',
  'giveaway.substitution_offered',
  'giveaway.substitution_replacement',
  'giveaway.substitution_cash',
  'consent.marketing_granted',
  'consent.marketing_withdrawn',
  'subscriber.unsubscribed',
  'dsr.requested',
  'dsr.fulfilled',
  'handoff.frozen',
  'handoff.final_reminders_queued',
  'handoff.bonus_entries_voided',
  'handoff.discount_voided',
  'handoff.discount_carried',
] as const;

export type AuditAction = (typeof auditActions)[number];

const auditActionSet = new Set<string>(auditActions);

export function isAuditAction(action: string): action is AuditAction {
  return auditActionSet.has(action);
}
