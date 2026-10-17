import { setTimeout as sleep } from 'node:timers/promises';
import { createAuditService } from '../audit/service.ts';
import { createDsrRepository, type ErasureRow } from '../db/dsr.ts';
import { createGiveawayAwardRepository } from '../db/giveaway-award.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createAwardService } from '../giveaway/award.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

const day = 86_400_000;
export const erasureRetryDays = 7;
export const erasureDeadlineDays = 30;
export function erasureBackoff(attempt: number): number {
  return Math.min(
    60_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 16),
    3_600_000,
  );
}
export interface ErasureDependencies {
  clock: () => Date;
  deleteContact: (emailNormalised: string) => Promise<void>;
  alerts: AlertTransport;
}
export function createErasureService(
  database: DatabasePool,
  deps: ErasureDependencies,
) {
  const awards = createAwardService(database, {
    clock: deps.clock,
    flags: { isEnabled: async () => true },
  });
  async function audit(
    connection: DatabaseConnection,
    id: string,
    action: 'dsr.requested' | 'dsr.fulfilled',
    actor: string,
    stage: string,
  ) {
    await createAuditService(connection).record({
      action,
      actor,
      subjectType: 'subscriber',
      subjectId: id,
      detail: { operation: 'delete', stage },
    });
  }
  async function finish(
    connection: DatabaseConnection,
    id: string,
    actor: string,
  ) {
    const repo = createDsrRepository(connection);
    const subject = await repo.subject(id);
    if (subject === null) {
      await repo.complete(id, deps.clock());
      return;
    }
    if (subject.status !== 'erased') {
      if (subject.status !== 'erasure_pending')
        await repo.begin(id, deps.clock());
      await awards.excludeErasure(connection, id);
      await repo.erase(subject, deps.clock(), actor);
      await repo.complete(id, deps.clock());
      await audit(connection, id, 'dsr.fulfilled', actor, 'complete');
    }
  }
  async function locks(connection: DatabaseConnection) {
    await createDsrRepository(connection).lockDraw();
    await createGiveawayAwardRepository(connection).lockFlow();
  }
  async function escalation(
    connection: DatabaseConnection,
    row: ErasureRow,
    now: Date,
  ) {
    const age = now.getTime() - row.requested_at.getTime();
    const deadline = age >= 28 * day;
    if (
      row.escalated_at === null ||
      (deadline &&
        (row.deadline_alerted_at === null ||
          now.getTime() - row.deadline_alerted_at.getTime() >= day))
    ) {
      await deps.alerts.send({
        event: deadline
          ? 'dsr_deadline_operator_task'
          : 'dsr_erasure_operator_task',
        severity: 'P1',
        occurredAt: now,
        detail: { subscriber_id: row.subscriber_id },
      });
      await createDsrRepository(connection).alerted(
        row.subscriber_id,
        now,
        deadline,
      );
    } else
      await createDsrRepository(connection).retry(
        row.subscriber_id,
        row.attempts,
        new Date(now.getTime() + day),
      );
  }
  return {
    async requestManually(
      id: string,
      actor: string,
      evidenceRef: string,
    ): Promise<void> {
      if (!actor.trim() || actor === 'system:dsr')
        throw new Error('A human actor is required.');
      if (!/^[A-Za-z0-9_.:-]{1,100}$/u.test(evidenceRef))
        throw new Error(
          'An opaque identity-verification reference is required.',
        );
      await withTransaction(database, async (connection) => {
        await locks(connection);
        const repo = createDsrRepository(connection);
        const subject = await repo.subject(id);
        if (subject === null || subject.status === 'erased')
          throw new Error('Erasure subject is unavailable.');
        if (subject.status === 'erasure_pending') return;
        await repo.begin(id, deps.clock());
        await awards.excludeErasure(connection, id);
        await createAuditService(connection).record({
          action: 'dsr.requested',
          actor,
          subjectType: 'subscriber',
          subjectId: id,
          detail: {
            operation: 'delete',
            stage: 'operator_confirmed',
            evidence_ref: evidenceRef,
          },
        });
      });
    },
    // Called inside the signed-token transaction, never before ownership proof.
    async request(connection: DatabaseConnection, id: string) {
      await locks(connection);
      const repo = createDsrRepository(connection);
      const subject = await repo.subject(id);
      if (
        subject === null ||
        subject.status === 'erased' ||
        subject.status === 'erasure_pending'
      )
        return;
      await repo.begin(id, deps.clock());
      await awards.excludeErasure(connection, id);
      await audit(connection, id, 'dsr.requested', 'subscriber', 'confirmed');
    },
    async run(): Promise<number> {
      const due = await createDsrRepository(database).due(deps.clock());
      let completed = 0;
      for (const { subscriber_id: id } of due) {
        completed += await withTransaction(database, async (connection) => {
          await locks(connection);
          const repo = createDsrRepository(connection);
          const row = await repo.pending(id);
          const now = deps.clock();
          if (
            row === null ||
            row.completed_at !== null ||
            row.next_attempt_at > now
          )
            return 0;
          if (
            now.getTime() - row.requested_at.getTime() >=
            erasureRetryDays * day
          ) {
            await escalation(connection, row, now);
            return 0;
          }
          const subject = await repo.subject(id);
          if (subject?.email_normalised === null || subject === null)
            throw new Error('dsr_subject_unavailable');
          try {
            await deps.deleteContact(subject.email_normalised);
          } catch {
            await repo.retry(
              id,
              row.attempts + 1,
              new Date(now.getTime() + erasureBackoff(row.attempts + 1)),
            );
            return 0;
          }
          // If this transaction fails after DELETE, restart reissues DELETE;
          // provider 404 then permits the same atomic local fulfilment.
          await finish(connection, id, 'system:dsr');
          return 1;
        });
      }
      return completed;
    },
    async completeManually(id: string, actor: string): Promise<void> {
      if (!actor.trim() || actor === 'system:dsr')
        throw new Error('A human actor is required.');
      await withTransaction(database, async (connection) => {
        await locks(connection);
        const row = await createDsrRepository(connection).pending(id);
        if (row === null) throw new Error('No pending erasure request.');
        if (row.completed_at !== null) return;
        await finish(connection, id, actor);
      });
    },
    async reapply(id: string, erasedAt: Date, actor: string): Promise<void> {
      if (!actor.trim()) throw new Error('An actor is required.');
      await withTransaction(database, async (connection) => {
        await locks(connection);
        await createDsrRepository(connection).importLedger(id, erasedAt);
        await finish(connection, id, actor);
      });
    },
  };
}
export async function runErasureJob(
  service: Pick<ReturnType<typeof createErasureService>, 'run'>,
  alerts: AlertTransport,
  clock: () => Date,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    try {
      await service.run();
    } catch {
      try {
        await alerts.send({
          event: 'dsr_job_failed',
          severity: 'P1',
          occurredAt: clock(),
          detail: { code: 'erasure_unavailable' },
        });
      } catch {
        process.stderr.write(
          `${JSON.stringify({ event: 'dsr_alert_failed', code: 'alert_unavailable' })}\n`,
        );
      }
    }
    try {
      await sleep(60_000, undefined, { signal });
    } catch {
      return;
    }
  }
}
