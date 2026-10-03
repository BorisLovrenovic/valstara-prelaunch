import type { DatabaseConnection } from './pool.ts';

export interface QueuedEmailRow {
  readonly id: string;
  readonly subscriber_id: string;
  readonly template: string;
  readonly provider: string;
  readonly business_key: string;
  readonly payload: Record<string, unknown>;
  readonly unsubscribe_token_id: string | null;
  readonly attempts: number;
  readonly expires_at?: Date | null;
}

export interface EmailRecipientRow {
  readonly email: string;
  readonly email_normalised: string;
  readonly marketing_consent_at: Date | null;
  readonly suppressed: boolean;
  readonly status: string;
}

export function createEmailRepository(database: DatabaseConnection) {
  return {
    async lockBusinessKey(key: string): Promise<void> {
      await database.readOne({
        text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        values: [key],
      });
    },
    async findByBusinessKey(key: string): Promise<{ id: string } | null> {
      return database.readOne<{ id: string }>({
        text: 'SELECT id FROM email_send WHERE business_key = $1',
        values: [key],
      });
    },
    async insert(input: {
      id: string;
      subscriberId: string;
      template: string;
      provider: string;
      businessKey: string;
      payload: Record<string, string | number>;
      unsubscribeTokenId: string;
      now: Date;
      expiresAt?: Date;
    }): Promise<void> {
      await database.execute({
        text: `INSERT INTO email_send
          (id, subscriber_id, template, provider, business_key, payload,
          unsubscribe_token_id, state, created_at, updated_at, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'queued', $8, $8, $9)`,
        values: [
          input.id,
          input.subscriberId,
          input.template,
          input.provider,
          input.businessKey,
          JSON.stringify(input.payload),
          input.unsubscribeTokenId,
          input.now,
          input.expiresAt ?? null,
        ],
      });
    },
    listDue(
      now: Date,
      limit: number,
      providers: readonly string[],
      templates: readonly string[],
      eligible: boolean,
    ): Promise<readonly QueuedEmailRow[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new RangeError(
          'Email dispatch limit must be between 1 and 1000.',
        );
      }
      return database.list<QueuedEmailRow>(
        {
          text: `WITH due AS (
          SELECT id FROM email_send
          WHERE state = 'queued'
            AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
            AND ((provider = ANY($3::text[]) AND template = ANY($4::text[])) = $5)
          ORDER BY created_at, id
          LIMIT $2 FOR UPDATE SKIP LOCKED
        ) SELECT e.id, e.subscriber_id, e.template, e.provider,
          e.business_key, e.payload, e.unsubscribe_token_id, e.attempts, e.expires_at
          FROM email_send e JOIN due ON due.id = e.id
          ORDER BY e.created_at, e.id`,
          values: [now, limit, providers, templates, eligible],
        },
        limit,
      );
    },
    recipient(subscriberId: string): Promise<EmailRecipientRow | null> {
      return database.readOne<EmailRecipientRow>({
        text: `SELECT s.email, s.email_normalised, s.marketing_consent_at,
          s.status, EXISTS (SELECT 1 FROM suppression x
            WHERE x.email_normalised = s.email_normalised) AS suppressed
          FROM subscriber s WHERE s.id = $1 AND s.status NOT IN ('erasure_pending','erased') FOR SHARE OF s`,
        values: [subscriberId],
      });
    },
    tokenById(id: string): Promise<{
      purpose: string;
      subscriber_id: string;
      token_hash: Buffer;
      expires_at: Date;
    } | null> {
      return database.readOne({
        text: `SELECT purpose, subscriber_id, token_hash, expires_at
          FROM verification_token WHERE id = $1`,
        values: [id],
      });
    },
    async markSent(
      id: string,
      providerMessageId: string,
      now: Date,
    ): Promise<void> {
      await database.execute({
        text: `UPDATE email_send SET state = 'sent', attempts = attempts + 1,
          accepted_at = COALESCE(accepted_at, $3),
          provider_message_id = $2, updated_at = $3, next_attempt_at = NULL,
          last_error = NULL WHERE id = $1 AND state = 'queued'`,
        values: [id, providerMessageId, now],
      });
    },
    async markDeferred(
      id: string,
      now: Date,
      next: Date,
      code: string,
    ): Promise<void> {
      await database.execute({
        text: `UPDATE email_send SET attempts = attempts + 1,
          next_attempt_at = $2, last_error = $3, updated_at = $4
          WHERE id = $1 AND state = 'queued'`,
        values: [id, next, code, now],
      });
    },
    async markFailed(id: string, now: Date, code: string): Promise<void> {
      await database.execute({
        text: `UPDATE email_send SET state = 'failed', attempts = attempts + 1,
          last_error = $2, next_attempt_at = NULL, updated_at = $3
          WHERE id = $1 AND state = 'queued'`,
        values: [id, code, now],
      });
    },
    countUnregistered(
      providers: readonly string[],
      templates: readonly string[],
    ): Promise<number> {
      return database
        .readOne<{ count: string }>({
          text: `SELECT COUNT(*)::text AS count FROM email_send
          WHERE state = 'queued'
            AND (NOT (provider = ANY($1::text[]))
              OR NOT (template = ANY($2::text[])))`,
          values: [providers, templates],
        })
        .then((row) => Number(row?.count ?? '0'));
    },
  };
}
