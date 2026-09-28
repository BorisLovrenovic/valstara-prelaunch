import type { DatabaseConnection } from './pool.ts';

export const countedSubscriberStatus = 'verified';

export type VerificationReminderOffsetHours = 1 | 24 | 72;

export interface DueVerificationReminder {
  readonly offset_hours: VerificationReminderOffsetHours;
  readonly subscriber_id: string;
}

export interface SubscriberMaintenanceRepository {
  countCountedSubscribers(): Promise<number>;
  expirePending(before: Date, expiredAt: Date, limit: number): Promise<number>;
  listDueVerificationReminders(
    now: Date,
    limit: number,
  ): Promise<readonly DueVerificationReminder[]>;
  lockPendingSubscriber(subscriberId: string): Promise<boolean>;
}

export function createSubscriberMaintenanceRepository(
  database: DatabaseConnection,
): SubscriberMaintenanceRepository {
  return {
    async countCountedSubscribers() {
      const row = await database.readOne<{ count: string }>({
        text: 'SELECT COUNT(*)::text AS count FROM subscriber WHERE status = $1',
        values: [countedSubscriberStatus],
      });
      return Number(row?.count ?? '0');
    },

    async expirePending(before, expiredAt, limit) {
      assertBatchLimit(limit);
      return database.execute({
        text: `
          UPDATE subscriber AS target
          SET status = 'expired', expired_at = $2, updated_at = $2
          WHERE target.id = ANY (ARRAY(
            SELECT candidate.id
            FROM subscriber AS candidate
            WHERE candidate.status = 'pending' AND candidate.created_at < $1
            ORDER BY candidate.created_at, candidate.id
            LIMIT $3
            FOR UPDATE SKIP LOCKED
          ))
            AND target.status = 'pending'
        `,
        values: [before, expiredAt, limit],
      });
    },

    async listDueVerificationReminders(now, limit) {
      assertBatchLimit(limit);
      return database.list<DueVerificationReminder>(
        {
          text: `
            SELECT subscriber.id AS subscriber_id, reminder.offset_hours
            FROM subscriber
            CROSS JOIN (VALUES (1), (24), (72)) AS reminder(offset_hours)
            LEFT JOIN email_send
              ON email_send.business_key =
                'verify-reminder:' || subscriber.id::text || ':' || reminder.offset_hours::text || 'h'
            WHERE subscriber.status = 'pending'
              AND subscriber.created_at <=
                $1::timestamptz - make_interval(hours => reminder.offset_hours)
              AND email_send.id IS NULL
            ORDER BY subscriber.created_at, reminder.offset_hours, subscriber.id
          `,
          values: [now],
        },
        limit,
      );
    },

    async lockPendingSubscriber(subscriberId) {
      const row = await database.readOne<{ status: string }>({
        text: 'SELECT status FROM subscriber WHERE id = $1 FOR UPDATE',
        values: [subscriberId],
      });
      return row?.status === 'pending';
    },
  };
}

function assertBatchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('A subscriber maintenance limit must be positive.');
  }
}
