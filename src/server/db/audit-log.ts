import type { AuditAction } from '../audit/actions.ts';
import type { AuditDetail } from '../audit/types.ts';

import type { DatabasePool, SqlStatement } from './pool.ts';

export interface AuditLogInsert {
  readonly action: AuditAction;
  readonly actor: string;
  readonly detail: AuditDetail;
  readonly id: string;
  readonly requestId: string | null;
  readonly subjectId: string;
  readonly subjectType: string;
}

export interface AuditLogFilter {
  readonly action?: AuditAction;
  readonly actor?: string;
  readonly subjectId?: string;
  readonly subjectType?: string;
}

export interface AuditLogRow {
  readonly action: AuditAction;
  readonly actor: string;
  readonly at: Date;
  readonly detail: AuditDetail;
  readonly id: string;
  readonly request_id: string | null;
  readonly subject_id: string | null;
  readonly subject_type: string;
}

export interface AuditLogRepository {
  insert(entry: AuditLogInsert): Promise<void>;
  query(filter: AuditLogFilter, limit: number): Promise<readonly AuditLogRow[]>;
}

export function createAuditLogRepository(
  database: DatabasePool,
): AuditLogRepository {
  return {
    async insert(entry) {
      await database.execute({
        text: `
          INSERT INTO audit_log (
            id,
            actor,
            action,
            subject_type,
            subject_id,
            detail,
            request_id
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        `,
        values: [
          entry.id,
          entry.actor,
          entry.action,
          entry.subjectType,
          entry.subjectId,
          JSON.stringify(entry.detail),
          entry.requestId,
        ],
      });
    },
    async query(filter, limit) {
      return database.list<AuditLogRow>(buildAuditLogQuery(filter), limit);
    },
  };
}

function buildAuditLogQuery(filter: AuditLogFilter): SqlStatement {
  const clauses: string[] = [];
  const values: unknown[] = [];

  addClause('action', filter.action);
  addClause('actor', filter.actor);
  addClause('subject_type', filter.subjectType);
  addClause('subject_id', filter.subjectId);

  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

  return {
    text: `
      SELECT id, at, actor, action, subject_type, subject_id, detail, request_id
      FROM audit_log
      ${where}
      ORDER BY at DESC, id DESC
    `,
    values,
  };

  function addClause(column: string, value: string | undefined): void {
    if (value === undefined) {
      return;
    }

    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  }
}
