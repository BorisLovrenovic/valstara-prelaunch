import { createHash } from 'node:crypto';

import { createAuditService } from '../audit/service.ts';
import { redactAuditDetail } from '../audit/redact-detail.ts';
import type { AuditAction } from '../audit/actions.ts';
import type { AuditDetail } from '../audit/types.ts';
import { createPartnerAttributionRepository } from '../db/partner-attribution.ts';
import {
  createPartnerReviewRepository,
  partnerFlaggedReferralLimit,
  partnerListPageLimit,
  type PartnerContractSigning,
  type PartnerDetailRow,
  type PartnerFlaggedReferral,
  type PartnerListRow,
  type PartnerReferralSummary,
  type PartnerReviewRow,
  type PartnerStatus,
} from '../db/partner-review.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import {
  createPartnerCodeRules,
  type PartnerCodeRefusalReason,
} from '../referral/partner-code.ts';
import { recomputeReferralRewards } from '../referral/rewards.ts';
import { createVerificationService } from '../verification/service.ts';

import { activatePartnerCode } from './activation.ts';
import {
  partnerApprovedBusinessKey,
  partnerApprovedTemplate,
  partnerRejectedBusinessKey,
  partnerRejectedTemplate,
} from './review-email.ts';
import {
  partnerApplicationLimits,
  partnerContractVersionPattern,
  partnerReviewLimits,
  partnerStaleAfterMs,
  partnerTypes,
  type PartnerType,
} from './config.ts';

// E11.7-06: the founder's review, contract and lifecycle commands
// (docs/features/admin.md#partners, founder decisions D-052). Every command
// runs in one transaction that locks the partner row, checks the transition,
// writes it, and records an audit entry with the authenticated actor and the
// before and after values. The database refuses every transition outside the
// eleven documented ones (migration 0063), so a command that slipped past the
// checks here would still fail. Fraud signals never act here: founders decide.

export {
  partnerApprovedBusinessKey,
  partnerApprovedTemplate,
  partnerRejectedBusinessKey,
  partnerRejectedTemplate,
} from './review-email.ts';

export const partnerStatuses = [
  'unconfirmed',
  'applied',
  'approved',
  'contract_sent',
  'active',
  'paused',
  'terminated',
  'rejected',
] as const satisfies readonly PartnerStatus[];

/** The eleven transitions the database allows (D-052 Q1). */
export const partnerTransitions: readonly (readonly [
  PartnerStatus,
  PartnerStatus,
])[] = [
  ['unconfirmed', 'applied'],
  ['applied', 'approved'],
  ['applied', 'rejected'],
  ['approved', 'contract_sent'],
  ['approved', 'rejected'],
  ['contract_sent', 'active'],
  ['contract_sent', 'rejected'],
  ['active', 'paused'],
  ['active', 'terminated'],
  ['paused', 'active'],
  ['paused', 'terminated'],
];

/** The statuses `partners list --stale` watches (standing rule 14). */
export const partnerWaitingStatuses: readonly PartnerStatus[] = [
  'applied',
  'approved',
  'contract_sent',
];

/** What is wrong with a malformed request; each has its copy-layer message. */
export type PartnerInputProblem =
  | 'partnerId'
  | 'actor'
  | 'date'
  | 'contractVersion'
  | 'contractReference'
  | 'signedInFuture'
  | 'signedBeforeSent'
  | 'status'
  | 'type'
  | 'university'
  | 'universityNotAllowed'
  | 'notes';

/** The request itself is malformed. */
export class PartnerReviewInputError extends RangeError {
  public readonly problem: PartnerInputProblem;

  public constructor(problem: PartnerInputProblem) {
    super(`The partner command input is invalid: ${problem}.`);
    this.name = 'PartnerReviewInputError';
    this.problem = problem;
  }
}

export type PartnerReviewRefusal =
  'not_found' | 'purged' | 'wrong_status' | 'code_refused';

/** The request is well formed, but the partner's state refuses it. */
export class PartnerReviewRefusedError extends Error {
  public readonly refusal: PartnerReviewRefusal;
  public readonly status: PartnerStatus | null;
  public readonly codeReason: PartnerCodeRefusalReason | null;
  public readonly alternatives: readonly string[];

