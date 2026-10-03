import type { DatabaseConnection } from './pool.ts';

export const dsrBatchSize = 100;
export interface ErasureRow {
  subscriber_id: string;
  requested_at: Date;
  attempts: number;
  next_attempt_at: Date;
  escalated_at: Date | null;
  deadline_alerted_at: Date | null;
  completed_at: Date | null;
}
export interface ErasureSubject {
  id: string;
  email_normalised: string | null;
  status: string;
  signup_ip_prefix_hash: Buffer | null;
}
export function createDsrRepository(db: DatabaseConnection) {
  async function bounded(text: string, values: readonly unknown[]) {
    let count: number;
    do {
      count = await db.execute({ text, values });
    } while (count === dsrBatchSize);
  }
  return {
    async lockDraw() {
      await db.readOne({ text: 'SELECT pg_advisory_xact_lock(705,5)' });
    },
    subject(id: string) {
      return db.readOne<ErasureSubject>({
        text: 'SELECT id, email_normalised, status, signup_ip_prefix_hash FROM subscriber WHERE id=$1 FOR UPDATE',
        values: [id],
      });
    },
    async find(email: string) {
      return db.readOne<{ id: string }>({
        text: `SELECT id FROM subscriber WHERE email_normalised=$1 AND status NOT IN ('erasure_pending','erased') FOR SHARE`,
        values: [email],
      });
    },
    pending(id: string) {
      return db.readOne<ErasureRow>({
        text: 'SELECT * FROM dsr_erasure WHERE subscriber_id=$1 FOR UPDATE',
        values: [id],
      });
    },
    due(now: Date) {
      return db.list<{ subscriber_id: string }>(
        {
          text: `SELECT subscriber_id FROM dsr_erasure WHERE completed_at IS NULL AND next_attempt_at <= $1 ORDER BY next_attempt_at,subscriber_id`,
          values: [now],
        },
        dsrBatchSize,
      );
    },
    async begin(id: string, now: Date) {
      await db.readOne({
        text: "SELECT pg_advisory_xact_lock(hashtext('valstara:leaderboard-publication'))",
      });
      await db.execute({
        text: `INSERT INTO dsr_erasure(subscriber_id,requested_at,next_attempt_at) VALUES($1,$2,$2) ON CONFLICT DO NOTHING`,
        values: [id, now],
      });
      await db.execute({
        text: `UPDATE subscriber SET status='erasure_pending', marketing_consent_at=NULL,marketing_consent_version=NULL,marketing_consent_source=NULL,marketing_opt_in_pending=false,marketing_opt_in_pending_version=NULL WHERE id=$1 AND status <> 'erased'`,
        values: [id],
      });
      let after: string | null = null;
      for (;;) {
        const rows: readonly { id: string }[] = await db.list<{ id: string }>(
          {
            text: 'SELECT id FROM leaderboard_snapshot WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id',
            values: [after],
          },
          dsrBatchSize,
        );
        await db.execute({
          text: 'UPDATE leaderboard_snapshot SET entries=entries WHERE id=ANY($1::uuid[])',
          values: [rows.map((row) => row.id)],
        });
        if (rows.length < dsrBatchSize) break;
        after = rows.at(-1)!.id;
      }
      await db.execute({
        text: `DELETE FROM brevo_contact_sync WHERE email_normalised=(SELECT email_normalised FROM subscriber WHERE id=$1)`,
        values: [id],
      });
      // Old request, signup and resend throttles may contain the address.
      // Remove those copies before the pending state becomes visible.
      await bounded(
        `DELETE FROM rate_limit_bucket WHERE key IN
          (SELECT key FROM rate_limit_bucket WHERE position(
            (SELECT email_normalised FROM subscriber WHERE id=$1) in key)>0 LIMIT 100)`,
        [id],
      );
    },
    async retry(id: string, attempts: number, next: Date) {
      await db.execute({
        text: 'UPDATE dsr_erasure SET attempts=$2,next_attempt_at=$3 WHERE subscriber_id=$1',
        values: [id, attempts, next],
      });
    },
    async alerted(id: string, now: Date, deadline: boolean) {
      await db.execute({
        text: `UPDATE dsr_erasure SET ${deadline ? 'deadline_alerted_at' : 'escalated_at'}=$2, next_attempt_at=$3 WHERE subscriber_id=$1`,
        values: [id, now, new Date(now.getTime() + 86400000)],
      });
    },
    async complete(id: string, now: Date) {
      await db.execute({
        text: 'INSERT INTO erasure_ledger(subscriber_id,erased_at) VALUES($1,$2) ON CONFLICT DO NOTHING',
        values: [id, now],
      });
      await db.execute({
        text: 'UPDATE dsr_erasure SET completed_at=$2 WHERE subscriber_id=$1 AND completed_at IS NULL',
        values: [id, now],
      });
    },
    ledger(after: string | null) {
      return db.list<{ subscriber_id: string; erased_at: Date }>(
        {
          text: 'SELECT subscriber_id,erased_at FROM erasure_ledger WHERE ($1::uuid IS NULL OR subscriber_id>$1) ORDER BY subscriber_id',
          values: [after],
        },
        dsrBatchSize,
      );
    },
    async importLedger(id: string, at: Date) {
      await db.execute({
        text: 'INSERT INTO erasure_ledger(subscriber_id,erased_at) VALUES($1,$2) ON CONFLICT DO NOTHING',
        values: [id, at],
      });
    },
    async erase(subject: ErasureSubject, now: Date, actor: string) {
      const id = subject.id;
      // Locking the entry ledger serialises this with snapshot commitment.
      let after: string | null = null;
      for (;;) {
        const draws: readonly { draw_id: string }[] = await db.list<{
          draw_id: string;
        }>(
          {
            text: `SELECT DISTINCT s.draw_id FROM giveaway_draw_snapshot_row s JOIN giveaway_draw d ON d.id=s.draw_id WHERE s.subscriber_id=$1 AND d.snapshot_committed_at IS NOT NULL AND ($2::uuid IS NULL OR s.draw_id>$2) ORDER BY s.draw_id`,
            values: [id, after],
          },
          dsrBatchSize,
        );
        for (const draw of draws)
          await db.execute({
            text: `INSERT INTO giveaway_draw_void(draw_id,subscriber_id,reason,voided_at,actor) VALUES($1,$2,'erasure',$3,$4) ON CONFLICT DO NOTHING`,
            values: [draw.draw_id, id, now, actor],
          });
        if (draws.length < dsrBatchSize) break;
        after = draws.at(-1)!.draw_id;
      }
      await bounded(
        `UPDATE giveaway_entry SET voided_at=$2 WHERE id IN (SELECT id FROM giveaway_entry WHERE subscriber_id=$1 AND voided_at IS NULL LIMIT 100)`,
        [id, now],
      );
      // Mail is removed before its bound tokens. Nothing identifying remains
      // that could reconstruct a previously emailed bearer credential.
      for (const table of [
        'email_send',
        'verification_token',
        'survey_response',
        'milestone_award',
      ] as const) {
        await bounded(
          `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE subscriber_id=$1 LIMIT 100)`,
          [id],
        );
      }
      await bounded(
        `UPDATE top_twenty_review SET outcome='erased' WHERE subscriber_id=$1
          AND batch_id IN (SELECT batch_id FROM top_twenty_review
            WHERE subscriber_id=$1 AND outcome<>'erased' LIMIT 100)`,
        [id],
      );
      await bounded(
        `UPDATE fraud_flag SET detail='{}'::jsonb WHERE id IN (SELECT id FROM fraud_flag WHERE detail<>'{}'::jsonb AND (subscriber_id=$1 OR detail::text LIKE '%' || $1::text || '%' OR ($2::text IS NOT NULL AND detail->>'local_part'=split_part($2,'@',1))) LIMIT 100)`,
        [id, subject.email_normalised],
      );
      await bounded(
        `UPDATE referral_edge SET referred_id=NULL WHERE id IN (SELECT id FROM referral_edge WHERE referred_id=$1 LIMIT 100)`,
        [id],
      );
      await bounded(
        `UPDATE referral_edge SET referrer_id=NULL,referred_id=NULL WHERE id IN (SELECT id FROM referral_edge WHERE referrer_id=$1 LIMIT 100)`,
        [id],
      );
      await bounded(
        `UPDATE subscriber SET referred_by_id=NULL WHERE id IN (SELECT id FROM subscriber WHERE referred_by_id=$1 LIMIT 100)`,
        [id],
      );
      await db.execute({
        text: 'DELETE FROM brevo_contact_sync WHERE email_normalised=$1',
        values: [subject.email_normalised],
      });
      await db.execute({
        text: 'DELETE FROM suppression WHERE email_normalised=$1',
        values: [subject.email_normalised],
      });
      // Prefix buckets are shared; removing them reveals no other subject.
      await bounded(
        `DELETE FROM rate_limit_bucket WHERE key IN (SELECT key FROM rate_limit_bucket WHERE position($1::text in key)>0 OR ($2::text IS NOT NULL AND position($2 in key)>0) OR ($3::text IS NOT NULL AND position($3 in key)>0) LIMIT 100)`,
        [
          id,
          subject.email_normalised,
          subject.signup_ip_prefix_hash?.toString('hex') ?? null,
        ],
      );
      await db.readOne({
        text: 'SELECT erase_subscriber_identity($1)',
        values: [id],
      });
    },
  };
}
