import type { AdminExportRow } from './admin-export.ts';
import type { DatabaseConnection, DatabasePool } from './pool.ts';
import { withTransaction } from './transaction.ts';

export const handoffBatchSize = 500;
export const legacyBonusVoidBatchSize = 100;
export const ineligibleDiscountVoidBatchSize = 100;

export interface HeldDiscountRow {
  readonly id: string;
  readonly subscriber_id: string;
  readonly email_normalised: string;
  readonly tier: number;
}

export interface ConfirmedReferralRow {
  readonly id: string;
  readonly referrer_email_normalised: string;
  readonly referred_email_normalised: string;
}

export interface IneligibleDiscountRow {
  readonly id: string;
  readonly reason: 'owner_disqualified' | 'owner_not_in_handoff';
}

export interface LegacyBonusRow {
  readonly id: string;
}

export interface HandoffSnapshot {
  readonly customerCount: number;
  readonly discountCount: number;
  readonly referralCount: number;
  customers(afterId: string | null): Promise<readonly HandoffCustomerRow[]>;
  discounts(afterId: string | null): Promise<readonly HeldDiscountRow[]>;
  referrals(afterId: string | null): Promise<readonly ConfirmedReferralRow[]>;
  close(): Promise<void>;
}

export interface HandoffCustomerRow extends AdminExportRow {
  readonly survey_version: string | null;
}

export interface UnsubscribeTokenRow {
  readonly id: string;
  readonly token_hash: Buffer;
  readonly email_normalised: string;
  readonly provider: string;
  readonly expires_at: Date;
}

export async function assertCutoverEligible(
  database: DatabasePool,
): Promise<void> {
  const row = await database.readOne<{
    published: boolean;
    open_awards: boolean;
  }>({
    text: `SELECT
      EXISTS (SELECT 1 FROM giveaway_draw WHERE state = 'published') AS published,
      EXISTS (SELECT 1 FROM giveaway_award
        WHERE state NOT IN ('confirmed', 'delivered', 'exhausted')) AS open_awards`,
  });
  if (!row?.published || row.open_awards)
    throw new Error('Handoff requires a published draw and terminal awards.');
}

