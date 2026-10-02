import { randomUUID } from 'node:crypto';

import { z } from 'astro/zod';

import { createAuditService } from '../audit/service.ts';
import {
  getGiveawaySanctionedCountries,
  getGiveawaySubstitutionDays,
} from '../config.ts';
import {
  awardBatchLimit,
  createGiveawayAwardRepository,
  type AwardRow,
  type AwardSelection,
} from '../db/giveaway-award.ts';
import type { DatabasePool, DatabaseConnection } from '../db/pool.ts';
import { createRateLimitBucketRepository } from '../db/rate-limit-bucket.ts';
import { createFraudFlagRepository } from '../db/fraud-flag.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import { createEmailRepository } from '../db/email.ts';
import type { FlagService } from '../flags/types.ts';
import { createVerificationService } from '../verification/service.ts';

import {
  availableProducts,
  loadAwardCatalog,
  type AwardCatalog,
} from './award-catalog.ts';

const responseDays = 14;
const dayMilliseconds = 24 * 60 * 60 * 1_000;
const checkWindowMilliseconds = 15 * 60 * 1_000;
const checkIpLimit = 5;
const strictCheckIpLimit = 2;
const checkSubscriberLimit = 5;

const awardOfferSchema = z.object({
  approvedBy: z.string().min(1),
  unavailableProductIds: z.array(z.string()).min(1),
  cashEurCents: z.number().int().positive(),
  availableOriginalValueEurCents: z.number().int().nonnegative(),
  statedBundleValueEurCents: z.number().int().positive(),
  replacements: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      retailValueEurCents: z.number().int().positive(),
    }),
  ),
});

function readOffer(award: AwardRow): z.infer<typeof awardOfferSchema> {
  return awardOfferSchema.parse(award.substitution_offer);
}

export const canadianSkillQuestion = '(8 × 7) − 6';
const canadianSkillAnswer = 50;

export type AwardOutcome =
  | 'accepted'
  | 'disabled'
  | 'rate_limited'
  | 'confirmed'
  | 'substitution_offered'
  | 'replaced'
  | 'invalid_input';

export interface AwardCheckInput {
  readonly awardId: string;
  readonly token: string;
  readonly ipPrefixHash: string;
  readonly country: string;
  readonly ageConfirmed: boolean;
  readonly skillAnswer: string;
  readonly publicityPermission: boolean;
  readonly challengeTimedOut: boolean;
}

export interface SubstitutionInput {
  readonly awardId: string;
  readonly token: string;
  readonly ipPrefixHash: string;
  readonly choice: 'replacement' | 'decline';
  readonly productIds: readonly string[];
  readonly challengeTimedOut: boolean;
}

export interface ActiveOwnAward {
  readonly id: string;
  readonly state: AwardRow['state'];
  readonly substitutionState: AwardRow['substitution_state'];
  readonly responseDeadline: Date;
  readonly substitutionDeadline: Date | null;
  readonly country: string | null;
  readonly replacements: readonly {
    id: string;
    name: string;
    retailValueEurCents: number;
  }[];
}

export type OwnAward =
  ActiveOwnAward | { readonly id: string; readonly state: 'replaced' };

export interface AwardServiceDependencies {
  readonly flags: Pick<FlagService, 'isEnabled'>;
  readonly clock?: () => Date;
  readonly sanctionedCountries?: readonly string[];
  readonly substitutionDays?: number;
  readonly catalog?: (rulesVersion: string) => Promise<AwardCatalog>;
  readonly reportP3?: (at: Date, count: number) => void;
}

function afterDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * dayMilliseconds);
}

async function authenticate(
  connection: DatabaseConnection,
  token: string,
  now: Date,
): Promise<string | null> {
  if (token === '') return null;
  const result = await createVerificationService(connection, {
    clock: () => now,
  }).consumeForPurpose(token, 'status');
  return result.outcome === 'verified' || result.outcome === 'already'
    ? result.subscriberId
    : null;
}

