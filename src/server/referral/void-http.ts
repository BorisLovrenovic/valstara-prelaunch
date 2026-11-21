import { adminCopy } from '../../copy/admin.ts';
import { DatabaseUnavailableError } from '../db/errors.ts';

import {
  ReferralVoidInputError,
  ReferralVoidRefusedError,
  type ReferralVoidRefusal,
  type ReferralVoidResult,
  type ReferralVoidService,
} from './void.ts';

// E11.7-02: the request and response shape shared by
// POST /api/admin/referrals/void and /unvoid. The routes stay thin: they pass
// the authenticated actor and the request here, and return what this gives.

export type ReferralVoidOperation = 'unvoid' | 'void';

const refusalMessage: Record<ReferralVoidRefusal, string> = {
  already_voided: adminCopy.referralAlreadyVoided,
  not_changeable: adminCopy.referralNotChangeable,
  not_found: adminCopy.referralNotFound,
  not_voided: adminCopy.referralNotVoided,
};

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

function parseBody(
  body: unknown,
): { subscriberId: string; reason: unknown } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const keys = Object.keys(body).sort();
  if (keys.join(',') !== 'reason,subscriber_id') return null;
  const { subscriber_id: subscriberId, reason } = body as Record<
    string,
    unknown
  >;
  return typeof subscriberId === 'string' ? { subscriberId, reason } : null;
}

function presentResult(result: ReferralVoidResult): Record<string, unknown> {
  return {
    referral: {
      edge_id: result.edgeId,
      referred_id: result.referredId,
      referrer_id: result.referrerId,
      state: result.state,
      voided: result.voided,
      voided_at: result.voidedAt?.toISOString() ?? null,
      void_reason: result.voidReason,
      voided_by: result.voidedBy,
    },
    referrer: { confirmed_referrals: result.referrerConfirmedReferrals },
    giveaway_entry: result.giveawayEntry,
  };
}

export function createReferralVoidHandler(
  service: ReferralVoidService,
  operation: ReferralVoidOperation,
): (input: { actor: string; request: Request }) => Promise<Response> {
  return async ({ actor, request }) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse('invalid_input', adminCopy.referralVoidInvalid);
    }
    const parsed = parseBody(body);
    if (parsed === null || typeof parsed.reason !== 'string') {
      return errorResponse('invalid_input', adminCopy.referralVoidInvalid);
    }

    try {
      const result =
        operation === 'void'
          ? await service.voidReferral(
              parsed.subscriberId,
              parsed.reason,
              actor,
            )
          : await service.unvoidReferral(
              parsed.subscriberId,
              parsed.reason,
              actor,
            );
      return jsonResponse(200, presentResult(result));
    } catch (error) {
      if (error instanceof ReferralVoidInputError) {
        return errorResponse('invalid_input', adminCopy.referralVoidInvalid);
      }
      if (error instanceof ReferralVoidRefusedError) {
        return errorResponse('invalid_input', refusalMessage[error.refusal]);
      }
      return error instanceof DatabaseUnavailableError
        ? errorResponse('unavailable', adminCopy.referralVoidUnavailable)
        : errorResponse('internal', adminCopy.referralVoidUnavailable);
    }
  };
}
