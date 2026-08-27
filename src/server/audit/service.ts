import { randomUUID } from 'node:crypto';

import {
  createAuditLogRepository,
  type AuditLogRepository,
} from '../db/audit-log.ts';
import type { DatabasePool } from '../db/pool.ts';

import { isAuditAction } from './actions.ts';
import { redactAuditDetail } from './redact-detail.ts';
import type { AuditEntry, AuditFilter, AuditRecordInput } from './types.ts';

export const auditQueryMaximumLimit = 100;

export interface AuditService {
  query(filter: AuditFilter, limit: number): Promise<readonly AuditEntry[]>;
  record(entry: AuditRecordInput): Promise<void>;
}

export function createAuditService(database: DatabasePool): AuditService {
  return createAuditServiceWithRepository(createAuditLogRepository(database));
}

export function createAuditServiceWithRepository(
  repository: AuditLogRepository,
): AuditService {
  return {
    async query(filter, limit) {
      assertQueryLimit(limit);
      const rows = await repository.query(filter, limit);

      return rows.map((row) => ({
        action: row.action,
        actor: row.actor,
        at: row.at,
        detail: row.detail,
        id: row.id,
        requestId: row.request_id,
        subjectId: row.subject_id,
        subjectType: row.subject_type,
      }));
    },
    async record(entry) {
      if (!isAuditAction(entry.action)) {
        throw new RangeError(`Unregistered audit action: ${entry.action}`);
      }

      await repository.insert({
        action: entry.action,
        actor: entry.actor,
        detail: redactAuditDetail(entry.detail ?? {}),
        id: randomUUID(),
        requestId: entry.requestId ?? null,
        subjectId: entry.subjectId,
        subjectType: entry.subjectType,
      });
    },
  };
}

function assertQueryLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > auditQueryMaximumLimit) {
    throw new RangeError(
      `Audit query limit must be a positive integer no greater than ${auditQueryMaximumLimit}.`,
    );
  }
}
