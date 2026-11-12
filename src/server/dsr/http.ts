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
export type DsrOutcome =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'export_used' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'challenge_failed' }
  | { readonly kind: 'export'; readonly body: ReadableStream<Uint8Array> };
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
export interface DsrDependencies {
  clock: () => Date;
  challenge: (token: string) => Promise<TurnstileOutcome>;
  erasure: Pick<ReturnType<typeof createErasureService>, 'request'>;
  alerts: AlertTransport;
}

/**
 * The DSR request and confirmation logic, yielding a typed outcome (E11.5-11t,
 * founder decision 2026-11-12). The `/api/dsr/*` routes turn it into their
 * unchanged JSON responses; `/dsr` renders it on the task card. Turnstile,
 * token consumption, both rate limits, the bounded identical acknowledgement,
 * the audit and the alerts all live here, so both callers share them.
 */
export function createDsrService(
  database: DatabasePool,
  deps: DsrDependencies,
) {
  return async (
    operation: DsrOperation,
    form: FormData,
    ipHash: string,
  ): Promise<DsrOutcome> => {
    const value = form.get('token');
    const token = typeof value === 'string' ? value : '';
    const now = deps.clock();
    if (!form.has('token')) {
      const challenge = form.get('turnstile_token');
      if (typeof challenge !== 'string') return { kind: 'challenge_failed' };
      const checked = await deps.challenge(challenge);
      if (checked === 'rejected') return { kind: 'challenge_failed' };
      // A DSR request cannot silently flag an unknown person; timeout retries.
      if (checked === 'unavailable') return { kind: 'unavailable' };
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
          return { kind: 'rate_limited' };
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
        return { kind: 'accepted' };
      } catch {
        return { kind: 'unavailable' };
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
        return { kind: 'rate_limited' };
      }
      if (consumed.outcome !== 'verified' || consumed.subscriberId === null) {
        await connection.execute({ text: 'COMMIT' });
        // Replay never repeats a write or returns another copy of the export.
        return operation === 'delete'
          ? { kind: 'pending' }
          : consumed.outcome === 'already'
            ? { kind: 'export_used' }
            : { kind: 'invalid' };
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
        return { kind: 'rate_limited' };
      }
      if (operation === 'delete') {
        await deps.erasure.request(connection, id);
        await connection.execute({ text: 'COMMIT' });
        redactLeaderboardSubject(id);
        return { kind: 'pending' };
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
      return { kind: 'export', body: stream };
    } catch {
      await connection.execute({ text: 'ROLLBACK' });
      return { kind: 'unavailable' };
    } finally {
      if (!streaming) connection.release();
    }
  };
}

/** The HTTP status each non-export outcome is served with, on both callers. */
export const dsrOutcomeStatus = {
  accepted: 200,
  pending: 200,
  export_used: 200,
  invalid: 400,
  unavailable: 503,
  rate_limited: 429,
  challenge_failed: 400,
} as const satisfies Record<Exclude<DsrOutcome['kind'], 'export'>, number>;

/** A confirmed export: the NDJSON stream as a download, on both callers. */
export function dsrExportResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      ...headers,
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': 'attachment; filename="valstara-data.ndjson"',
    },
  });
}

/** The `/api/dsr/*` JSON response for an outcome, byte-identical to E9-05's. */
export function dsrResponse(outcome: DsrOutcome): Response {
  switch (outcome.kind) {
    case 'export':
      return dsrExportResponse(outcome.body);
    case 'accepted':
      return response(dsrCopy.accepted);
    case 'pending':
      return response(dsrCopy.pending);
    case 'export_used':
      return response(dsrCopy.exportUsed);
    case 'invalid':
      return response(
        dsrCopy.invalid,
        dsrOutcomeStatus.invalid,
        'invalid_input',
      );
    case 'unavailable':
      return response(
        dsrCopy.unavailable,
        dsrOutcomeStatus.unavailable,
        'unavailable',
      );
    case 'rate_limited':
      return response(
        dsrCopy.rateLimited,
        dsrOutcomeStatus.rate_limited,
        'rate_limited',
      );
    case 'challenge_failed':
      return response(
        dsrCopy.challengeFailed,
        dsrOutcomeStatus.challenge_failed,
        'challenge_failed',
      );
  }
}

export function createDsrHandler(
  database: DatabasePool,
  deps: DsrDependencies,
) {
  const run = createDsrService(database, deps);
  return async (
    operation: DsrOperation,
    request: Request,
    ipHash: string,
  ): Promise<Response> =>
    dsrResponse(
      await run(
        operation,
        await request.formData().catch(() => new FormData()),
        ipHash,
      ),
    );
}
