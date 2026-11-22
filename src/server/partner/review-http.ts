import { adminCopy } from '../../copy/admin.ts';
import { DatabaseUnavailableError } from '../db/errors.ts';

import {
  PartnerReviewInputError,
  PartnerReviewRefusedError,
  type PartnerCommandResult,
  type PartnerListResult,
  type PartnerReviewService,
  type PartnerShowResult,
} from './review.ts';

// E11.7-06: the request and response shapes of /api/admin/partners/*
// (docs/api/README.md#admin-routes). The routes stay thin: they pass the
// authenticated actor, the path id and the request here, and return what
// this gives. Every refusal is `400 invalid_input` with a message from the
// copy layer; nothing from the database reaches a response.

export type PartnerCommand =
  | 'approve'
  | 'reject'
  | 'contract-sent'
  | 'contract-signed'
  | 'pause'
  | 'terminate'
  | 'reactivate'
  | 'type'
  | 'note';

/** The body keys each command accepts; anything else is refused. */
const commandKeys: Record<
  PartnerCommand,
  { readonly required: readonly string[]; readonly optional: readonly string[] }
> = {
  approve: { required: [], optional: ['code'] },
  reject: { required: [], optional: ['template'] },
  'contract-sent': { required: [], optional: [] },
  'contract-signed': { required: ['date', 'version'], optional: ['reference'] },
  pause: { required: [], optional: [] },
  terminate: { required: [], optional: [] },
  reactivate: { required: [], optional: [] },
  type: { required: ['type'], optional: ['university'] },
  note: { required: ['text'], optional: [] },
};

const listParameters = new Set(['status', 'type', 'since', 'stale', 'after']);

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function errorResponse(
  code: 'internal' | 'invalid_input' | 'unavailable',
  message: string,
): Response {
  const status =
    code === 'invalid_input' ? 400 : code === 'unavailable' ? 503 : 500;
  return jsonResponse(status, { error: { code, message } });
}

function refusalMessage(error: PartnerReviewRefusedError): string {
  switch (error.refusal) {
    case 'not_found':
      return adminCopy.partnerNotFound;
    case 'purged':
      return adminCopy.partnerPurged;
    case 'wrong_status':
      return adminCopy.partnerWrongStatus(error.status ?? 'unknown');
    case 'code_refused':
      return `${adminCopy.partnerCodeRefusal[error.codeReason ?? 'taken']} ${adminCopy.partnerCodeAlternatives(error.alternatives)}`;
  }
}

