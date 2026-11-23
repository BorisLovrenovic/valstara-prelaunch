import { createAuditService } from '../audit/service.ts';
import { redactAuditDetail } from '../audit/redact-detail.ts';
import type { AuditDetail } from '../audit/types.ts';
import { createGiveawayDrawRepository } from '../db/giveaway-draw.ts';
import type { DatabasePool } from '../db/pool.ts';
import { createReferralRepository } from '../db/referral.ts';
import { createReferralCouponRepository } from '../db/referral-coupon.ts';
import {
  createReferralVoidRepository,
  type ReferralVoidEdgeRow,
} from '../db/referral-void.ts';
import { withTransaction } from '../db/transaction.ts';

import {
  recomputeReferralRewards,
  referralRewardConfiguration,
  type ReferralRewardConfiguration,
} from './rewards.ts';

// E11.7-02: the founder voids one referral with a reason, or un-voids it.
// A voided edge is kept, with its reason, actor and time, and counts nowhere:
// every consumer of the confirmed count reads only non-voided edges, and the
// referrer's cached count is recomputed in the same transaction. Before the
// draw snapshot is committed, the edge's referral entry is voided with it and
// restored by an un-void; after commitment, nothing in the giveaway changes.
// The referrer's coupon ladder and wave 1 are recomputed in the same
// transaction (E11.7-03), so a void lowers them and an un-void restores them.

export const referralVoidReasonMaximumLength = 200;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const controlCharacter = /[\u0000-\u001f\u007f]/u;
const lockedReferrerStatuses = new Set([
  'disqualified',
  'erasure_pending',
  'erased',
]);

/** The request itself is malformed: the id, the reason or the actor. */
export class ReferralVoidInputError extends RangeError {
  public constructor(message: string) {
    super(message);
    this.name = 'ReferralVoidInputError';
  }
}

export type ReferralVoidRefusal =
  'already_voided' | 'not_changeable' | 'not_found' | 'not_voided';

/** The request is well formed, but the referral's state refuses it. */
export class ReferralVoidRefusedError extends Error {
  public readonly refusal: ReferralVoidRefusal;

  public constructor(refusal: ReferralVoidRefusal) {
    super(`The referral void was refused: ${refusal}.`);
    this.name = 'ReferralVoidRefusedError';
    this.refusal = refusal;
  }
}

/**
 * What happened to the edge's referral entry:
 * - `voided` / `restored`: this request changed it, before commitment;
 * - `unchanged`: an entry exists that this request leaves as it was;
 * - `none`: no referral entry has accrued for the edge;
 * - `draw_committed`: the draw snapshot is committed, so nothing is touched.
 */
export type ReferralVoidEntryOutcome =
  'draw_committed' | 'none' | 'restored' | 'unchanged' | 'voided';

export interface ReferralVoidResult {
  readonly edgeId: string;
  readonly referredId: string;
  readonly referrerId: string;
  readonly state: ReferralVoidEdgeRow['state'];
  readonly voided: boolean;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly voidedBy: string | null;
  readonly referrerConfirmedReferrals: number;
  readonly giveawayEntry: ReferralVoidEntryOutcome;
}

export interface ReferralVoidService {
  voidReferral(
    referredId: string,
    reason: string,
    actor: string,
  ): Promise<ReferralVoidResult>;
  unvoidReferral(
    referredId: string,
    reason: string,
    actor: string,
  ): Promise<ReferralVoidResult>;
}

/** A trimmed reason, refused when it is blank, too long or personal. */
export function normaliseReferralVoidReason(reason: unknown): string {
  if (typeof reason !== 'string') {
    throw new ReferralVoidInputError('A reason is required.');
  }
  const trimmed = reason.trim();
  if (
    trimmed === '' ||
    trimmed.length > referralVoidReasonMaximumLength ||
    controlCharacter.test(trimmed)
  ) {
    throw new ReferralVoidInputError(
      `A reason must be one line of 1 to ${referralVoidReasonMaximumLength} characters.`,
    );
  }
  // The reason is stored on the edge and in the append-only audit log. An
  // email or IP address in it would be personal data the audit log redacts,
  // so it is refused here and the two records always agree.
  if (redactAuditDetail({ value: trimmed }).value !== trimmed) {
    throw new ReferralVoidInputError(
      'A reason must not contain an email or IP address.',
    );
  }
  return trimmed;
}

function assertReferredId(referredId: string): void {
  if (!uuidPattern.test(referredId)) {
    throw new ReferralVoidInputError('A valid subscriber id is required.');
  }
}

function assertHumanActor(actor: string): string {
  const trimmed = actor.trim();
  if (trimmed === '' || trimmed.startsWith('system:')) {
    throw new ReferralVoidInputError('A human actor is required.');
  }
  return trimmed;
}

interface AuditCoupon {
  readonly number: number;
  readonly percent: number | null;
  readonly state: string;
}

interface AuditState {
  readonly voided_at: string | null;
  readonly void_reason: string | null;
  readonly voided_by: string | null;
  readonly referrer_confirmed_referrals: number;
  readonly referrer_coupons: readonly AuditCoupon[];
  readonly referrer_access_window: string | null;
  readonly giveaway_entry_voided: boolean | null;
}