export function createAwardService(
  database: DatabasePool,
  dependencies: AwardServiceDependencies,
) {
  const clock = dependencies.clock ?? (() => new Date());
  const sanctioned = new Set(
    dependencies.sanctionedCountries ?? getGiveawaySanctionedCountries(),
  );
  const substitutionDays =
    dependencies.substitutionDays ?? getGiveawaySubstitutionDays();
  const catalog = dependencies.catalog ?? loadAwardCatalog;
  const reportP3 =
    dependencies.reportP3 ??
    ((at: Date, count: number) => {
      process.stderr.write(
        `${JSON.stringify({
          event: 'giveaway_provisional_winner_replaced',
          severity: 'P3',
          count,
          occurred_at: at.toISOString(),
        })}\n`,
      );
    });
  if (!Number.isSafeInteger(substitutionDays) || substitutionDays < 1) {
    throw new RangeError('The substitution duration must be positive days.');
  }

  async function audit(
    connection: DatabaseConnection,
    action:
      | 'giveaway.award_notified'
      | 'giveaway.award_checked'
      | 'giveaway.award_replaced'
      | 'giveaway.substitution_offered'
      | 'giveaway.substitution_replacement'
      | 'giveaway.substitution_cash',
    awardId: string,
    detail: Record<string, string | number | boolean>,
    actor = 'system:award',
  ): Promise<void> {
    await createAuditService(connection).record({
      action,
      actor,
      subjectId: awardId,
      subjectType: 'giveaway_award',
      detail,
    });
  }

  async function queueNotice(
    connection: DatabaseConnection,
    awardId: string,
    drawId: string,
    selection: AwardSelection,
    now: Date,
  ): Promise<void> {
    const businessKey = `giveaway-winner:${drawId}:${selection.entry_id}`;
    if (await createEmailRepository(connection).findByBusinessKey(businessKey))
      return;
    const status = await createVerificationService(connection, {
      clock: () => now,
    }).issue(selection.subscriber_id, 'status');
    const inserted = await createEmailQueue(database, () => now).queue(
      {
        subscriberId: selection.subscriber_id,
        businessKey,
        template: 'giveaway_winner',
        provider: 'resend',
        payload: { award_id: awardId, token_id: status.id },
      },
      connection,
    );
    if (inserted) {
      await audit(connection, 'giveaway.award_notified', awardId, {
        draw_id: drawId,
        selection_position: Number(selection.position),
      });
    }
  }

  async function replace(
    connection: DatabaseConnection,
    award: AwardRow,
    reason: 'age' | 'sanctions' | 'skill' | 'deadline' | 'erasure',
    now: Date,
  ): Promise<AwardOutcome> {
    const repo = createGiveawayAwardRepository(connection);
    const marked = await repo.markCandidate({
      drawId: award.draw_id,
      position: award.selection_position,
      outcome: 'replaced',
      reason,
      at: now,
    });
    if (marked !== 1)
      throw new Error('The current candidate was not awaiting checks.');
    await audit(
      connection,
      'giveaway.award_checked',
      award.id,
      {
        outcome: 'failed',
        reason,
        selection_position: Number(award.selection_position),
      },
      reason === 'deadline' ? 'system:award' : 'subscriber',
    );
    const next = await repo.nextReserve(award.draw_id);
    if (next === null) {
      await repo.exhaust(award.id, now);
      await audit(connection, 'giveaway.award_replaced', award.id, {
        reason,
        outcome: 'reserves_exhausted',
      });
      return 'replaced';
    }
    await repo.claimCandidate({
      drawId: award.draw_id,
      awardId: award.id,
      selection: next,
    });
    await repo.replace({
      awardId: award.id,
      selection: next,
      at: now,
      deadlineAt: afterDays(now, responseDays),
    });
    await queueNotice(connection, award.id, award.draw_id, next, now);
    await audit(connection, 'giveaway.award_replaced', award.id, {
      reason,
      selection_position: Number(next.position),
    });
    return 'replaced';
  }

  async function settleCash(
    connection: DatabaseConnection,
    award: AwardRow,
    now: Date,
    outcome: 'declined' | 'expired',
  ): Promise<void> {
    const repo = createGiveawayAwardRepository(connection);
    const offer = readOffer(award);
    await repo.saveSubstitution({
      awardId: award.id,
      state: 'cash',
      detail: {
        outcome,
        unavailableProductIds: offer.unavailableProductIds,
        cashEurCents: offer.cashEurCents,
      },
      at: now,
    });
    await audit(
      connection,
      'giveaway.substitution_cash',
      award.id,
      { outcome, cash_eur_cents: offer.cashEurCents },
      outcome === 'declined' ? 'subscriber' : 'system:award',
    );
  }

  async function checkRateLimit(
    connection: DatabaseConnection,
    ipHash: string,
    subscriberId: string,
    now: Date,
    challengeTimedOut: boolean,
  ): Promise<boolean> {
    if (ipHash === '') return false;
    const limits = createRateLimitBucketRepository(connection);
    const threshold = new Date(now.getTime() - checkWindowMilliseconds);
    const ip = await limits.consume(
      `giveaway-award:ip:${challengeTimedOut ? 'strict:' : ''}${ipHash}`,
      now,
      threshold,
    );
    const person = await limits.consume(
      `giveaway-award:subscriber:${subscriberId}`,
      now,
      threshold,
    );
    return (
      ip <= (challengeTimedOut ? strictCheckIpLimit : checkIpLimit) &&
      person <= checkSubscriberLimit
    );
  }

  return {
    async excludeErasure(
      connection: DatabaseConnection,
      subscriberId: string,
    ): Promise<void> {
      const repo = createGiveawayAwardRepository(connection);
      await repo.lockFlow();
      for (;;) {
        const rows = await repo.provisionalForSubject(subscriberId);
        for (const award of rows)
          await replace(connection, award, 'erasure', clock());
        if (rows.length < awardBatchLimit) break;
      }
    },
    async initialize(): Promise<number> {
      if (!(await dependencies.flags.isEnabled('giveaway.open'))) return 0;
      return withTransaction(database, async (connection) => {
        const repo = createGiveawayAwardRepository(connection);
        await repo.lockFlow();
        const draw = await repo.publishedDraw();
        if (draw === null) return 0;
        await catalog(draw.rules_version);
        if (draw.prize_count > awardBatchLimit) {
          throw new Error('The award count exceeds the bounded award batch.');
        }
        let count = 0;
        const page = await repo.winnerPage(draw.id, null);
        if (page.length !== draw.prize_count) {
          throw new Error(
            'The published draw winner count does not match prizes.',
          );
        }
        for (const [index, selection] of page.entries()) {
          const slot = index + 1;
          if ((await repo.awardForSlot(draw.id, slot)) !== null) continue;
          const now = clock();
          const id = randomUUID();
          await repo.insertAward({
            id,
            drawId: draw.id,
            slot,
            hash: draw.entry_snapshot_hash,
            selection,
            notifiedAt: now,
            deadlineAt: afterDays(now, responseDays),
          });
          await repo.claimCandidate({
            drawId: draw.id,
            awardId: id,
            selection,
          });
          if (await repo.erasedSubject(selection.subscriber_id)) {
            await replace(
              connection,
              (await repo.awardById(id))!,
              'erasure',
              now,
            );
          } else {
            await queueNotice(connection, id, draw.id, selection, now);
          }
          count += 1;
        }
        return count;
      });
    },
    async ownAward(awardId: string, token: string): Promise<OwnAward | null> {
      if (!(await dependencies.flags.isEnabled('giveaway.open'))) return null;
      return withTransaction(database, async (connection) => {
        const person = await authenticate(connection, token, clock());
        if (person === null) return null;
        const repo = createGiveawayAwardRepository(connection);
        const award = await repo.awardById(awardId);
        if (award === null) return null;
        if (award.subscriber_id !== person) {
          return (await repo.replacedCandidate(awardId, person))
            ? { id: awardId, state: 'replaced' }
            : null;
        }
        const replacements: ActiveOwnAward['replacements'] =
          award.substitution_state === 'offered'
            ? readOffer(award).replacements
            : [];
        return {
          id: award.id,
          state: award.state,
          substitutionState: award.substitution_state,
          responseDeadline: award.response_deadline_at,
          substitutionDeadline: award.substitution_deadline_at,
          country: award.country_of_residence,
          replacements,
        };
      });
    },
    async submitChecks(input: AwardCheckInput): Promise<AwardOutcome> {
      if (!(await dependencies.flags.isEnabled('giveaway.open')))
        return 'disabled';
      const outcome = await withTransaction(database, async (connection) => {
        const repo = createGiveawayAwardRepository(connection);
        await repo.lockFlow();
        const now = clock();
        const person = await authenticate(connection, input.token, now);
        if (person === null) return 'accepted';
        if (
          !(await checkRateLimit(
            connection,
            input.ipPrefixHash,
            person,
            now,
            input.challengeTimedOut,
          ))
        )
          return 'rate_limited';
        if (input.challengeTimedOut) {
          await createFraudFlagRepository(
            connection,
          ).insertChallengeTimeoutFlag({
            id: randomUUID(),
            subscriberId: person,
          });
        }
        const award = await repo.awardById(input.awardId);
        if (award === null || award.subscriber_id !== person) return 'accepted';
        if (award.state !== 'notified') return 'accepted';
        if (now >= award.response_deadline_at) {
          return replace(connection, award, 'deadline', now);
        }
        if (!/^[A-Z]{2}$/u.test(input.country)) return 'invalid_input';
        if (!input.ageConfirmed) return replace(connection, award, 'age', now);
        if (sanctioned.has(input.country))
          return replace(connection, award, 'sanctions', now);
        const skillPassed =
          input.country !== 'CA' ||
          input.skillAnswer.trim() === String(canadianSkillAnswer);
        if (!skillPassed) return replace(connection, award, 'skill', now);
        const draw = await repo.publishedDraw();
        if (draw?.id !== award.draw_id)
          throw new Error('The award draw is unavailable.');
        const awardCatalog = await catalog(draw.rules_version);
        const products = availableProducts(awardCatalog, input.country);
        await repo.saveChecks({
          awardId: award.id,
          country: input.country,
          skillPassed: input.country === 'CA' ? true : null,
          publicity: input.publicityPermission,
          at: now,
        });
        await repo.markCandidate({
          drawId: award.draw_id,
          position: award.selection_position,
          outcome: 'confirmed',
          reason: null,
          at: now,
        });
        await audit(
          connection,
          'giveaway.award_checked',
          award.id,
          {
            outcome: 'passed',
            selection_position: Number(award.selection_position),
          },
          'subscriber',
        );
        if (products.unavailable.length === 0) return 'confirmed';
        const deadlineAt = afterDays(now, substitutionDays);
        const offer = {
          approvedBy: awardCatalog.approvedBy,
          unavailableProductIds: products.unavailable.map(
            (product) => product.id,
          ),
          cashEurCents: products.unavailable.reduce(
            (sum, product) => sum + product.retailValueEurCents,
            0,
          ),
          availableOriginalValueEurCents: products.original.reduce(
            (sum, product) => sum + product.retailValueEurCents,
            0,
          ),
          statedBundleValueEurCents: awardCatalog.bundleProductIds.reduce(
            (sum, id) =>
              sum +
              awardCatalog.products.find((product) => product.id === id)!
                .retailValueEurCents,
            0,
          ),
          replacements: products.replacements.map((product) => ({
            id: product.id,
            name: product.name,
            retailValueEurCents: product.retailValueEurCents,
          })),
        };
        await repo.offerSubstitution({
          awardId: award.id,
          at: now,
          deadlineAt,
          offer,
        });
        await audit(connection, 'giveaway.substitution_offered', award.id, {
          unavailable_count: products.unavailable.length,
          deadline_at: deadlineAt.toISOString(),
        });
        return 'substitution_offered';
      });
      if (outcome === 'replaced') reportP3(clock(), 1);
      return outcome;
    },
    async chooseSubstitution(input: SubstitutionInput): Promise<AwardOutcome> {
      if (!(await dependencies.flags.isEnabled('giveaway.open')))
        return 'disabled';
      return withTransaction(database, async (connection) => {
        const repo = createGiveawayAwardRepository(connection);
        await repo.lockFlow();
        const now = clock();
        const person = await authenticate(connection, input.token, now);
        if (person === null) return 'accepted';
        if (
          !(await checkRateLimit(
            connection,
            input.ipPrefixHash,
            person,
            now,
            input.challengeTimedOut,
          ))
        )
          return 'rate_limited';
        if (input.challengeTimedOut) {
          await createFraudFlagRepository(
            connection,
          ).insertChallengeTimeoutFlag({
            id: randomUUID(),
            subscriberId: person,
          });
        }
        const award = await repo.awardById(input.awardId);
        if (
          award === null ||
          award.subscriber_id !== person ||
          award.state !== 'confirmed' ||
          award.substitution_state !== 'offered'
        )
          return 'accepted';
        if (
          award.substitution_deadline_at === null ||
          now >= award.substitution_deadline_at
        ) {
          await settleCash(connection, award, now, 'expired');
          return 'confirmed';
        }
        if (input.choice === 'decline') {
          await settleCash(connection, award, now, 'declined');
          return 'confirmed';
        }
        const offer = readOffer(award);
        const allowed = new Map(
          offer.replacements.map((product) => [product.id, product]),
        );
        if (
          input.productIds.length === 0 ||
          new Set(input.productIds).size !== input.productIds.length ||
          input.productIds.some((id) => !allowed.has(id))
        )
          return 'invalid_input';
        const total =
          offer.availableOriginalValueEurCents +
          input.productIds.reduce(
            (sum, id) => sum + allowed.get(id)!.retailValueEurCents,
            0,
          );
        if (total < offer.statedBundleValueEurCents) return 'invalid_input';
        await repo.saveSubstitution({
          awardId: award.id,
          state: 'replacement',
          detail: {
            outcome: 'chosen',
            replacementProductIds: input.productIds,
            deliveredValueEurCents: total,
          },
          at: now,
        });
        await audit(
          connection,
          'giveaway.substitution_replacement',
          award.id,
          {
            replacement_count: input.productIds.length,
            delivered_value_eur_cents: total,
          },
          'subscriber',
        );
        return 'confirmed';
      });
    },
    async expireDue(): Promise<{ responses: number; substitutions: number }> {
      if (!(await dependencies.flags.isEnabled('giveaway.open')))
        return { responses: 0, substitutions: 0 };
      const result = await withTransaction(database, async (connection) => {
        const repo = createGiveawayAwardRepository(connection);
        await repo.lockFlow();
        const now = clock();
        const responses = await repo.overduePage(now);
        const substitutions = await repo.substitutionOverduePage(now);
        for (const { id } of responses) {
          const award = await repo.awardById(id);
          if (award?.state === 'notified')
            await replace(connection, award, 'deadline', now);
        }
        for (const { id } of substitutions) {
          const award = await repo.awardById(id);
          if (award?.substitution_state === 'offered')
            await settleCash(connection, award, now, 'expired');
        }
        return {
          responses: responses.length,
          substitutions: substitutions.length,
        };
      });
      if (result.responses > 0) reportP3(clock(), result.responses);
      return result;
    },
  };
}
