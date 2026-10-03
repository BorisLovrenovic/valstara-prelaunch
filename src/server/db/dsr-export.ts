import type { DatabaseConnection } from './pool.ts';
import { dsrBatchSize } from './dsr.ts';

// This registry is reconciled to the migrated schema and the data model by test.
// to_jsonb includes every column; projection only removes third-party identities.
const handle =
  "substr(translate(encode(sha256(convert_to($1::text,'UTF8')),'base64'),'+/','-_'),1,12)";
const snapshotIds = `SELECT id FROM leaderboard_snapshot WHERE EXISTS
    (SELECT 1 FROM jsonb_array_elements(entries) item WHERE item->>'display_handle'=${handle})`;
export const subjectExportTables = {
  subscriber: 'id=$1',
  verification_token: 'subscriber_id=$1',
  referral_edge: 'referrer_id=$1 OR referred_id=$1',
  milestone_award: 'subscriber_id=$1',
  survey_response: 'subscriber_id=$1',
  giveaway_entry: 'subscriber_id=$1',
  giveaway_draw_snapshot_row: 'subscriber_id=$1',
  giveaway_draw_selection: 'subscriber_id=$1',
  giveaway_award: 'subscriber_id=$1',
  giveaway_award_candidate: 'subscriber_id=$1',
  giveaway_draw_void: 'subscriber_id=$1',
  fraud_flag: `subscriber_id=$1 OR (kind='duplicate_identity'
    AND detail->'matched_subscriber_ids' @> jsonb_build_array($1::text))`,
  email_send: 'subscriber_id=$1',
  top_twenty_review: 'subscriber_id=$1',
  top_twenty_review_batch:
    'id IN (SELECT batch_id FROM top_twenty_review WHERE subscriber_id=$1::uuid)',
  leaderboard_snapshot: `id IN (${snapshotIds})`,
  leaderboard_served_snapshot: `snapshot_id IN (${snapshotIds})`,
  weekly_campaign_run: `snapshot_id IN (${snapshotIds})`,
  suppression:
    'email_normalised=(SELECT email_normalised FROM subscriber WHERE id=$1::uuid)',
  brevo_contact_sync:
    'email_normalised=(SELECT email_normalised FROM subscriber WHERE id=$1::uuid)',
  dsr_erasure: 'subscriber_id=$1',
  erasure_ledger: 'subscriber_id=$1',
  rate_limit_bucket:
    'position($1::text in key)>0 OR position((SELECT email_normalised FROM subscriber WHERE id=$1::uuid) in key)>0',
  giveaway_draw:
    'id IN (SELECT draw_id FROM giveaway_draw_snapshot_row WHERE subscriber_id=$1::uuid)',
  audit_log: `subject_id=$1::text OR subject_id IN (
    SELECT id::text FROM verification_token WHERE subscriber_id=$1::uuid
    UNION SELECT id::text FROM referral_edge WHERE referrer_id=$1::uuid OR referred_id=$1::uuid
    UNION SELECT id::text FROM milestone_award WHERE subscriber_id=$1::uuid
    UNION SELECT id::text FROM survey_response WHERE subscriber_id=$1::uuid
    UNION SELECT id::text FROM giveaway_entry WHERE subscriber_id=$1::uuid
    UNION SELECT id::text FROM giveaway_draw WHERE id IN
      (SELECT draw_id FROM giveaway_draw_snapshot_row WHERE subscriber_id=$1::uuid)
    UNION SELECT id::text FROM giveaway_award WHERE subscriber_id=$1::uuid
    UNION SELECT id::text FROM fraud_flag WHERE subscriber_id=$1::uuid
    UNION SELECT id::text FROM email_send WHERE subscriber_id=$1::uuid
    UNION SELECT batch_id::text FROM top_twenty_review WHERE subscriber_id=$1::uuid
  )`,
} as const;
export type SubjectExportTable = keyof typeof subjectExportTables;
export function exportSubjectPage(
  db: DatabaseConnection,
  table: SubjectExportTable,
  id: string,
  offset: number,
) {
  return db.list<{ data: Record<string, unknown> }>(
    {
      text: `SELECT to_jsonb(t) AS data FROM ${table} t WHERE ${subjectExportTables[table]} ORDER BY to_jsonb(t)::text OFFSET $2`,
      values: [id, offset],
    },
    dsrBatchSize,
  );
}
