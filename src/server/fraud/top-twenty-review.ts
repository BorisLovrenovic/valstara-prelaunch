import { createHash, randomUUID } from 'node:crypto';

import { createAuditService } from '../audit/service.ts';
import { createTopTwentyReviewRepository } from '../db/top-twenty-review.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';

export const topTwentyReviewLimit = 20;

export interface TopTwentyReviewOutcome {
  readonly outcome: string;
  readonly subscriberId: string;
}

export interface TopTwentyReviewGate {
  assertReviewedAndCurrent(): Promise<void>;
  reviewCurrentTopTwenty(
    outcomes: readonly TopTwentyReviewOutcome[],
    actor: string,
  ): Promise<void>;
}

export class TopTwentyReviewRequiredError extends Error {
  public constructor() {
    super('The current top-twenty entry group has not been reviewed.');
    this.name = 'TopTwentyReviewRequiredError';
  }
}

export class TopTwentyAlreadyReviewedError extends Error {
  public constructor() {
    super('The current top-twenty entry group is already reviewed.');
    this.name = 'TopTwentyAlreadyReviewedError';
  }
}

export function createTopTwentyReviewGate(
  database: DatabasePool,
): TopTwentyReviewGate {
  return {
    async assertReviewedAndCurrent() {
      const isCurrent = await withTransaction(database, async (connection) => {
        const repository = createTopTwentyReviewRepository(connection);
        const membership = await currentMembership(repository);
        const active = await repository.findActive();

        if (active === null) return false;
        if (active.membership_hash.equals(membership.hash)) return true;

        const invalidated = await repository.invalidate(active.id);
        if (invalidated === 1) {
          await createAuditService(connection).record({
            action: 'giveaway.top_twenty_review_invalidated',
            actor: 'system:top_twenty_review_gate',
            detail: { reason: 'membership_changed' },
            subjectId: active.id,
            subjectType: 'top_twenty_review_batch',
          });
        }
        return false;
      });
      if (!isCurrent) throw new TopTwentyReviewRequiredError();
    },
    async reviewCurrentTopTwenty(outcomes, rawActor) {
      const actor = requiredText(
        rawActor,
        'An authenticated actor is required.',
      );
      await withTransaction(database, async (connection) => {
        const repository = createTopTwentyReviewRepository(connection);
        const membership = await currentMembership(repository);
        if (membership.ids.length === 0) {
          throw new TopTwentyReviewRequiredError();
        }
        assertOutcomesMatchMembership(outcomes, membership.ids);

        const active = await repository.findActive();
        if (active !== null) {
          if (active.membership_hash.equals(membership.hash)) {
            throw new TopTwentyAlreadyReviewedError();
          }
          const invalidated = await repository.invalidate(active.id);
          if (invalidated === 1) {
            await createAuditService(connection).record({
              action: 'giveaway.top_twenty_review_invalidated',
              actor: 'system:top_twenty_review_gate',
              detail: { reason: 'membership_changed' },
              subjectId: active.id,
              subjectType: 'top_twenty_review_batch',
            });
          }
        }

        const batchId = randomUUID();
        await repository.createBatch(batchId, membership.hash);
        for (const outcome of outcomes) {
          await repository.recordOutcome({
            actor,
            batchId,
            outcome: requiredText(
              outcome.outcome,
              'A review outcome is required.',
            ),
            subscriberId: outcome.subscriberId,
          });
        }
        await createAuditService(connection).record({
          action: 'giveaway.top_twenty_reviewed',
          actor,
          detail: { accountsReviewed: membership.ids.length },
          subjectId: batchId,
          subjectType: 'top_twenty_review_batch',
        });
      });
    },
  };
}

async function currentMembership(
  repository: ReturnType<typeof createTopTwentyReviewRepository>,
) {
  const ids = (await repository.listCurrentMembers(topTwentyReviewLimit)).map(
    (member) => member.subscriber_id,
  );
  return {
    hash: createHash('sha256').update(JSON.stringify(ids)).digest(),
    ids,
  };
}

function assertOutcomesMatchMembership(
  outcomes: readonly TopTwentyReviewOutcome[],
  memberIds: readonly string[],
): void {
  const outcomeIds = outcomes.map((outcome) => outcome.subscriberId);
  if (
    outcomeIds.length !== memberIds.length ||
    new Set(outcomeIds).size !== outcomeIds.length ||
    outcomeIds.some((id) => !memberIds.includes(id))
  ) {
    throw new RangeError(
      'Every current top-twenty account requires one outcome.',
    );
  }
}

function requiredText(value: string, message: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 128 || hasControlCharacter(trimmed)) {
    throw new RangeError(message);
  }
  return trimmed;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}
