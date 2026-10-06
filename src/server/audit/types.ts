import type { AuditAction } from './actions.ts';

export type AuditDetailValue =
  | boolean
  | null
  | number
  | string
  | readonly AuditDetailValue[]
  | { readonly [key: string]: AuditDetailValue };

export type AuditDetail = Readonly<Record<string, AuditDetailValue>>;

export interface AuditRecordInput {
  readonly actor: string;
  readonly action: AuditAction;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly detail?: AuditDetail;
  readonly requestId?: string;
}

export interface AuditFilter {
  readonly action?: AuditAction;
  readonly actor?: string;
  readonly subjectId?: string;
  readonly subjectType?: string;
}

export interface AuditEntry {
  readonly action: AuditAction;
  readonly actor: string;
  readonly at: Date;
  readonly detail: AuditDetail;
  readonly id: string;
  readonly requestId: string | null;
  readonly subjectId: string | null;
  readonly subjectType: string;
}
