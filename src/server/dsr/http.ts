import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { dsrCopy } from '../../copy/dsr.ts';
import { createAuditService } from '../audit/service.ts';
import { createDsrRepository } from '../db/dsr.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import { consumeRateLimit } from '../ratelimit/consume.ts';
import { normaliseEmail } from '../subscriber/normalise-email.ts';
import { createVerificationService } from '../verification/service.ts';
import { redactLeaderboardSubject } from '../leaderboard/runtime.ts';
import type { TurnstileOutcome } from '../turnstile/verify.ts';
import { exportSubject } from './export.ts';
import type { createErasureService } from './service.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

export type DsrOperation = 'export' | 'delete';
const windowMs = 15 * 60_000;
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Type': 'application/json; charset=utf-8',
};
function response(message: string, status = 200, code?: string) {
  return new Response(
    JSON.stringify(code ? { error: { code, message } } : { message }),
    { status, headers },
  );
}
export function createDsrHandler(
  database: DatabasePool,
  deps: {
    clock: () => Date;
    challenge: (token: string) => Promise<TurnstileOutcome>;
    erasure: Pick<ReturnType<typeof createErasureService>, 'request'>;
    alerts: AlertTransport;
  },
) {
  return async (
    operation: DsrOperation,
    request: Request,
    ipHash: string,
  ): Promise<Response> => {
    const form = await request.formData().catch(() => new FormData());
    const value = form.get('token');
    const token = typeof value === 'string' ? value : '';
    const now = deps.clock();
    if (!form.has('token')) {
      const challenge = form.get('turnstile_token');
      if (typeof challenge !== 'string')
        return response(dsrCopy.challengeFailed, 400, 'challenge_failed');
      const checked = await deps.challenge(challenge);
      if (checked === 'rejected')
        return response(dsrCopy.challengeFailed, 400, 'challenge_failed');
      // A DSR request cannot silently flag an unknown person; timeout retries.
      if (checked === 'unavailable')
        return response(dsrCopy.unavailable, 503, 'unavailable');
      try {
        const email = normaliseEmail(String(form.get('email') ?? ''));
        if (
          !ipHash ||
          (await consumeRateLimit(
            database,
            `dsr:ip:${ipHash}`,
            windowMs,
            now,
          )) > 5
        )
          return response(dsrCopy.rateLimited, 429, 'rate_limited');
        const work = withTransaction(database, async (connection) => {
          const subject =
            email === null
              ? null
              : await createDsrRepository(connection).find(email.normalised);
          await createAuditService(connection).record({
            action: 'dsr.requested',
            actor: 'requester',
            subjectType: 'subscriber',
            subjectId: subject?.id ?? 'unknown',
            detail: { operation, stage: 'link_requested' },
          });
          if (subject === null) return;
          const issued = await createVerificationService(connection, {
            clock: deps.clock,
          }).issue(subject.id, `dsr_${operation}`);
          await createEmailQueue(database, deps.clock).queue(
            {
              subscriberId: subject.id,
              provider: 'resend',
              template: `dsr_${operation}`,
              businessKey: `dsr:${operation}:${subject.id}:${randomUUID()}`,
              payload: { token_id: issued.id },
            },
            connection,
          );
        }).catch(async () => {
          try {
            await deps.alerts.send({
              event: 'dsr_request_failed',
              severity: 'P1',
              occurredAt: deps.clock(),
              detail: { operation },
            });
          } catch {
            process.stderr.write(
              `${JSON.stringify({ event: 'dsr_request_alert_failed', code: 'alert_unavailable' })}\n`,
            );
          }
        });
        // Known and unknown addresses have the same bounded acknowledgement.
        const deadline = sleep(500);
        await Promise.race([work, deadline]);
        await deadline;
        void work;
        return response(dsrCopy.accepted);
      } catch {
        return response(dsrCopy.unavailable, 503, 'unavailable');
      }
    }
    const connection = await database.connect();
    let streaming = false;
    try {
      await connection.execute({
        text: 'BEGIN ISOLATION LEVEL REPEATABLE READ',
      });
      const consumed = await createVerificationService(connection, {
        clock: deps.clock,
      }).consumeForPurpose(token, `dsr_${operation}`);
      // Every confirmation attempt spends the IP bucket after token lookup,
      // including invalid, expired, wrong-purpose and replayed links.
      if (
        !ipHash ||
        (await consumeRateLimit(
          database,
          `dsr:confirm:ip:${ipHash}`,
          windowMs,
          now,
        )) > 5
      ) {
        await connection.execute({ text: 'ROLLBACK' });
        return response(dsrCopy.rateLimited, 429, 'rate_limited');
      }
      if (consumed.outcome !== 'verified' || consumed.subscriberId === null) {
        await connection.execute({ text: 'COMMIT' });
        // Replay never repeats a write or returns another copy of the export.
        return operation === 'delete'
          ? response(dsrCopy.pending)
          : consumed.outcome === 'already'
            ? response(dsrCopy.exportUsed)
            : response(dsrCopy.invalid, 400, 'invalid_input');
      }
      const id = consumed.subscriberId;
      // Independent rate transaction persists a rejected subject attempt, while
      // rolling back token consumption keeps a rate-limited link usable later.
      if (
        (await consumeRateLimit(
          database,
          `dsr:confirm:subject:${id}`,
          windowMs,
          now,
        )) > 5
      ) {
        await connection.execute({ text: 'ROLLBACK' });
        return response(dsrCopy.rateLimited, 429, 'rate_limited');
      }
      if (operation === 'delete') {
        await deps.erasure.request(connection, id);
        await connection.execute({ text: 'COMMIT' });
        redactLeaderboardSubject(id);
        return response(dsrCopy.pending);
      }
      await createAuditService(connection).record({
        action: 'dsr.requested',
        actor: 'subscriber',
        subjectType: 'subscriber',
        subjectId: id,
        detail: { operation, stage: 'confirmed' },
      });
      const iterator = exportSubject(connection, id);
      const encoder = new TextEncoder();
      let closed = false;
      async function close(commit: boolean) {
        if (closed) return;
        closed = true;
        try {
          await connection.execute({ text: commit ? 'COMMIT' : 'ROLLBACK' });
        } finally {
          connection.release();
        }
      }
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await iterator.next();
            if (item.done) {
              await createAuditService(connection).record({
                action: 'dsr.fulfilled',
                actor: 'subscriber',
                subjectType: 'subscriber',
                subjectId: id,
                detail: { operation },
              });
              await close(true);
              controller.close();
            } else controller.enqueue(encoder.encode(item.value));
          } catch (error) {
            await close(false);
            controller.error(error);
          }
        },
        async cancel() {
          await iterator.return(undefined);
          await close(false);
        },
      });
      streaming = true;
      return new Response(stream, {
        headers: {
          ...headers,
          'Content-Type': 'application/x-ndjson',
          'Content-Disposition': 'attachment; filename="valstara-data.ndjson"',
        },
      });
    } catch {
      await connection.execute({ text: 'ROLLBACK' });
      return response(dsrCopy.unavailable, 503, 'unavailable');
    } finally {
      if (!streaming) connection.release();
    }
  };
}
