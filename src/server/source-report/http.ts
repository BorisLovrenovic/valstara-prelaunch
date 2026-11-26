import { adminCopy } from '../../copy/admin.ts';
import { DatabaseUnavailableError } from '../db/errors.ts';

import { sourceReportLabels } from './convention-rules.ts';
import {
  type SourceReportCounts,
  SourceReportRefusedError,
  type SourceReportService,
} from './report.ts';

// E11.8-02: the request and response of GET /api/admin/reports/sources
// (docs/api/README.md#admin-routes). The query is `from=YYYY-MM-DD` and
// `to=YYYY-MM-DD`, each once, and nothing else. The response holds the range,
// labels and counts; nothing about any person, no stored UTM text and nothing
// from the database's errors reaches it.

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

function readRange(url: URL): { from: string; to: string } | null {
  const keys = [...url.searchParams.keys()].sort();
  if (keys.length !== 2 || keys[0] !== 'from' || keys[1] !== 'to') return null;
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  return from === null || to === null ? null : { from, to };
}

function countsBody(counts: SourceReportCounts) {
  return {
    signups: counts.signups,
    verified_signups: counts.verifiedSignups,
    confirmed_referrals: counts.confirmedReferrals,
    first_survey_completions: counts.firstSurveyCompletions,
  };
}

export function createSourceReportHandler(
  service: SourceReportService,
): (input: { actor: string; url: URL }) => Promise<Response> {
  const copy = adminCopy.sourceReport;
  return async ({ actor, url }) => {
    const range = readRange(url);
    if (range === null) return errorResponse('invalid_input', copy.query);
    try {
      const report = await service.report({ ...range, actor });
      return jsonResponse(200, {
        from: report.from,
        to: report.to,
        counted_at: report.countedAt.toISOString(),
        rows: report.rows.map((row) => ({
          source: row.source,
          medium: row.medium,
          campaign: row.campaign,
          ...countsBody(row),
        })),
        without_utm: [
          {
            bucket: sourceReportLabels.referral,
            ...countsBody(report.withoutUtm.referral),
          },
          {
            bucket: sourceReportLabels.none,
            ...countsBody(report.withoutUtm.none),
          },
        ],
        totals: countsBody(report.totals),
        row_count: report.rowCount,
        retention: copy.retention,
      });
    } catch (error) {
      if (error instanceof SourceReportRefusedError) {
        return errorResponse(
          'invalid_input',
          error.refusal === 'too_many_rows'
            ? copy.tooManyRows
            : error.refusal === 'actor'
              ? copy.actor
              : copy.range,
        );
      }
      return errorResponse(
        error instanceof DatabaseUnavailableError ? 'unavailable' : 'internal',
        copy.unavailable,
      );
    }
  };
}
