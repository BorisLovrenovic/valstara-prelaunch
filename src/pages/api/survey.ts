import type { APIRoute } from 'astro';

import { surveyCopy } from '../../copy/survey.ts';
import { createAnalyticsService } from '../../server/analytics/service.ts';
import { getConfig } from '../../server/config.ts';
import { DatabaseUnavailableError } from '../../server/db/errors.ts';
import { createPool, type DatabasePool } from '../../server/db/pool.ts';
import { getFlagService } from '../../server/flags/app-service.ts';
import { hashedIpPrefix } from '../../server/ratelimit/ip-prefix.ts';
import {
  createSurveyService,
  type SurveyCaptureInput,
  type SurveyCaptureOutcome,
} from '../../server/survey/service.ts';

export interface SurveyRouteDependencies {
  readonly capture: (
    input: SurveyCaptureInput,
  ) => Promise<SurveyCaptureOutcome>;
  readonly ipPrefixPepper: string;
}

let database: DatabasePool | undefined;

function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

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
  code:
    | 'internal'
    | 'invalid_input'
    | 'rate_limited'
    | 'token_invalid'
    | 'unavailable',
): Response {
  const status =
    code === 'invalid_input' || code === 'token_invalid'
      ? 400
      : code === 'rate_limited'
        ? 429
        : code === 'unavailable'
          ? 503
          : 500;
  const message =
    code === 'invalid_input'
      ? surveyCopy.invalidInput
      : code === 'rate_limited'
        ? surveyCopy.rateLimited
        : code === 'token_invalid'
          ? surveyCopy.invalidToken
          : surveyCopy.unavailable;
  return jsonResponse(status, { error: { code, message } });
}

export function createSurveyRoute(
  dependencies: SurveyRouteDependencies,
): APIRoute {
  return async ({ clientAddress, request }) => {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse('token_invalid');
    }

    const token = formData.get('token');
    const version = formData.get('version');
    const rawFrequency = formData.getAll('shopping_frequency');
    const rawCategories = formData.getAll('category_preference');
    const input: SurveyCaptureInput = {
      answers: {
        category_preference:
          rawCategories.length === 0
            ? null
            : rawCategories.every((value) => typeof value === 'string')
              ? rawCategories
              : [],
        shopping_frequency:
          rawFrequency.length === 0
            ? null
            : rawFrequency.length === 1 && typeof rawFrequency[0] === 'string'
              ? rawFrequency[0]
              : '',
      },
      ipPrefixHash:
        hashedIpPrefix(clientAddress, dependencies.ipPrefixPepper) ?? '',
      requestId: request.headers.get('x-request-id') ?? undefined,
      token: typeof token === 'string' ? token : '',
      version: typeof version === 'string' ? version : '',
    };

    let outcome: SurveyCaptureOutcome;
    try {
      outcome = await dependencies.capture(input);
    } catch (error) {
      return errorResponse(
        error instanceof DatabaseUnavailableError ? 'unavailable' : 'internal',
      );
    }

    if (outcome === 'saved' || outcome === 'skipped') {
      return jsonResponse(200, {
        message: outcome === 'skipped' ? surveyCopy.skipped : surveyCopy.saved,
        status: outcome,
      });
    }
    if (outcome === 'invalid_input') return errorResponse('invalid_input');
    if (outcome === 'rate_limited') return errorResponse('rate_limited');
    if (outcome === 'token_invalid' || outcome === 'unverified') {
      return errorResponse('token_invalid');
    }
    return errorResponse('unavailable');
  };
}

function defaultDependencies(): SurveyRouteDependencies {
  const config = getConfig();
  const analytics = createAnalyticsService();
  return {
    capture: createSurveyService(getDatabase(), {
      flags: getFlagService(),
      onFirstAnswer: (question_set_version) => {
        void analytics
          .track('survey_completed', {
            question_set_version: question_set_version as '2026-09-08',
          })
          .catch(() => {});
      },
    }),
    ipPrefixPepper: config.ipPrefixPepper,
  };
}

export const POST: APIRoute = (context) =>
  createSurveyRoute(defaultDependencies())(context);
