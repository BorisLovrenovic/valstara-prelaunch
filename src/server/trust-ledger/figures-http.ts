import { adminCopy } from '../../copy/admin.ts';
import { DatabaseUnavailableError } from '../db/errors.ts';

import {
  TrustLedgerFiguresRefusedError,
  type TrustLedgerFiguresService,
} from './waitlist-figures.ts';

// E11.8-01: the request and response of GET /api/admin/trust-ledger/waitlist
// (docs/api/README.md#admin-routes). The query is `month=YYYY-MM`, once, and
// nothing else. The response is the month, when it was counted and three
// counts; nothing about any person, and nothing from the database's errors,
// reaches it.

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

function readMonth(url: URL): string | null {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'month') return null;
  return url.searchParams.get('month');
}

export function createTrustLedgerFiguresHandler(
  service: TrustLedgerFiguresService,
): (input: { actor: string; url: URL }) => Promise<Response> {
  const copy = adminCopy.trustLedgerFigures;
  return async ({ actor, url }) => {
    const month = readMonth(url);
    if (month === null) return errorResponse('invalid_input', copy.query);
    try {
      const figures = await service.figures({ month, actor });
      return jsonResponse(200, {
        month: figures.month,
        counted_at: figures.countedAt.toISOString(),
        verified_total: figures.verifiedTotal,
        verified_in_month: figures.verifiedInMonth,
        verified_in_month_through_referral:
          figures.verifiedInMonthThroughReferral,
      });
    } catch (error) {
      if (error instanceof TrustLedgerFiguresRefusedError) {
        return errorResponse(
          'invalid_input',
          error.refusal === 'future_month'
            ? copy.futureMonth
            : error.refusal === 'actor'
              ? copy.actor
              : copy.query,
        );
      }
      return errorResponse(
        error instanceof DatabaseUnavailableError ? 'unavailable' : 'internal',
        copy.unavailable,
      );
    }
  };
}
