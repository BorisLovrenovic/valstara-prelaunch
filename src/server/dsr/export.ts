import { createHash } from 'node:crypto';
import type { DatabaseConnection } from '../db/pool.ts';
import { dsrBatchSize } from '../db/dsr.ts';
import {
  exportSubjectPage,
  subjectExportTables,
  type SubjectExportTable,
} from '../db/dsr-export.ts';

function subjectDetail(value: unknown, id: string): unknown {
  if (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(value) &&
    value !== id
  )
    return null;
  if (Array.isArray(value)) return value.map((item) => subjectDetail(item, id));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        subjectDetail(item, id),
      ]),
    );
  return value;
}
export function ownData(
  table: SubjectExportTable,
  data: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const result = { ...data };
  if (table === 'subscriber') result.referred_by_id = null;
  if (table === 'referral_edge') {
    if (result.referrer_id !== id) result.referrer_id = null;
    if (result.referred_id !== id) result.referred_id = null;
  }
  if (
    table === 'fraud_flag' &&
    typeof result.detail === 'object' &&
    result.detail !== null
  ) {
    // Matched identities and operator free text can concern other people.
    const detail = result.detail as Record<string, unknown>;
    result.detail = Object.fromEntries(
      Object.entries(detail).filter(([key]) =>
        [
          'rule',
          'version',
          'local_part',
          'match_count',
          'domain',
          'window_minutes',
          'count',
          'threshold',
        ].includes(key),
      ),
    );
    if (Array.isArray(detail.matched_subscriber_ids))
      (result.detail as Record<string, unknown>).matched_subscriber_ids =
        detail.matched_subscriber_ids.filter((matched) => matched === id);
  }
  if (table === 'fraud_flag') {
    if (result.subscriber_id !== id) result.subscriber_id = null;
    result.reviewed_by = null;
  }
  if (table === 'audit_log') {
    result.actor = 'redacted';
    result.detail = subjectDetail(result.detail, id);
    result.request_id = null;
  }
  if (table === 'leaderboard_snapshot' && Array.isArray(result.entries)) {
    const handle = createHash('sha256')
      .update(id)
      .digest('base64url')
      .slice(0, 12);
    result.entries = result.entries.filter(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as Record<string, unknown>).display_handle === handle,
    );
  }
  if (table === 'giveaway_draw') {
    result.winners = Array.isArray(result.winners)
      ? result.winners.filter((winner) => winner === id)
      : result.winners;
    result.executed_by = 'redacted';
  }
  if (table === 'top_twenty_review' || table === 'giveaway_draw_void')
    result.actor = 'redacted';
  return result;
}
export async function* exportSubject(
  db: DatabaseConnection,
  id: string,
): AsyncGenerator<string> {
  for (const table of Object.keys(
    subjectExportTables,
  ) as SubjectExportTable[]) {
    for (let offset = 0; ; offset += dsrBatchSize) {
      const rows = await exportSubjectPage(db, table, id, offset);
      for (const row of rows)
        yield JSON.stringify({ table, data: ownData(table, row.data, id) }) +
          '\n';
      if (rows.length < dsrBatchSize) break;
    }
  }
}