export function createReferralVoidService(
  database: DatabasePool,
  clock: () => Date = () => new Date(),
  rewards: ReferralRewardConfiguration = referralRewardConfiguration,
): ReferralVoidService {
  async function change(
    operation: 'void' | 'unvoid',
    referredId: string,
    rawReason: string,
    rawActor: string,
  ): Promise<ReferralVoidResult> {
    assertReferredId(referredId);
    const reason = normaliseReferralVoidReason(rawReason);
    const actor = assertHumanActor(rawActor);

    return withTransaction(database, async (connection) => {
      const voids = createReferralVoidRepository(connection);
      const coupons = createReferralCouponRepository(connection);

      const found = await voids.findEdgeByReferred(referredId);
      if (found === null) throw new ReferralVoidRefusedError('not_found');
      if (found.referrer_id === null) {
        throw new ReferralVoidRefusedError('not_changeable');
      }
      const referrerId = found.referrer_id;

      // Match confirmation and signup: friend before referrer before edge.
      // The referrer lock serialises the count with concurrent signups.
      const friend =
        await createReferralRepository(connection).lockSubscriber(referredId);
      const referrer = await voids.lockReferrer(referrerId);
      if (referrer === null) throw new ReferralVoidRefusedError('not_found');
      const edge = await voids.lockEdge(found.id);
      if (edge === null || edge.referrer_id !== referrerId) {
        throw new ReferralVoidRefusedError('not_found');
      }
      // A disqualified, erasing or erased referrer's edges and entries are
      // governed by that decision; voiding underneath it could not be undone
      // exactly when the decision is reversed.
      if (lockedReferrerStatuses.has(referrer.status)) {
        throw new ReferralVoidRefusedError('not_changeable');
      }
      if (operation === 'void') {
        if (edge.voided_at !== null) {
          throw new ReferralVoidRefusedError('already_voided');
        }
        if (edge.state === 'rejected') {
          throw new ReferralVoidRefusedError('not_changeable');
        }
      } else if (edge.voided_at === null) {
        throw new ReferralVoidRefusedError('not_voided');
      }

      // Serialises with draw snapshot commitment (E7-05), as erasure does.
      await createGiveawayDrawRepository(connection).lockEntryLedger();
      const committed = await voids.drawSnapshotCommitted();
      const entryBefore = await voids.entryVoided(edge.id);
      const couponsBefore = (await coupons.listCoupons(referrerId)).map(
        (row): AuditCoupon => ({
          number: row.coupon_number,
          percent: row.percent,
          state: row.state,
        }),
      );
      const windowBefore =
        (await coupons.findWaves(referrerId))?.access_window ?? null;

      const now = clock();
      const updated =
        operation === 'void'
          ? await voids.markVoided(edge.id, now, reason, actor)
          : await voids.clearVoid(edge.id);
      if (updated !== 1) {
        throw new Error('The referral void could not be recorded.');
      }

      let giveawayEntry: ReferralVoidEntryOutcome;
      if (committed) {
        giveawayEntry = 'draw_committed';
      } else if (entryBefore === null) {
        giveawayEntry = 'none';
      } else {
        const changed =
          operation === 'void'
            ? await voids.voidEdgeEntry(edge.id, now)
            : await voids.restoreEdgeEntry(edge.id);
        giveawayEntry =
          changed === 1
            ? operation === 'void'
              ? 'voided'
              : 'restored'
            : 'unchanged';
      }
      const entryAfter = await voids.entryVoided(edge.id);

      const recomputed = await recomputeReferralRewards(
        connection,
        referrerId,
        { actor, configuration: rewards, now },
      );
      if (edge.partner_id !== null && friend?.status === 'verified') {
        await recomputeReferralRewards(connection, referredId, {
          actor,
          configuration: rewards,
          now,
        });
      }
      const confirmedReferrals = recomputed.confirmedReferrals;

      const before: AuditState = {
        voided_at: edge.voided_at?.toISOString() ?? null,
        void_reason: edge.void_reason,
        voided_by: edge.voided_by,
        referrer_confirmed_referrals: referrer.confirmed_referrals,
        referrer_coupons: couponsBefore,
        referrer_access_window: windowBefore,
        giveaway_entry_voided: entryBefore,
      };
      const ladderAfter = {
        referrer_confirmed_referrals: confirmedReferrals,
        referrer_coupons: recomputed.coupons.map((coupon): AuditCoupon => ({
          ...coupon,
        })),
        referrer_access_window: recomputed.accessWindow,
      };
      const after: AuditState =
        operation === 'void'
          ? {
              voided_at: now.toISOString(),
              void_reason: reason,
              voided_by: actor,
              ...ladderAfter,
              giveaway_entry_voided: entryAfter,
            }
          : {
              voided_at: null,
              void_reason: null,
              voided_by: null,
              ...ladderAfter,
              giveaway_entry_voided: entryAfter,
            };
      const detail: AuditDetail = {
        reason,
        referrer_id: referrerId,
        referred_id: referredId,
        draw_snapshot_committed: committed,
        giveaway_entry: giveawayEntry,
        before: {
          ...before,
          referrer_coupons: before.referrer_coupons.map((coupon) => ({
            ...coupon,
          })),
        },
        after: {
          ...after,
          referrer_coupons: after.referrer_coupons.map((coupon) => ({
            ...coupon,
          })),
        },
      };
      await createAuditService(connection).record({
        action: operation === 'void' ? 'referral.voided' : 'referral.unvoided',
        actor,
        detail,
        subjectId: edge.id,
        subjectType: 'referral_edge',
      });

      return {
        edgeId: edge.id,
        referredId,
        referrerId,
        state: edge.state,
        voided: operation === 'void',
        voidedAt: operation === 'void' ? now : null,
        voidReason: operation === 'void' ? reason : null,
        voidedBy: operation === 'void' ? actor : null,
        referrerConfirmedReferrals: confirmedReferrals,
        giveawayEntry,
      };
    });
  }

  return {
    voidReferral: (referredId, reason, actor) =>
      change('void', referredId, reason, actor),
    unvoidReferral: (referredId, reason, actor) =>
      change('unvoid', referredId, reason, actor),
  };
}
