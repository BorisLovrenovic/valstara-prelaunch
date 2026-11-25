import type { DatabaseConnection } from './pool.ts';

// E11.7-13: the partner digest's run record, its audience and the counts its
// renderer reads at dispatch. Every count is of confirmed people only: a
// partner's confirmed, non-voided signups, and verified subscribers for the
// waitlist. Nothing here returns a referred person's identity.

export const maxPartnerDigestBatch = 100;

export type PartnerDigestCadence = 'monthly' | 'weekly';
export type PartnerDigestSkipReason = 'missed_window' | 'note_missing';

export interface PartnerDigestRun {
  readonly state: 'started' | 'skipped' | 'completed';
  readonly skip_reason: PartnerDigestSkipReason | null;
  readonly alerted_at: Date | null;
}

export interface PartnerDigestCandidate {
  readonly partner_id: string;
  readonly subscriber_id: string;
}

export interface PartnerDigestCounts {
  readonly partner_id: string;
  readonly confirmed_total: number;
  readonly confirmed_in_period: number;
  readonly categories: Readonly<Record<string, number>>;
  readonly waitlist_verified_in_period: number;
  readonly waitlist_verified_total: number;
}

/**
 * Who may receive the digest: an active, unpurged partner whose member record
 * is verified and who chose optional programme email (E11.7-09's setting).
 * Marketing consent is neither required nor read (D-071). Suppression is
 * checked by the callers, and again by the email service at dispatch.
 */
const audience = `p.status = 'active'
  AND p.personal_data_purged_at IS NULL
  AND p.nonessential_email_enabled
  AND s.status = 'verified'`;

const unsuppressed = `NOT EXISTS (SELECT 1 FROM suppression x
  WHERE x.email_normalised = s.email_normalised)`;

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxPartnerDigestBatch)
    throw new RangeError('Partner digest batch is out of range.');
}

