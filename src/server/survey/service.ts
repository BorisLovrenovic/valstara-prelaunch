import { randomUUID } from 'node:crypto';

import { createAuditService } from '../audit/service.ts';
import type { DatabasePool } from '../db/pool.ts';
import { createRateLimitBucketRepository } from '../db/rate-limit-bucket.ts';
import { createSurveyResponseRepository } from '../db/survey-response.ts';
import { withTransaction } from '../db/transaction.ts';
import type { FlagService } from '../flags/types.ts';
import { createVerificationService } from '../verification/service.ts';

import {
  validateSurveySubmission,
  type SurveyQuestionSets,
  type SurveySubmission,
} from './questions.ts';

export const surveyRateLimitWindowMilliseconds = 15 * 60 * 1_000;
export const surveySubscriberRateLimit = 10;
export const surveyIpPrefixRateLimit = 20;

export type SurveyCaptureOutcome =
  | 'disabled'
  | 'invalid_input'
  | 'rate_limited'
  | 'saved'
  | 'skipped'
  | 'token_invalid'
  | 'unverified';

export interface SurveyCaptureInput extends SurveySubmission {
  readonly ipPrefixHash: string;
  readonly requestId?: string;
  readonly token: string;
}

export interface SurveyServiceDependencies {
  readonly clock?: () => Date;
  readonly flags: Pick<FlagService, 'isEnabled'>;
  readonly questionSets?: SurveyQuestionSets;
  readonly onFirstAnswer?: (version: string) => void;
}

export function createSurveyService(
  database: DatabasePool,
  dependencies: SurveyServiceDependencies,
): (input: SurveyCaptureInput) => Promise<SurveyCaptureOutcome> {
  const clock = dependencies.clock ?? (() => new Date());

  return async (input) => {
    let firstAnswerVersion: string | null = null;
    const outcome = await withTransaction(database, async (connection) => {
      const verification = createVerificationService(connection, { clock });
      const authenticated = await verification.consumeForPurpose(
        input.token,
        'status',
      );
      if (
        authenticated.outcome === 'invalid' ||
        authenticated.outcome === 'expired' ||
        authenticated.subscriberId === null
      ) {
        return 'token_invalid';
      }
      if (input.ipPrefixHash === '') return 'rate_limited';

      const now = clock();
      const windowThreshold = new Date(
        now.getTime() - surveyRateLimitWindowMilliseconds,
      );
      const rateLimits = createRateLimitBucketRepository(connection);
      const ipCount = await rateLimits.consume(
        `survey:ip:${input.ipPrefixHash}`,
        now,
        windowThreshold,
      );
      const subscriberCount = await rateLimits.consume(
        `survey:subscriber:${authenticated.subscriberId}`,
        now,
        windowThreshold,
      );
      if (
        ipCount > surveyIpPrefixRateLimit ||
        subscriberCount > surveySubscriberRateLimit
      ) {
        return 'rate_limited';
      }

      if (!(await dependencies.flags.isEnabled('survey.enabled'))) {
        return 'disabled';
      }

      const submission = validateSurveySubmission(
        input,
        dependencies.questionSets,
      );
      if (submission === null) return 'invalid_input';

      const repository = createSurveyResponseRepository(connection);
      if (
        (await repository.lockSubscriberStatus(authenticated.subscriberId)) !==
        'verified'
      ) {
        return 'unverified';
      }

      const previous = await repository.find(authenticated.subscriberId);
      const answers = {
        category_preference: submission.answers.category_preference,
        shopping_frequency: submission.answers.shopping_frequency,
      };
      const hasAnswer =
        answers.category_preference !== null ||
        answers.shopping_frequency !== null;
      const firstAnsweredAt =
        hasAnswer && previous?.first_answered_at == null ? now : null;

      if (previous === null) {
        await repository.insert({
          answers,
          firstAnsweredAt,
          id: randomUUID(),
          subscriberId: authenticated.subscriberId,
          version: submission.version,
        });
      } else {
        await repository.replace({
          answers,
          firstAnsweredAt,
          subscriberId: authenticated.subscriberId,
          version: submission.version,
        });
        await createAuditService(connection).record({
          action: 'survey.response_replaced',
          actor: 'subscriber:self',
          detail: {
            currentVersion: submission.version,
            previousVersion: previous.version,
          },
          requestId: input.requestId,
          subjectId: authenticated.subscriberId,
          subjectType: 'subscriber',
        });
      }

      await repository.setCategoryPreference(
        authenticated.subscriberId,
        submission.answers.category_preference,
      );
      if (firstAnsweredAt !== null) firstAnswerVersion = submission.version;
      return hasAnswer ? 'saved' : 'skipped';
    });
    if (firstAnswerVersion !== null) {
      try {
        dependencies.onFirstAnswer?.(firstAnswerVersion);
      } catch {
        // The survey response is committed even if analytics is unavailable.
      }
    }
    return outcome;
  };
}
