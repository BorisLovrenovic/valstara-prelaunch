import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { ChainInfo, RandomnessBeacon } from 'drand-client';

import { createAuditService } from '../audit/service.ts';
import {
  getDrandConfiguration,
  getGiveawayEntryPeriodStart,
  type DrandConfiguration,
} from '../config.ts';
import {
  createGiveawayDrawRepository,
  drawBatchLimit,
  type LedgerEntryRow,
  type DrawRow,
  type SelectionRow,
} from '../db/giveaway-draw.ts';
import { createGiveawayEntryRepository } from '../db/giveaway-entry.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import type { FlagService } from '../flags/types.ts';
import {
  createTopTwentyReviewGate,
  type TopTwentyReviewGate,
} from '../fraud/top-twenty-review.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

import { giveawayEntryPeriodEnd } from './accrue.ts';
import {
  deriveDrawSeed,
  fetchVerifiedBeacon,
  readChainInfo,
  targetFutureRound,
  targetRoundAlreadyExists,
  verifyRecordedBeacon,
} from './beacon.ts';
import {
  currentDrawRulesFromFiles,
  type CurrentDrawRules,
} from './current-draw-rules.ts';
import { currentRulesFromFiles } from './current-rules-file.ts';
import { createGiveawayEntryReconciliationJob } from './reconcile.ts';

const retryMaximumMilliseconds = 60 * 60 * 1_000;
const publishedDrawStart = new Date('2027-04-01T00:00:00.000Z');

export class DrawRefusedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DrawRefusedError';
  }
}

export class DrawUnavailableError extends DrawRefusedError {}

class TargetRoundPreexistingError extends DrawRefusedError {}

export interface DrawService {
  executeDraw(
    actor: string,
  ): Promise<{ id: string; targetRound: number; targetRoundAt: Date }>;
  advancePending(): Promise<boolean>;
  reproduceDraw(drawId: string): Promise<boolean>;
}

export interface DrawDependencies {
  readonly clock?: () => Date;
  readonly config?: DrandConfiguration | null;
  readonly currentRules?: () => Promise<CurrentDrawRules>;
  readonly fetch?: typeof fetch;
  readonly reviewGate?: Pick<TopTwentyReviewGate, 'assertReviewedAndCurrent'>;
  readonly reconcile?: () => Promise<void>;
  readonly periodStart?: Date | null;
  readonly drawOpensAt?: Date;
}

export function snapshotLine(row: LedgerEntryRow): string {
  return `${JSON.stringify([
    row.id,
    row.subscriber_id,
    row.method,
    row.source_edge_id,
    row.rules_version,
    row.rules_sha256.toString('hex'),
  ])}\n`;
}

/** Each ledger row gets one independent exponential race ticket. */
export function entrySelectionScore(seed: string, entryId: string): number {
  if (!/^[a-f0-9]{64}$/u.test(seed)) throw new RangeError('Invalid draw seed.');
  const hex = createHmac('sha256', Buffer.from(seed, 'hex'))
    .update('valstara-giveaway-entry-v1:')
    .update(entryId)
    .digest('hex');
  const uniform = (Number.parseInt(hex.slice(0, 13), 16) + 0.5) / 2 ** 52;
  return -Math.log(uniform);
}

function retryDelay(attempt: number): number {
  return Math.min(
    retryMaximumMilliseconds,
    30_000 * 2 ** Math.min(attempt - 1, 7),
  );
}