export function createPartnerDigestRepository(db: DatabaseConnection) {
  return {
    schedule(): Promise<{
      cadence: PartnerDigestCadence;
      send_time: string;
      since: Date;
    } | null> {
      return db.readOne({
        text: 'SELECT cadence, send_time, since FROM partner_digest_schedule WHERE singleton',
      });
    },

    /** Records the schedule in force; a changed schedule takes effect now. */
    async recordSchedule(
      cadence: PartnerDigestCadence,
      sendTime: string,
      now: Date,
    ): Promise<void> {
      await db.execute({
        text: `INSERT INTO partner_digest_schedule (singleton, cadence, send_time, since)
          VALUES (true, $1, $2, $3) ON CONFLICT (singleton) DO UPDATE
          SET cadence = EXCLUDED.cadence, send_time = EXCLUDED.send_time,
            since = EXCLUDED.since
          WHERE partner_digest_schedule.cadence <> EXCLUDED.cadence
            OR partner_digest_schedule.send_time <> EXCLUDED.send_time`,
        values: [cadence, sendTime, now],
      });
    },

    run(period: string): Promise<PartnerDigestRun | null> {
      return db.readOne({
        text: 'SELECT state, skip_reason, alerted_at FROM partner_digest_run WHERE period = $1',
        values: [period],
      });
    },

    async start(
      period: string,
      cadence: PartnerDigestCadence,
      windowStartsAt: Date,
      now: Date,
    ): Promise<void> {
      await db.execute({
        text: `INSERT INTO partner_digest_run
          (period, cadence, window_starts_at, state, recorded_at)
          VALUES ($1, $2, $3, 'started', $4) ON CONFLICT (period) DO NOTHING`,
        values: [period, cadence, windowStartsAt, now],
      });
    },

    /** A skip is final: a skipped period is never started again. */
    async skip(
      period: string,
      cadence: PartnerDigestCadence,
      windowStartsAt: Date,
      reason: PartnerDigestSkipReason,
      now: Date,
    ): Promise<void> {
      await db.execute({
        text: `INSERT INTO partner_digest_run
          (period, cadence, window_starts_at, state, skip_reason, recorded_at)
          VALUES ($1, $2, $3, 'skipped', $4, $5) ON CONFLICT (period) DO UPDATE
          SET state = 'skipped', skip_reason = EXCLUDED.skip_reason,
            recorded_at = EXCLUDED.recorded_at
          WHERE partner_digest_run.state IN ('started', 'completed')`,
        values: [period, cadence, windowStartsAt, reason, now],
      });
    },

    async complete(period: string): Promise<void> {
      await db.execute({
        text: `UPDATE partner_digest_run SET state = 'completed'
          WHERE period = $1 AND state = 'started'`,
        values: [period],
      });
    },

    async markAlerted(period: string, now: Date): Promise<void> {
      await db.execute({
        text: `UPDATE partner_digest_run SET alerted_at = $2
          WHERE period = $1 AND state = 'skipped' AND alerted_at IS NULL`,
        values: [period, now],
      });
    },

    /** Digests of the period still waiting, or expired unsent. */
    async unsent(period: string, template: string): Promise<number> {
      const row = await db.readOne<{ count: string }>({
        text: `SELECT COUNT(*)::text AS count FROM email_send
          WHERE template = $2
            AND business_key LIKE 'partner-digest:' || $1 || ':%'
            AND (state = 'queued' OR last_error = 'send_window_expired')`,
        values: [period, template],
      });
      return Number(row?.count ?? '0');
    },

    eligible(
      period: string,
      limit: number,
    ): Promise<readonly PartnerDigestCandidate[]> {
      assertLimit(limit);
      return db.list<PartnerDigestCandidate>(
        {
          text: `SELECT p.id AS partner_id, p.subscriber_id
            FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
            WHERE ${audience} AND ${unsuppressed}
              AND NOT EXISTS (SELECT 1 FROM email_send e
                WHERE e.business_key = 'partner-digest:' || $1 || ':' || p.id::text)
            ORDER BY p.id`,
          values: [period],
        },
        limit,
      );
    },

    /** Locks the member first, in the order activation and erasure use. */
    lockSubscriber(subscriberId: string) {
      return db.readOne<{ id: string }>({
        text: `SELECT id FROM subscriber WHERE id = $1
          AND status NOT IN ('erasure_pending', 'erased') FOR UPDATE`,
        values: [subscriberId],
      });
    },

    /** Re-checks the audience inside the queueing transaction. */
    lockEligible(partnerId: string, subscriberId: string) {
      return db.readOne<{ id: string }>({
        text: `SELECT p.id FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
          WHERE p.id = $1 AND p.subscriber_id = $2 AND ${audience} AND ${unsuppressed}
          FOR UPDATE OF p`,
        values: [partnerId, subscriberId],
      });
    },

    /**
     * The digest's own dispatch check (D-071): still an active, unpurged
     * partner who keeps optional programme email on, with a verified member
     * record. The email service checks suppression itself.
     */
    async dispatchEligible(subscriberId: string): Promise<boolean> {
      return (
        (await db.readOne({
          text: `SELECT p.id FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
            WHERE s.id = $1 AND ${audience}`,
          values: [subscriberId],
        })) !== null
      );
    },

    /**
     * The renderer's counts for the closed period [start, end), resolved from
     * the digest's status token. The partner's signups are their confirmed,
     * non-voided referrals, as the dashboard counts them; the categories are
     * the dashboard's survey counts; the waitlist counts verified people only.
     */
    counts(input: {
      readonly statusTokenId: string;
      readonly start: Date;
      readonly end: Date;
      readonly surveyVersion: string;
    }): Promise<PartnerDigestCounts | null> {
      return db.readOne<PartnerDigestCounts>({
        text: `
          WITH owner AS (
            SELECT p.id, p.subscriber_id
            FROM verification_token t
            JOIN subscriber s ON s.id = t.subscriber_id
            JOIN partner p ON p.subscriber_id = s.id
            WHERE t.id = $1 AND t.purpose = 'status' AND ${audience}
          ), confirmed AS (
            SELECT e.referred_id, e.confirmed_at
            FROM referral_edge e JOIN owner o ON o.subscriber_id = e.referrer_id
            WHERE e.state = 'confirmed' AND e.voided_at IS NULL
          ), categories AS (
            SELECT category, count(DISTINCT c.referred_id)::int AS count
            FROM confirmed c JOIN survey_response r ON r.subscriber_id = c.referred_id
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(r.answers->'category_preference') = 'array'
                THEN r.answers->'category_preference' ELSE '[]' END
            ) a(category)
            WHERE r.version = $4
            GROUP BY category
          )
          SELECT o.id AS partner_id,
            (SELECT count(*)::int FROM confirmed) AS confirmed_total,
            (SELECT count(*)::int FROM confirmed
              WHERE confirmed_at >= $2 AND confirmed_at < $3) AS confirmed_in_period,
            COALESCE((SELECT jsonb_object_agg(category, count) FROM categories), '{}') AS categories,
            (SELECT count(*)::int FROM subscriber w
              WHERE w.status = 'verified' AND w.verified_at >= $2 AND w.verified_at < $3)
              AS waitlist_verified_in_period,
            (SELECT count(*)::int FROM subscriber w
              WHERE w.status = 'verified' AND w.verified_at IS NOT NULL)
              AS waitlist_verified_total
          FROM owner o`,
        values: [
          input.statusTokenId,
          input.start,
          input.end,
          input.surveyVersion,
        ],
      });
    },
  };
}
