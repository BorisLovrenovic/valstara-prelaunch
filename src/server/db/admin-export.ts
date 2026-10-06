import type { DatabaseClient, DatabasePool } from './pool.ts';
import { countedSubscriberStatus } from './subscriber-maintenance.ts';

export const adminExportBatchSize = 500;

export interface AdminExportRow {
  readonly id: string;
  readonly email: string;
  readonly email_normalised: string;
  readonly referral_tier: number;
  readonly referral_code: string | null;
  readonly confirmed_referrals: number;
  readonly category_preference: string[] | null;
  readonly source: string | null;
  readonly marketing_consent_at: Date | null;
  readonly marketing_consent_version: string | null;
  readonly marketing_consent_source: string | null;
  readonly access_window: string | null;
  readonly subslush_customer: boolean;
}

export interface AdminExportSnapshot {
  readonly rowCount: number;
  page(
    afterId: string | null,
    limit: number,
  ): Promise<readonly AdminExportRow[]>;
  close(): Promise<void>;
}

export async function openAdminExportSnapshot(
  database: DatabasePool,
): Promise<AdminExportSnapshot> {
  const connection = await database.connect();
  let closed = false;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await connection.execute({ text: 'ROLLBACK' });
    } finally {
      connection.release();
    }
  }

  try {
    await connection.execute({
      text: 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    });
    const count = await connection.readOne<{ row_count: number }>({
      text: `SELECT count(*)::int AS row_count FROM subscriber s
        WHERE s.status = $1 AND NOT EXISTS (
          SELECT 1 FROM suppression p WHERE p.email_normalised = s.email_normalised
        )`,
      values: [countedSubscriberStatus],
    });
    if (count === null)
      throw new Error('Export snapshot count was unavailable.');

    return {
      rowCount: count.row_count,
      async page(afterId, limit) {
        if (closed) throw new Error('Export snapshot is closed.');
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > adminExportBatchSize
        ) {
          throw new RangeError('Export page limit is outside its batch cap.');
        }
        return exportPage(connection, afterId, limit);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function exportPage(
  connection: DatabaseClient,
  afterId: string | null,
  limit: number,
): Promise<readonly AdminExportRow[]> {
  return connection.list<AdminExportRow>(
    {
      text: `SELECT s.id, s.email, s.email_normalised, s.referral_tier,
          s.referral_code, s.confirmed_referrals, s.category_preference,
          s.source, s.marketing_consent_at, s.marketing_consent_version,
          s.marketing_consent_source, s.access_window, s.subslush_customer
        FROM subscriber s
        WHERE s.status = $1
          AND ($2::uuid IS NULL OR s.id > $2::uuid)
          AND NOT EXISTS (
            SELECT 1 FROM suppression p WHERE p.email_normalised = s.email_normalised
          )
        ORDER BY s.id`,
      values: [countedSubscriberStatus, afterId],
    },
    limit,
  );
}