  public constructor(
    refusal: PartnerReviewRefusal,
    detail: {
      readonly status?: PartnerStatus;
      readonly codeReason?: PartnerCodeRefusalReason;
      readonly alternatives?: readonly string[];
    } = {},
  ) {
    super(`The partner command was refused: ${refusal}.`);
    this.name = 'PartnerReviewRefusedError';
    this.refusal = refusal;
    this.status = detail.status ?? null;
    this.codeReason = detail.codeReason ?? null;
    this.alternatives = detail.alternatives ?? [];
  }
}

export interface PartnerReviewState {
  readonly status: PartnerStatus;
  readonly status_changed_at: string;
  readonly partner_type: string;
  readonly code: string | null;
  readonly code_active: boolean | null;
  readonly contract_sent_at: string | null;
  readonly contract_signed_at: string | null;
  readonly contract_version: string | null;
}

export interface PartnerCommandResult {
  readonly partnerId: string;
  readonly before: PartnerReviewState;
  readonly after: PartnerReviewState;
  /** Whether a review email was queued (approve, and reject with a template). */
  readonly mailQueued: boolean | null;
}

export interface PartnerListInput {
  readonly status?: string | undefined;
  readonly type?: string | undefined;
  /** `YYYY-MM-DD` (UTC), on `applied_at`. */
  readonly since?: string | undefined;
  readonly stale?: boolean | undefined;
  readonly after?: string | undefined;
}

export interface PartnerListResult {
  readonly partners: readonly (PartnerListRow & { readonly stale: boolean })[];
  /** The last partner's id when the page is full: pass it as `after`. */
  readonly nextAfter: string | null;
}

export interface PartnerShowResult {
  readonly partner: PartnerDetailRow & { readonly stale: boolean };
  readonly referrals: PartnerReferralSummary;
  readonly flaggedReferrals: readonly PartnerFlaggedReferral[];
}

export interface PartnerContractInput {
  readonly date: unknown;
  readonly version: unknown;
  readonly reference?: unknown;
}