function failure(error: unknown): Response {
  if (error instanceof PartnerReviewInputError) {
    return errorResponse(
      'invalid_input',
      adminCopy.partnerInput[error.problem],
    );
  }
  if (error instanceof PartnerReviewRefusedError) {
    return errorResponse('invalid_input', refusalMessage(error));
  }
  return error instanceof DatabaseUnavailableError
    ? errorResponse('unavailable', adminCopy.partnerUnavailable)
    : errorResponse('internal', adminCopy.partnerUnavailable);
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function presentCommand(result: PartnerCommandResult): Record<string, unknown> {
  return {
    partner: {
      id: result.partnerId,
      before: result.before,
      after: result.after,
    },
    mail_queued: result.mailQueued,
  };
}

function presentList(result: PartnerListResult): Record<string, unknown> {
  return {
    partners: result.partners.map((row) => ({
      id: row.id,
      status: row.status,
      partner_type: row.partner_type,
      full_name: row.full_name,
      email: row.email,
      code: row.code,
      requested_code: row.requested_code,
      applied_at: iso(row.applied_at),
      status_changed_at: iso(row.status_changed_at),
      stale: row.stale,
    })),
    next_after: result.nextAfter,
  };
}

function presentShow(result: PartnerShowResult): Record<string, unknown> {
  const partner = result.partner;
  return {
    partner: {
      id: partner.id,
      status: partner.status,
      status_changed_at: iso(partner.status_changed_at),
      stale: partner.stale,
      submitted_at: iso(partner.submitted_at),
      applied_at: iso(partner.applied_at),
      subscriber_id: partner.subscriber_id,
      email: partner.email,
      full_name: partner.full_name,
      country_of_residence: partner.country_of_residence,
      partner_type: partner.partner_type,
      channels: partner.channels,
      handles: partner.handles,
      audience_size: partner.audience_size,
      promotion_plan: partner.promotion_plan,
      requested_code: partner.requested_code,
      code: partner.code,
      code_active: partner.code_active,
      university: partner.university,
      student_email: partner.student_email,
      company_name: partner.company_name,
      contract_sent_at: iso(partner.contract_sent_at),
      contract_signed_at: partner.contract_signed_at,
      contract_version: partner.contract_version,
      contract_reference: partner.contract_reference,
      notes: partner.notes,
      personal_data_purged_at: iso(partner.personal_data_purged_at),
    },
    referrals: {
      confirmed: result.referrals.confirmed,
      pending: result.referrals.pending,
      voided: result.referrals.voided,
      flagged: result.referrals.flagged,
      last_activity_at: iso(result.referrals.last_activity_at),
    },
    // The referred people are named by subscriber id only, which is what
    // `referrals void <subscriber-id>` takes; never by email.
    flagged_referrals: result.flaggedReferrals.map((referral) => ({
      referred_id: referral.referred_id,
      state: referral.state,
      voided: referral.voided,
      flag_kinds: referral.flag_kinds,
    })),
  };
}

export function createPartnerListHandler(
  service: PartnerReviewService,
): (input: { actor: string; url: URL }) => Promise<Response> {
  return async ({ actor, url }) => {
    const parameters = url.searchParams;
    for (const key of parameters.keys()) {
      if (!listParameters.has(key) || parameters.getAll(key).length > 1) {
        return errorResponse('invalid_input', adminCopy.partnerListInvalid);
      }
    }
    const stale = parameters.get('stale');
    if (stale !== null && stale !== 'true') {
      return errorResponse('invalid_input', adminCopy.partnerListInvalid);
    }
    try {
      const result = await service.list(
        {
          status: parameters.get('status') ?? undefined,
          type: parameters.get('type') ?? undefined,
          since: parameters.get('since') ?? undefined,
          stale: stale === 'true',
          after: parameters.get('after') ?? undefined,
        },
        actor,
      );
      return jsonResponse(200, presentList(result));
    } catch (error) {
      return failure(error);
    }
  };
}

export function createPartnerShowHandler(
  service: PartnerReviewService,
): (input: { actor: string; id: string | undefined }) => Promise<Response> {
  return async ({ actor, id }) => {
    if (id === undefined) {
      return errorResponse('invalid_input', adminCopy.partnerNotFound);
    }
    try {
      return jsonResponse(200, presentShow(await service.show(id, actor)));
    } catch (error) {
      return failure(error);
    }
  };
}

function readBody(
  body: unknown,
  command: PartnerCommand,
): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const { required, optional } = commandKeys[command];
  const keys = Object.keys(record);
  if (!required.every((key) => keys.includes(key))) return null;
  if (!keys.every((key) => required.includes(key) || optional.includes(key))) {
    return null;
  }
  return record;
}

export function createPartnerCommandHandler(
  service: PartnerReviewService,
  command: PartnerCommand,
): (input: {
  actor: string;
  id: string | undefined;
  request: Request;
}) => Promise<Response> {
  return async ({ actor, id, request }) => {
    if (id === undefined) {
      return errorResponse('invalid_input', adminCopy.partnerNotFound);
    }
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return errorResponse('invalid_input', adminCopy.partnerBodyInvalid);
    }
    const body = readBody(parsed, command);
    if (body === null) {
      return errorResponse('invalid_input', adminCopy.partnerBodyInvalid);
    }

    try {
      let result: PartnerCommandResult;
      switch (command) {
        case 'approve': {
          const code = body.code;
          if (code !== undefined && typeof code !== 'string') {
            return errorResponse('invalid_input', adminCopy.partnerBodyInvalid);
          }
          result = await service.approve(id, code ?? null, actor);
          break;
        }
        case 'reject': {
          // The flag takes no value: present means true (D-052 Q2).
          const template = body.template;
          if (template !== undefined && typeof template !== 'boolean') {
            return errorResponse('invalid_input', adminCopy.partnerBodyInvalid);
          }
          result = await service.reject(id, template === true, actor);
          break;
        }
        case 'contract-sent':
          result = await service.contractSent(id, actor);
          break;
        case 'contract-signed':
          result = await service.contractSigned(
            id,
            {
              date: body.date,
              version: body.version,
              reference: body.reference,
            },
            actor,
          );
          break;
        case 'pause':
          result = await service.pause(id, actor);
          break;
        case 'terminate':
          result = await service.terminate(id, actor);
          break;
        case 'reactivate':
          result = await service.reactivate(id, actor);
          break;
        case 'type':
          result = await service.setType(id, body.type, body.university, actor);
          break;
        case 'note':
          result = await service.note(id, body.text, actor);
          break;
      }
      return jsonResponse(200, presentCommand(result));
    } catch (error) {
      return failure(error);
    }
  };
}