export function createDrawService(
  database: DatabasePool,
  flags: Pick<FlagService, 'isEnabled'>,
  alerts: AlertTransport,
  dependencies: DrawDependencies = {},
): DrawService {
  const clock = dependencies.clock ?? (() => new Date());
  const config =
    dependencies.config === undefined
      ? getDrandConfiguration()
      : dependencies.config;
  const currentRules = dependencies.currentRules ?? currentDrawRulesFromFiles;
  const request = dependencies.fetch ?? fetch;
  const reviewGate =
    dependencies.reviewGate ?? createTopTwentyReviewGate(database);
  const periodStart =
    dependencies.periodStart === undefined
      ? getGiveawayEntryPeriodStart()
      : dependencies.periodStart;
  const drawOpensAt = dependencies.drawOpensAt ?? publishedDrawStart;
  const reconcile =
    dependencies.reconcile ??
    (async () => {
      const job = createGiveawayEntryReconciliationJob(
        database,
        flags,
        currentRulesFromFiles,
        periodStart,
      );
      for (let batch = 0; batch < 10_000; batch += 1) {
        const result = await job.run(drawBatchLimit);
        if (result.checked < drawBatchLimit) return;
      }
      throw new DrawRefusedError(
        'Entry reconciliation exceeded its bounded run.',
      );
    });

  async function assertReady(): Promise<DrandConfiguration> {
    if (!(await flags.isEnabled('giveaway.open')) || config === null) {
      throw new DrawUnavailableError('The giveaway draw is unavailable.');
    }
    return config;
  }

  async function commitOneSnapshot(
    actor: string,
    rules: CurrentDrawRules,
    info: ChainInfo,
    drand: DrandConfiguration,
  ): Promise<{ id: string; targetRound: number; targetRoundAt: Date }> {
    return withTransaction(database, async (connection) => {
      const repository = createGiveawayDrawRepository(connection);
      await repository.lockEntryLedger();
      if (await repository.active()) {
        throw new DrawRefusedError('A draw is already committed.');
      }
      await reviewGate.assertReviewedAndCurrent();
      if (
        periodStart === null ||
        (
          await createGiveawayEntryRepository(connection).missingEntitlements(
            periodStart,
            giveawayEntryPeriodEnd,
            1,
          )
        ).length > 0
      ) {
        throw new DrawRefusedError('Unreconciled giveaway entries remain.');
      }
      if ((await repository.eligiblePersonCount()) < rules.prizeCount) {
        throw new DrawRefusedError('There are fewer entrants than prizes.');
      }
      const id = randomUUID();
      await repository.createPending(id, actor);
      const hash = createHash('sha256');
      let count = 0;
      let afterId: string | null = null;
      while (true) {
        const page = await repository.ledgerPage(afterId);
        if (page.length === 0) break;
        for (const entry of page) hash.update(snapshotLine(entry));
        const copied = await repository.copySnapshot(
          id,
          page.map((entry) => entry.id),
        );
        if (copied !== page.length)
          throw new Error('The entry snapshot copy is incomplete.');
        count += page.length;
        afterId = page[page.length - 1].id;
        if (page.length < drawBatchLimit) break;
      }
      const committedAt = clock();
      const target = targetFutureRound(committedAt, info);
      if (await targetRoundAlreadyExists(drand, target.round, request)) {
        throw new TargetRoundPreexistingError(
          'The target drand round already exists; recommit required.',
        );
      }
      if (
        (await repository.commitSnapshot({
          drawId: id,
          hash: hash.digest(),
          count,
          committedAt,
          info,
          round: target.round,
          roundAt: target.scheduledAt,
          prizeCount: rules.prizeCount,
          rulesVersion: rules.rulesVersion,
          rulesSha256: rules.rulesSha256,
        })) !== 1
      )
        throw new Error('The snapshot commitment failed.');
      await createAuditService(connection).record({
        action: 'draw.executed',
        actor,
        subjectId: id,
        subjectType: 'giveaway_draw',
        detail: {
          phase: 'snapshot_committed',
          entry_count: count,
          target_round: target.round,
        },
      });
      return {
        id,
        targetRound: target.round,
        targetRoundAt: target.scheduledAt,
      };
    });
  }

  async function reproduceDraw(drawId: string): Promise<boolean> {
    const repository = createGiveawayDrawRepository(database);
    const draw = await repository.byId(drawId);
    if (
      draw?.entry_snapshot_hash === null ||
      draw?.entry_snapshot_hash === undefined ||
      draw.seed === null ||
      draw.snapshot_committed_at === null ||
      draw.seed_generated_at === null ||
      draw.drand_chain_info === null ||
      draw.target_round === null ||
      draw.target_round_at === null ||
      draw.beacon_round === null ||
      draw.beacon_randomness === null ||
      draw.beacon_signature === null ||
      draw.drand_chain_hash === null ||
      draw.prize_count === null ||
      draw.winners === null ||
      draw.beacon_verified_relays === null ||
      draw.beacon_verified_relays.length < 2 ||
      draw.beacon_relay_used === null
    )
      return false;
    const targetRound = Number(draw.target_round);
    const recordedChain: DrandConfiguration = {
      chainHash: draw.drand_chain_hash.toString('hex'),
      publicKey: draw.drand_chain_info.public_key,
      relays: [],
    };
    const expectedTarget = targetFutureRound(
      draw.snapshot_committed_at,
      draw.drand_chain_info,
    );
    if (
      Number(draw.beacon_round) !== targetRound ||
      draw.seed_generated_at <= draw.snapshot_committed_at ||
      draw.target_round_at.getTime() !== expectedTarget.scheduledAt.getTime() ||
      targetRound !== expectedTarget.round ||
      !draw.beacon_verified_relays.includes(draw.beacon_relay_used)
    )
      return false;
    const beacon: RandomnessBeacon =
      draw.beacon_previous_signature === null
        ? {
            round: targetRound,
            randomness: draw.beacon_randomness.toString('hex'),
            signature: draw.beacon_signature.toString('hex'),
          }
        : {
            round: targetRound,
            randomness: draw.beacon_randomness.toString('hex'),
            signature: draw.beacon_signature.toString('hex'),
            previous_signature: draw.beacon_previous_signature.toString('hex'),
          };
    if (
      !(await verifyRecordedBeacon(
        draw.drand_chain_info,
        beacon,
        targetRound,
        recordedChain,
      )) ||
      deriveDrawSeed(
        draw.entry_snapshot_hash,
        targetRound,
        beacon.randomness,
      ) !== draw.seed
    )
      return false;

    const hash = createHash('sha256');
    let count = 0;
    let afterId: string | null = null;
    while (true) {
      const page = await repository.snapshotPage(drawId, afterId);
      if (page.length === 0) break;
      for (const entry of page) {
        hash.update(snapshotLine(entry));
        if (entry.selection_score !== entrySelectionScore(draw.seed, entry.id))
          return false;
      }
      count += page.length;
      afterId = page[page.length - 1].id;
      if (page.length < drawBatchLimit) break;
    }
    if (
      !hash.digest().equals(draw.entry_snapshot_hash) ||
      count !== Number(draw.snapshot_count)
    )
      return false;

    let expectedScore: number | null = null;
    let expectedId: string | null = null;
    let actualPosition: string | null = null;
    let uniqueCount = 0;
    const winnerIds: string[] = [];
    while (true) {
      const expected: readonly SelectionRow[] =
        await repository.expectedUniquePage(drawId, expectedScore, expectedId);
      const actual: readonly SelectionRow[] = await repository.selectionsPage(
        drawId,
        actualPosition,
      );
      if (expected.length !== actual.length) return false;
      for (let index = 0; index < expected.length; index += 1) {
        if (
          expected[index].subscriber_id !== actual[index].subscriber_id ||
          expected[index].entry_id !== actual[index].entry_id ||
          actual[index].is_winner !== uniqueCount < draw.prize_count
        )
          return false;
        if (uniqueCount < draw.prize_count)
          winnerIds.push(actual[index].subscriber_id);
        uniqueCount += 1;
      }
      if (expected.length === 0) break;
      expectedScore = expected[expected.length - 1].selection_score ?? null;
      expectedId = expected[expected.length - 1].entry_id;
      actualPosition = actual[actual.length - 1].position;
      if (expected.length < drawBatchLimit) break;
    }
    return (
      uniqueCount >= draw.prize_count &&
      JSON.stringify(winnerIds) === JSON.stringify(draw.winners)
    );
  }

  async function scheduleRetry(
    draw: DrawRow,
    severity: 'P1' | 'P2',
    reason: string,
  ): Promise<void> {
    const at = clock();
    const attempt = draw.attempt_count + 1;
    await withTransaction(database, async (connection) => {
      const repo = createGiveawayDrawRepository(connection);
      await repo.scheduleRetry(
        draw.id,
        attempt,
        new Date(at.getTime() + retryDelay(attempt)),
        at,
      );
      await createAuditService(connection).record({
        action: 'draw.executed',
        actor: 'system:draw-worker',
        subjectId: draw.id,
        subjectType: 'giveaway_draw',
        detail: { phase: 'pending_retry', attempt, reason },
      });
    });
    await alerts.send({
      severity,
      occurredAt: at,
      event: 'giveaway_draw_pending',
      detail: { draw_id: draw.id, attempt, reason },
    });
  }

  async function advancePending(): Promise<boolean> {
    if (!(await flags.isEnabled('giveaway.open')) || config === null)
      return false;
    const drand = config;
    const now = clock();
    const active = await createGiveawayDrawRepository(database).active();
    if (
      active?.state !== 'pending' ||
      active.next_attempt_at === null ||
      active.next_attempt_at > now
    )
      return false;
    if (active.seed === null) {
      let verified;
      try {
        verified = await fetchVerifiedBeacon(
          drand,
          active.drand_chain_info!,
          Number(active.target_round),
          request,
        );
      } catch {
        await scheduleRetry(active, 'P1', 'beacon_unavailable_or_invalid');
        return false;
      }
      await withTransaction(database, async (connection) => {
        const repo = createGiveawayDrawRepository(connection);
        const draw = await repo.duePending(clock());
        if (draw === null || draw.id !== active.id || draw.seed !== null)
          return;
        const seed = deriveDrawSeed(
          draw.entry_snapshot_hash!,
          Number(draw.target_round),
          verified.beacon.randomness,
        );
        let afterId: string | null = null;
        while (true) {
          const page = await repo.snapshotPage(draw.id, afterId);
          if (page.length === 0) break;
          const scores = page.map((entry) =>
            entrySelectionScore(seed, entry.id),
          );
          if (
            (await repo.storeScores(
              draw.id,
              page.map((entry) => entry.id),
              scores,
            )) !== page.length
          ) {
            throw new Error('Draw scores were not fully stored.');
          }
          afterId = page[page.length - 1].id;
          if (page.length < drawBatchLimit) break;
        }
        let afterScore: number | null = null;
        let afterEntryId: string | null = null;
        let position = 0;
        while (true) {
          const page = await repo.scoredPage(draw.id, afterScore, afterEntryId);
          if (page.length === 0) break;
          const positions = page.map(() => ++position);
          await repo.insertSelections(
            draw.id,
            positions,
            page.map((entry) => entry.subscriber_id),
            page.map((entry) => entry.id),
          );
          afterScore = page[page.length - 1].selection_score;
          afterEntryId = page[page.length - 1].id;
          if (page.length < drawBatchLimit) break;
        }
        if (
          (await repo.markWinners(draw.id, draw.prize_count!)) !==
          draw.prize_count
        ) {
          throw new DrawRefusedError(
            'The draw has fewer unique entrants than prizes.',
          );
        }
        const winners = await repo.winnerIds(draw.id, draw.prize_count!);
        if (
          (await repo.storeBeacon({
            drawId: draw.id,
            seed,
            beacon: verified.beacon,
            relay: verified.relay,
            verifiedRelays: verified.verifiedRelays,
            at: clock(),
            winners,
          })) !== 1
        )
          throw new Error('The verified drand beacon was not stored.');
        await createAuditService(connection).record({
          action: 'draw.executed',
          actor: draw.executed_by,
          subjectId: draw.id,
          subjectType: 'giveaway_draw',
          detail: {
            phase: 'beacon_verified',
            round: Number(draw.target_round),
            winners: winners.length,
            relay: verified.relay,
          },
        });
      });
    }
    if (!(await reproduceDraw(active.id))) {
      await scheduleRetry(active, 'P1', 'reproduction_mismatch');
      return false;
    }
    try {
      await reviewGate.assertReviewedAndCurrent();
    } catch {
      await scheduleRetry(active, 'P1', 'top_twenty_review_required');
      return false;
    }
    await withTransaction(database, async (connection) => {
      const repo = createGiveawayDrawRepository(connection);
      if ((await repo.publish(active.id, clock())) !== 1) {
        throw new Error('The reproduced draw could not be published.');
      }
      await createAuditService(connection).record({
        action: 'draw.executed',
        actor: active.executed_by,
        subjectId: active.id,
        subjectType: 'giveaway_draw',
        detail: { phase: 'published' },
      });
    });
    return true;
  }

  return {
    async executeDraw(actor) {
      const drand = await assertReady();
      if (actor.trim().length === 0)
        throw new DrawRefusedError('An actor is required.');
      if (clock() < drawOpensAt) {
        throw new DrawRefusedError('The published draw date has not arrived.');
      }
      const rules = await currentRules();
      if (!rules.bundleContentsListed) {
        throw new DrawRefusedError(
          'The current rules do not list the bundle contents.',
        );
      }
      await reconcile();
      const info = await readChainInfo(drand, request);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let result;
        try {
          result = await commitOneSnapshot(actor, rules, info, drand);
        } catch (error) {
          if (error instanceof TargetRoundPreexistingError) continue;
          throw error;
        }
        let alreadyExists: boolean;
        try {
          alreadyExists = await targetRoundAlreadyExists(
            drand,
            result.targetRound,
            request,
          );
          if (!alreadyExists) return result;
        } catch (error) {
          await withTransaction(database, async (connection) => {
            await createGiveawayDrawRepository(connection).abort(result.id);
            await createAuditService(connection).record({
              action: 'draw.executed',
              actor,
              subjectId: result.id,
              subjectType: 'giveaway_draw',
              detail: { phase: 'commit_validation_unavailable' },
            });
          });
          throw error;
        }
        await withTransaction(database, async (connection) => {
          const repo = createGiveawayDrawRepository(connection);
          await repo.abort(result.id);
          await createAuditService(connection).record({
            action: 'draw.executed',
            actor,
            subjectId: result.id,
            subjectType: 'giveaway_draw',
            detail: { phase: 'target_round_preexisting' },
          });
        });
      }
      throw new DrawRefusedError(
        'The target drand round was already published.',
      );
    },
    advancePending,
    reproduceDraw,
  };
}