export async function openUnsubscribeTokenSnapshot(
  database: DatabasePool,
  at: Date,
) {
  const connection = await database.connect();
  let closed = false;
  async function close() {
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
    const count = await connection.readOne<{ total: number; unbound: number }>({
      text: `SELECT
        (SELECT count(*)::int FROM verification_token t
          WHERE t.purpose='unsubscribe' AND t.consumed_at IS NULL AND t.expires_at>$1) AS total,
        (SELECT count(*)::int FROM verification_token t
          WHERE t.purpose='unsubscribe' AND t.consumed_at IS NULL AND t.expires_at>$1
            AND NOT EXISTS (SELECT 1 FROM email_send e WHERE e.unsubscribe_token_id=t.id)) AS unbound`,
      values: [at],
    });
    if (!count || count.unbound !== 0)
      throw new Error('An unexpired unsubscribe token has no email binding.');
    return {
      count: count.total,
      async page(
        afterId: string | null,
      ): Promise<readonly UnsubscribeTokenRow[]> {
        if (closed) throw new Error('Unsubscribe snapshot is closed.');
        return connection.list<UnsubscribeTokenRow>(
          {
            text: `SELECT t.id, t.token_hash, s.email_normalised, e.provider, t.expires_at
            FROM verification_token t
            JOIN email_send e ON e.unsubscribe_token_id=t.id
            JOIN subscriber s ON s.id=t.subscriber_id
            WHERE t.purpose='unsubscribe' AND t.consumed_at IS NULL
              AND t.expires_at>$1 AND ($2::uuid IS NULL OR t.id>$2::uuid)
            ORDER BY t.id`,
            values: [at, afterId],
          },
          handoffBatchSize,
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function voidIneligibleDiscountBatch(
  database: DatabasePool,
  record: (
    connection: DatabaseConnection,
    row: IneligibleDiscountRow,
  ) => Promise<void>,
): Promise<number> {
  return withTransaction(database, async (connection) => {
    const rows = await connection.list<IneligibleDiscountRow>(
      {
        text: `SELECT a.id, CASE WHEN s.status = 'disqualified'
            THEN 'owner_disqualified' ELSE 'owner_not_in_handoff' END AS reason
          FROM milestone_award a JOIN subscriber s ON s.id = a.subscriber_id
          WHERE a.reward_kind = 'discount' AND a.state = 'held'
            AND s.status <> 'erased'
            AND (s.status <> 'verified' OR EXISTS (
              SELECT 1 FROM suppression p WHERE p.email_normalised = s.email_normalised))
          ORDER BY a.awarded_at, a.id FOR UPDATE OF a SKIP LOCKED`,
      },
      ineligibleDiscountVoidBatchSize,
    );
    for (const row of rows) {
      const changed = await connection.execute({
        text: `UPDATE milestone_award SET state = 'void'
          WHERE id = $1 AND reward_kind = 'discount' AND state = 'held'`,
        values: [row.id],
      });
      if (changed !== 1)
        throw new Error('Held discount changed during reconciliation.');
      await record(connection, row);
    }
    return rows.length;
  });
}

export async function voidLegacyBonusBatch(
  database: DatabasePool,
  record: (
    connection: DatabaseConnection,
    row: LegacyBonusRow,
  ) => Promise<void>,
): Promise<number> {
  return withTransaction(database, async (connection) => {
    const rows = await connection.list<LegacyBonusRow>(
      {
        text: `SELECT id FROM milestone_award
          WHERE reward_kind = 'entries' AND state <> 'void'
          ORDER BY awarded_at, id FOR UPDATE SKIP LOCKED`,
      },
      legacyBonusVoidBatchSize,
    );
    for (const row of rows) {
      const changed = await connection.execute({
        text: `UPDATE milestone_award SET state = 'void'
          WHERE id = $1 AND reward_kind = 'entries' AND state <> 'void'`,
        values: [row.id],
      });
      if (changed !== 1)
        throw new Error('Legacy bonus award changed during reconciliation.');
      await record(connection, row);
    }
    return rows.length;
  });
}

export async function openHandoffSnapshot(
  database: DatabasePool,
): Promise<HandoffSnapshot> {
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
    const counts = await connection.readOne<{
      customer_count: number;
      discount_count: number;
      referral_count: number;
    }>({
      text: `SELECT
        (SELECT count(*)::int FROM subscriber s WHERE s.status = 'verified'
          AND NOT EXISTS (SELECT 1 FROM suppression p WHERE p.email_normalised = s.email_normalised)) AS customer_count,
        (SELECT count(*)::int FROM milestone_award a JOIN subscriber s ON s.id = a.subscriber_id
          WHERE a.reward_kind = 'discount' AND a.state = 'held' AND s.status = 'verified'
          AND NOT EXISTS (SELECT 1 FROM suppression p WHERE p.email_normalised = s.email_normalised)) AS discount_count,
        (SELECT count(*)::int FROM referral_edge e
          JOIN subscriber r ON r.id = e.referrer_id JOIN subscriber d ON d.id = e.referred_id
          WHERE e.state = 'confirmed' AND r.status = 'verified' AND d.status = 'verified'
          AND NOT EXISTS (SELECT 1 FROM suppression p WHERE p.email_normalised = r.email_normalised)
          AND NOT EXISTS (SELECT 1 FROM suppression p WHERE p.email_normalised = d.email_normalised)) AS referral_count`,
    });
    if (counts === null) throw new Error('Handoff counts were unavailable.');
    return {
      customerCount: counts.customer_count,
      discountCount: counts.discount_count,
      referralCount: counts.referral_count,
      async customers(afterId) {
        if (closed) throw new Error('Handoff snapshot is closed.');
        return connection.list<HandoffCustomerRow>(
          {
            text: `SELECT s.id, s.email, s.email_normalised, s.referral_tier,
              s.referral_code, s.confirmed_referrals, s.category_preference,
              r.version AS survey_version, s.source, s.marketing_consent_at, s.marketing_consent_version,
              s.marketing_consent_source, s.access_window, s.subslush_customer
            FROM subscriber s LEFT JOIN survey_response r ON r.subscriber_id = s.id
            WHERE s.status = 'verified'
              AND ($1::uuid IS NULL OR s.id > $1::uuid)
              AND NOT EXISTS (SELECT 1 FROM suppression p WHERE p.email_normalised = s.email_normalised)
            ORDER BY s.id`,
            values: [afterId],
          },
          handoffBatchSize,
        );
      },
      async discounts(afterId) {
        if (closed) throw new Error('Handoff snapshot is closed.');
        return connection.list<HeldDiscountRow>(
          {
            text: `SELECT a.id, a.subscriber_id, s.email_normalised, a.tier
            FROM milestone_award a JOIN subscriber s ON s.id = a.subscriber_id
            WHERE a.reward_kind = 'discount' AND a.state = 'held'
              AND s.status = 'verified'
              AND NOT EXISTS (SELECT 1 FROM suppression p WHERE p.email_normalised = s.email_normalised)
              AND ($1::uuid IS NULL OR a.id > $1::uuid)
            ORDER BY a.id`,
            values: [afterId],
          },
          handoffBatchSize,
        );
      },
      async referrals(afterId) {
        if (closed) throw new Error('Handoff snapshot is closed.');
        return connection.list<ConfirmedReferralRow>(
          {
            text: `SELECT e.id, r.email_normalised AS referrer_email_normalised,
              d.email_normalised AS referred_email_normalised
              FROM referral_edge e
              JOIN subscriber r ON r.id = e.referrer_id
              JOIN subscriber d ON d.id = e.referred_id
              WHERE e.state = 'confirmed' AND r.status = 'verified' AND d.status = 'verified'
                AND NOT EXISTS (SELECT 1 FROM suppression p WHERE p.email_normalised = r.email_normalised)
                AND NOT EXISTS (SELECT 1 FROM suppression p WHERE p.email_normalised = d.email_normalised)
                AND ($1::uuid IS NULL OR e.id > $1::uuid)
              ORDER BY e.id`,
            values: [afterId],
          },
          handoffBatchSize,
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