export interface PartnerReviewService {
  list(input: PartnerListInput, actor: string): Promise<PartnerListResult>;
  show(id: string, actor: string): Promise<PartnerShowResult>;
  approve(
    id: string,
    code: string | null,
    actor: string,
  ): Promise<PartnerCommandResult>;
  reject(
    id: string,
    sendTemplate: boolean,
    actor: string,
  ): Promise<PartnerCommandResult>;
  contractSent(id: string, actor: string): Promise<PartnerCommandResult>;
  contractSigned(
    id: string,
    contract: PartnerContractInput,
    actor: string,
  ): Promise<PartnerCommandResult>;
  pause(id: string, actor: string): Promise<PartnerCommandResult>;
  terminate(id: string, actor: string): Promise<PartnerCommandResult>;
  reactivate(id: string, actor: string): Promise<PartnerCommandResult>;
  setType(
    id: string,
    partnerType: unknown,
    university: unknown,
    actor: string,
  ): Promise<PartnerCommandResult>;
  note(id: string, text: unknown, actor: string): Promise<PartnerCommandResult>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const lineControlCharacter = /[\u0000-\u001f\u007f]/u;
// Notes may span lines; every other control character is refused.
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const notesControlCharacter = /[\u0000-\u0008\u000b-\u001f\u007f]/u;

function assertPartnerId(id: string): void {
  if (!uuidPattern.test(id)) {
    throw new PartnerReviewInputError('partnerId');
  }
}

function assertHumanActor(actor: string): string {
  const trimmed = actor.trim();
  if (trimmed === '' || trimmed.startsWith('system:')) {
    throw new PartnerReviewInputError('actor');
  }
  return trimmed;
}

function holdsPersonalAddress(value: string): boolean {
  return redactAuditDetail({ value }).value !== value;
}

/** A `YYYY-MM-DD` calendar date, as the UTC midnight it names. */
export function parsePartnerDate(value: unknown): Date {
  const match = typeof value === 'string' ? isoDatePattern.exec(value) : null;
  if (match === null) {
    throw new PartnerReviewInputError('date');
  }
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (date.toISOString().slice(0, 10) !== value) {
    throw new PartnerReviewInputError('date');
  }
  return date;
}

/** One line of 1 to `maximum` characters, with no email or IP address. */
function oneLine(
  value: unknown,
  maximum: number,
  problem: PartnerInputProblem,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (
    trimmed === '' ||
    trimmed.length > maximum ||
    lineControlCharacter.test(trimmed) ||
    holdsPersonalAddress(trimmed)
  ) {
    throw new PartnerReviewInputError(problem);
  }
  return trimmed;
}

/** The notes field: 1 to 2,000 characters, refused if it holds an email or IP address. */
export function normalisePartnerNotes(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  // Notes are kept out of the audit log (only their length and hash are
  // recorded), but the refusal matches the void reason's, so the founder
  // never stores another person's address or an IP address in them.
  if (
    trimmed === '' ||
    trimmed.length > partnerReviewLimits.notes ||
    notesControlCharacter.test(trimmed) ||
    holdsPersonalAddress(trimmed)
  ) {
    throw new PartnerReviewInputError('notes');
  }
  return trimmed;
}

/**
 * The length and SHA-256 of a free-text personal field, for the append-only
 * audit log, which can never hold the text itself (D-052 Q4e).
 */
export function textDigest(
  value: string | null,
): { readonly length: number; readonly sha256: string } | null {
  return value === null
    ? null
    : {
        length: value.length,
        sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
      };
}

function isStale(
  status: PartnerStatus,
  statusChangedAt: Date,
  now: Date,
): boolean {
  return (
    partnerWaitingStatuses.includes(status) &&
    statusChangedAt.getTime() < now.getTime() - partnerStaleAfterMs
  );
}

function reviewState(row: PartnerReviewRow): PartnerReviewState {
  return {
    status: row.status,
    status_changed_at: row.status_changed_at.toISOString(),
    partner_type: row.partner_type,
    code: row.code,
    code_active: row.code_active,
    contract_sent_at: row.contract_sent_at?.toISOString() ?? null,
    contract_signed_at: row.contract_signed_at,
    contract_version: row.contract_version,
  };
}

/** The audit form of a row: the review state, and digests of the free text. */
function auditState(row: PartnerReviewRow): AuditDetail {
  return {
    ...reviewState(row),
    contract_reference: textDigest(row.contract_reference),
    university: textDigest(row.university),
    notes: textDigest(row.notes),
  };
}

export function createPartnerReviewService(
  database: DatabasePool,
  clock: () => Date = () => new Date(),
): PartnerReviewService {
  async function lockForCommand(
    connection: DatabaseConnection,
    id: string,
  ): Promise<PartnerReviewRow> {
    const row = await createPartnerReviewRepository(connection).lock(id);
    if (row === null) throw new PartnerReviewRefusedError('not_found');
    if (row.personal_data_purged_at !== null) {
      throw new PartnerReviewRefusedError('purged', { status: row.status });
    }
    return row;
  }

  async function record(
    connection: DatabaseConnection,
    action: AuditAction,
    actor: string,
    partnerId: string,
    detail: AuditDetail,
  ): Promise<void> {
    await createAuditService(connection).record({
      action,
      actor,
      detail,
      subjectId: partnerId,
      subjectType: 'partner',
    });
  }

  /** Issues a status link and queues one review email (hard rule 5). */
  async function queueReviewEmail(
    connection: DatabaseConnection,
    subscriberId: string,
    template: string,
    businessKey: string,
  ): Promise<boolean> {
    const statusToken = await createVerificationService(connection, {
      clock,
    }).issue(subscriberId, 'status');
    return createEmailQueue(database, clock).queue(
      {
        businessKey,
        subscriberId,
        template,
        provider: 'resend',
        payload: { status_token_id: statusToken.id },
      },
      connection,
    );
  }

  /**
   * One status transition: lock, check the source status, write, audit.
   * `contract` and `before` run after the lock and before the write; `after`
   * runs once the write has succeeded, inside the same transaction.
   */
  async function transition(
    rawId: string,
    rawActor: string,
    from: readonly PartnerStatus[],
    to: PartnerStatus,
    action: AuditAction,
    options: {
      readonly contract?: (
        row: PartnerReviewRow,
        now: Date,
      ) =>
        | {
            readonly sentAt: Date;
          }
        | PartnerContractSigning;
      readonly before?: (
        connection: DatabaseConnection,
        row: PartnerReviewRow,
      ) => Promise<void>;
      readonly after?: (
        connection: DatabaseConnection,
        row: PartnerReviewRow,
      ) => Promise<{ mailQueued: boolean; detail: AuditDetail }>;
    } = {},
  ): Promise<PartnerCommandResult> {
    assertPartnerId(rawId);
    const actor = assertHumanActor(rawActor);
    return withTransaction(database, async (connection) => {
      const repository = createPartnerReviewRepository(connection);
      const changesActivation =
        to === 'active' || to === 'paused' || to === 'terminated';
      if (changesActivation) await repository.lockActivationSubscriber(rawId);
      const row = await lockForCommand(connection, rawId);
      if (!from.includes(row.status)) {
        throw new PartnerReviewRefusedError('wrong_status', {
          status: row.status,
        });
      }
      const now = clock();
      const contract = options.contract?.(row, now);
      await options.before?.(connection, row);
      const updated = await repository.transition(
        row.id,
        row.status,
        to,
        now,
        contract,
      );
      if (updated !== 1) {
        throw new Error('The partner transition could not be recorded.');
      }
      if (changesActivation && row.subscriber_id !== null) {
        if (to === 'active') {
          await activatePartnerCode(
            connection,
            row.id,
            row.subscriber_id,
            now,
            actor,
          );
        } else {
          await createPartnerAttributionRepository(connection).setCodeActive(
            row.id,
            false,
          );
          await recomputeReferralRewards(connection, row.subscriber_id, {
            actor,
            now,
          });
        }
      }
      const changed = await repository.lock(row.id);
      if (changed === null) {
        throw new Error('The partner could not be read after its transition.');
      }
      const followUp = await options.after?.(connection, changed);
      await record(connection, action, actor, row.id, {
        before: auditState(row),
        after: auditState(changed),
        ...followUp?.detail,
      });
      return {
        partnerId: row.id,
        before: reviewState(row),
        after: reviewState(changed),
        mailQueued: followUp?.mailQueued ?? null,
      };
    });
  }

  function parseContract(
    input: PartnerContractInput,
  ): (row: PartnerReviewRow, now: Date) => PartnerContractSigning {
    const signed = parsePartnerDate(input.date);
    const version = typeof input.version === 'string' ? input.version : '';
    if (
      !partnerContractVersionPattern.test(version) ||
      holdsPersonalAddress(version)
    ) {
      throw new PartnerReviewInputError('contractVersion');
    }
    const reference =
      input.reference === undefined || input.reference === null
        ? null
        : oneLine(
            input.reference,
            partnerReviewLimits.contractReference,
            'contractReference',
          );
    const signedOn = signed.toISOString().slice(0, 10);
    return (row, now) => {
      if (signedOn > now.toISOString().slice(0, 10)) {
        throw new PartnerReviewInputError('signedInFuture');
      }
      const sentOn = row.contract_sent_at?.toISOString().slice(0, 10) ?? null;
      if (sentOn !== null && signedOn < sentOn) {
        throw new PartnerReviewInputError('signedBeforeSent');
      }
      return { signedOn, version, reference };
    };
  }

  return {
    async list(input, rawActor) {
      const actor = assertHumanActor(rawActor);
      const status =
        input.status === undefined ? null : (input.status as PartnerStatus);
      if (
        status !== null &&
        (!partnerStatuses.includes(status) || status === 'unconfirmed')
      ) {
        // An unconfirmed application is never listed for review (E11.7-05).
        throw new PartnerReviewInputError('status');
      }
      const partnerType = input.type ?? null;
      if (
        partnerType !== null &&
        !(partnerTypes as readonly string[]).includes(partnerType)
      ) {
        throw new PartnerReviewInputError('type');
      }
      const since =
        input.since === undefined ? null : parsePartnerDate(input.since);
      if (input.after !== undefined) assertPartnerId(input.after);
      const stale = input.stale === true;
      const now = clock();

      return withTransaction(database, async (connection) => {
        const rows = await createPartnerReviewRepository(connection).list(
          {
            status,
            partnerType,
            appliedSince: since,
            staleBefore: stale
              ? new Date(now.getTime() - partnerStaleAfterMs)
              : null,
            afterId: input.after ?? null,
          },
          partnerListPageLimit,
        );
        const nextAfter =
          rows.length === partnerListPageLimit
            ? (rows.at(-1)?.id ?? null)
            : null;
        // A read audit: the filters and the row count, no personal data.
        await createAuditService(connection).record({
          action: 'partner.listed',
          actor,
          subjectId: null,
          subjectType: 'partner',
          detail: {
            filters: {
              status,
              type: partnerType,
              since: input.since ?? null,
              stale,
              after: input.after ?? null,
            },
            row_count: rows.length,
          },
        });
        return {
          partners: rows.map((row) => ({
            ...row,
            stale: isStale(row.status, row.status_changed_at, now),
          })),
          nextAfter,
        };
      });
    },

    async show(id, rawActor) {
      assertPartnerId(id);
      const actor = assertHumanActor(rawActor);
      const now = clock();
      return withTransaction(database, async (connection) => {
        const repository = createPartnerReviewRepository(connection);
        const partner = await repository.detail(id);
        if (partner === null) throw new PartnerReviewRefusedError('not_found');
        const empty: PartnerReferralSummary = {
          confirmed: 0,
          pending: 0,
          voided: 0,
          flagged: 0,
          last_activity_at: null,
        };
        const referrals =
          partner.subscriber_id === null
            ? empty
            : await repository.referralSummary(partner.subscriber_id);
        const flaggedReferrals =
          partner.subscriber_id === null
            ? []
            : await repository.flaggedReferrals(
                partner.subscriber_id,
                partnerFlaggedReferralLimit,
              );
        await createAuditService(connection).record({
          action: 'partner.viewed',
          actor,
          subjectId: partner.id,
          subjectType: 'partner',
          detail: {},
        });
        return {
          partner: {
            ...partner,
            stale: isStale(partner.status, partner.status_changed_at, now),
          },
          referrals,
          flaggedReferrals,
        };
      });
    },

    approve(id, rawCode, actor) {
      let chosen: string | null = null;
      return transition(
        id,
        actor,
        ['applied'],
        'approved',
        'partner.approved',
        {
          // The code rules run again, so a code taken or blocked since the
          // application was submitted is refused here and nothing changes.
          before: async (connection, row) => {
            const requested = rawCode ?? row.requested_code;
            if (requested === null) {
              throw new PartnerReviewRefusedError('purged', {
                status: row.status,
              });
            }
            const rules = createPartnerCodeRules(connection);
            const check = await rules.check(requested);
            if (check.outcome === 'refused') {
              throw new PartnerReviewRefusedError('code_refused', {
                status: row.status,
                codeReason: check.reason,
                alternatives: check.alternatives,
              });
            }
            const registered = await createPartnerReviewRepository(
              connection,
            ).registerCode(check.code, row.id);
            if (!registered) {
              // Taken between the check and the insert: report it as the rules
              // would, with alternatives.
              const again = await rules.check(check.code);
              throw new PartnerReviewRefusedError('code_refused', {
                status: row.status,
                codeReason:
                  again.outcome === 'refused' ? again.reason : 'taken',
                alternatives:
                  again.outcome === 'refused' ? again.alternatives : [],
              });
            }
            chosen = check.code;
          },
          after: async (connection, row) => {
            if (row.subscriber_id === null) {
              throw new Error('An approved partner has its member link.');
            }
            const mailQueued = await queueReviewEmail(
              connection,
              row.subscriber_id,
              partnerApprovedTemplate,
              partnerApprovedBusinessKey(row.id),
            );
            return {
              mailQueued,
              detail: {
                code_changed_at_approval:
                  rawCode !== null && chosen !== row.requested_code,
                approval_mail_queued: mailQueued,
              },
            };
          },
        },
      );
    },

    reject(id, sendTemplate, actor) {
      return transition(
        id,
        actor,
        ['applied', 'approved', 'contract_sent'],
        'rejected',
        'partner.rejected',
        {
          after: async (connection, row) => {
            let mailQueued = false;
            if (sendTemplate) {
              if (row.subscriber_id === null) {
                throw new Error('A rejected application has its member link.');
              }
              mailQueued = await queueReviewEmail(
                connection,
                row.subscriber_id,
                partnerRejectedTemplate,
                partnerRejectedBusinessKey(row.id),
              );
            }
            return {
              mailQueued,
              detail: {
                template_requested: sendTemplate,
                rejection_mail_queued: mailQueued,
              },
            };
          },
        },
      );
    },

    contractSent(id, actor) {
      return transition(
        id,
        actor,
        ['approved'],
        'contract_sent',
        'partner.contract_sent',
        { contract: (_row, now) => ({ sentAt: now }) },
      );
    },

    async contractSigned(id, input, actor) {
      const contract = parseContract(input);
      return transition(
        id,
        actor,
        ['contract_sent'],
        'active',
        'partner.contract_signed',
        { contract },
      );
    },

    pause(id, actor) {
      return transition(id, actor, ['active'], 'paused', 'partner.paused');
    },

    terminate(id, actor) {
      return transition(
        id,
        actor,
        ['active', 'paused'],
        'terminated',
        'partner.terminated',
      );
    },

    reactivate(id, actor) {
      return transition(id, actor, ['paused'], 'active', 'partner.reactivated');
    },

    async setType(id, rawType, rawUniversity, rawActor) {
      assertPartnerId(id);
      const actor = assertHumanActor(rawActor);
      if (
        typeof rawType !== 'string' ||
        !(partnerTypes as readonly string[]).includes(rawType)
      ) {
        throw new PartnerReviewInputError('type');
      }
      const partnerType = rawType as PartnerType;
      let university: string | null = null;
      if (partnerType === 'student_ambassador') {
        // D-052 Q4c: a student ambassador names a university or college.
        university = oneLine(
          rawUniversity,
          partnerApplicationLimits.university,
          'university',
        );
      } else if (rawUniversity !== undefined && rawUniversity !== null) {
        throw new PartnerReviewInputError('universityNotAllowed');
      }
      return withTransaction(database, async (connection) => {
        const repository = createPartnerReviewRepository(connection);
        const row = await lockForCommand(connection, id);
        if ((await repository.setType(row.id, partnerType, university)) !== 1) {
          throw new Error('The partner type could not be recorded.');
        }
        const changed = await repository.lock(row.id);
        if (changed === null) throw new Error('The partner could not be read.');
        await record(connection, 'partner.type_changed', actor, row.id, {
          before: auditState(row),
          after: auditState(changed),
        });
        return {
          partnerId: row.id,
          before: reviewState(row),
          after: reviewState(changed),
          mailQueued: null,
        };
      });
    },

    async note(id, rawText, rawActor) {
      assertPartnerId(id);
      const actor = assertHumanActor(rawActor);
      const notes = normalisePartnerNotes(rawText);
      return withTransaction(database, async (connection) => {
        const repository = createPartnerReviewRepository(connection);
        const row = await lockForCommand(connection, id);
        if ((await repository.replaceNotes(row.id, notes)) !== 1) {
          throw new Error('The partner notes could not be recorded.');
        }
        const changed = await repository.lock(row.id);
        if (changed === null) throw new Error('The partner could not be read.');
        // Only the length and SHA-256 of the text, never the text (D-052 Q4e).
        await record(connection, 'partner.note_replaced', actor, row.id, {
          before: { notes: textDigest(row.notes) },
          after: { notes: textDigest(changed.notes) },
        });
        return {
          partnerId: row.id,
          before: reviewState(row),
          after: reviewState(changed),
          mailQueued: null,
        };
      });
    },
  };
}
