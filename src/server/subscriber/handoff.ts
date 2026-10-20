import { createAuditService } from '../audit/service.ts';
import {
  handoffBatchSize,
  ineligibleDiscountVoidBatchSize,
  legacyBonusVoidBatchSize,
  openHandoffSnapshot,
  openUnsubscribeTokenSnapshot,
  voidIneligibleDiscountBatch,
  voidLegacyBonusBatch,
} from '../db/handoff.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { milestoneTiers, type AccessWindow } from '../referral/config.ts';

export interface HandoffCustomer {
  readonly type: 'customer';
  readonly email: string;
  readonly email_normalised: string;
  readonly referral_tier: number;
  readonly referral_code: string | null;
  readonly confirmed_referrals: number;
  readonly category_preference: readonly string[] | null;
  readonly survey_version: string | null;
  readonly source: string | null;
  readonly marketing_consent_at: string | null;
  readonly marketing_consent_version: string | null;
  readonly marketing_consent_source: string | null;
  readonly access_window: AccessWindow;
  readonly subslush_customer: boolean;
  readonly groups: readonly string[];
}

export interface HandoffDiscount {
  readonly type: 'held_discount';
  readonly award_id: string;
  readonly subscriber_id: string;
  readonly email_normalised: string;
  readonly tier: number;
  readonly discount_percent: number;
  readonly state: 'held';
  readonly outcome: 'carried_to_storefront';
  readonly qualification_deadline: string;
}

export interface HandoffConfirmedReferral {
  readonly type: 'confirmed_referral';
  readonly referrer_email_normalised: string;
  readonly referred_email_normalised: string;
}

export interface HandoffUnsubscribeToken {
  readonly type: 'unsubscribe_token';
  readonly token_sha256: string;
  readonly email_normalised: string;
  readonly origin_kind: 'marketing' | 'transactional';
  readonly expires_at: string;
}

export type HandoffRecord =
  | HandoffCustomer
  | HandoffDiscount
  | HandoffConfirmedReferral
  | HandoffUnsubscribeToken;

export interface HandoffCounts {
  readonly customers: number;
  readonly heldDiscounts: number;
  readonly confirmedReferrals: number;
  readonly unsubscribeTokens: number;
  readonly voidedIneligibleDiscounts: number;
  readonly voidedLegacyBonusEntries: number;
}

export function qualificationDeadline(storeLaunchAt: Date): string {
  if (!Number.isFinite(storeLaunchAt.getTime()))
    throw new RangeError('Store launch must be a valid instant.');
  const deadline = new Date(
    storeLaunchAt.getTime() + 90 * 24 * 60 * 60 * 1_000,
  );
  if (!Number.isFinite(deadline.getTime()))
    throw new RangeError('Store launch is outside the supported date range.');
  return deadline.toISOString();
}

export async function exportHandoff(
  database: DatabasePool,
  actor: string,
  storeLaunchAt: Date,
  writeRecord: (record: HandoffRecord) => Promise<void>,
  finishOutput: () => Promise<void>,
  clock: () => Date = () => new Date(),
): Promise<HandoffCounts> {
  if (actor.trim() === '') throw new Error('A handoff actor is required.');
  const deadline = qualificationDeadline(storeLaunchAt);
  const audit = createAuditService(database);
  let voidedLegacyBonusEntries = 0;
  for (;;) {
    const voided = await voidLegacyBonusBatch(
      database,
      async (connection, row) => {
        await createAuditService(connection).record({
          action: 'handoff.bonus_entries_voided',
          actor,
          subjectType: 'milestone_award',
          subjectId: row.id,
          detail: {
            reason: 'bonus_entries_unqualifiable_under_published_rules',
          },
        });
      },
    );
    voidedLegacyBonusEntries += voided;
    if (voided < legacyBonusVoidBatchSize) break;
  }

  let voidedIneligibleDiscounts = 0;
  for (;;) {
    const voided = await voidIneligibleDiscountBatch(
      database,
      async (connection, row) => {
        await createAuditService(connection).record({
          action: 'handoff.discount_voided',
          actor,
          subjectType: 'milestone_award',
          subjectId: row.id,
          detail: { reason: row.reason },
        });
      },
    );
    voidedIneligibleDiscounts += voided;
    if (voided < ineligibleDiscountVoidBatchSize) break;
  }

  const snapshot = await openHandoffSnapshot(database);
  try {
    await audit.record({
      action: 'export.run',
      actor,
      subjectType: 'handoff',
      subjectId: null,
      detail: {
        customer_count: snapshot.customerCount,
        held_discount_count: snapshot.discountCount,
        confirmed_referral_count: snapshot.referralCount,
        qualification_deadline: deadline,
        voided_ineligible_discounts: voidedIneligibleDiscounts,
        voided_legacy_bonus_entries: voidedLegacyBonusEntries,
      },
    });
    let customers = 0;
    let customerAfter: string | null = null;
    while (customers < snapshot.customerCount) {
      const page = await snapshot.customers(customerAfter);
      if (page.length === 0)
        throw new Error('Handoff customer snapshot ended early.');
      if (
        page.length > handoffBatchSize ||
        customers + page.length > snapshot.customerCount
      )
        throw new Error(
          'Handoff customer page exceeded its count or batch cap.',
        );
      for (const row of page) {
        if (
          row.access_window === null ||
          !['wave-1', 'wave-2', 'wave-3', 'wave-4'].includes(row.access_window)
        ) {
          throw new Error(
            'Verified handoff customer has no valid access wave.',
          );
        }
        const accessWindow = row.access_window as AccessWindow;
        await writeRecord({
          type: 'customer',
          email: row.email,
          email_normalised: row.email_normalised,
          referral_tier: row.referral_tier,
          referral_code: row.referral_code,
          confirmed_referrals: row.confirmed_referrals,
          category_preference: row.category_preference,
          survey_version: row.survey_version,
          source: row.source,
          marketing_consent_at: row.marketing_consent_at?.toISOString() ?? null,
          marketing_consent_version: row.marketing_consent_version,
          marketing_consent_source: row.marketing_consent_source,
          access_window: accessWindow,
          subslush_customer: row.subslush_customer,
          groups: row.subslush_customer
            ? [accessWindow, 'subslush-legacy']
            : [accessWindow],
        });
        customers += 1;
        customerAfter = row.id;
      }
    }
    let heldDiscounts = 0;
    let discountAfter: string | null = null;
    while (heldDiscounts < snapshot.discountCount) {
      const page = await snapshot.discounts(discountAfter);
      if (page.length === 0)
        throw new Error('Handoff discount snapshot ended early.');
      if (
        page.length > handoffBatchSize ||
        heldDiscounts + page.length > snapshot.discountCount
      )
        throw new Error(
          'Handoff discount page exceeded its count or batch cap.',
        );
      for (const row of page) {
        const tier = milestoneTiers.find(
          (candidate) => candidate.number === row.tier,
        );
        if (tier === undefined || tier.discountPercent <= 0)
          throw new Error('Held discount has no configured percentage.');
        await writeRecord({
          type: 'held_discount',
          award_id: row.id,
          subscriber_id: row.subscriber_id,
          email_normalised: row.email_normalised,
          tier: row.tier,
          discount_percent: tier.discountPercent,
          state: 'held',
          outcome: 'carried_to_storefront',
          qualification_deadline: deadline,
        });
        heldDiscounts += 1;
        discountAfter = row.id;
      }
    }
    let confirmedReferrals = 0;
    let referralAfter: string | null = null;
    while (confirmedReferrals < snapshot.referralCount) {
      const page = await snapshot.referrals(referralAfter);
      if (page.length === 0)
        throw new Error('Handoff referral snapshot ended early.');
      if (
        page.length > handoffBatchSize ||
        confirmedReferrals + page.length > snapshot.referralCount
      )
        throw new Error(
          'Handoff referral page exceeded its count or batch cap.',
        );
      for (const row of page) {
        await writeRecord({
          type: 'confirmed_referral',
          referrer_email_normalised: row.referrer_email_normalised,
          referred_email_normalised: row.referred_email_normalised,
        });
        confirmedReferrals += 1;
        referralAfter = row.id;
      }
    }
    const tokens = await openUnsubscribeTokenSnapshot(database, clock());
    let unsubscribeTokens = 0;
    try {
      let tokenAfter: string | null = null;
      while (unsubscribeTokens < tokens.count) {
        const page = await tokens.page(tokenAfter);
        if (
          page.length === 0 ||
          page.length > handoffBatchSize ||
          unsubscribeTokens + page.length > tokens.count
        )
          throw new Error(
            'Unsubscribe token snapshot count or batch cap changed.',
          );
        for (const row of page) {
          if (row.provider !== 'brevo' && row.provider !== 'resend')
            throw new Error(
              'Unsubscribe token has an unknown origin provider.',
            );
          await writeRecord({
            type: 'unsubscribe_token',
            token_sha256: row.token_hash.toString('hex'),
            email_normalised: row.email_normalised,
            origin_kind:
              row.provider === 'brevo' ? 'marketing' : 'transactional',
            expires_at: row.expires_at.toISOString(),
          });
          unsubscribeTokens += 1;
          tokenAfter = row.id;
        }
      }
    } finally {
      await tokens.close();
    }
    await finishOutput();
    await withTransaction(database, async (connection) => {
      const carryAudit = createAuditService(connection);
      let audited = 0;
      let auditAfter: string | null = null;
      while (audited < snapshot.discountCount) {
        const page = await snapshot.discounts(auditAfter);
        if (
          page.length === 0 ||
          page.length > handoffBatchSize ||
          audited + page.length > snapshot.discountCount
        )
          throw new Error(
            'Handoff discount audit snapshot did not match the export.',
          );
        for (const row of page) {
          await carryAudit.record({
            action: 'handoff.discount_carried',
            actor,
            subjectType: 'milestone_award',
            subjectId: row.id,
            detail: {
              outcome: 'carried_to_storefront',
              qualification_deadline: deadline,
            },
          });
          audited += 1;
          auditAfter = row.id;
        }
      }
    });
    return {
      customers,
      heldDiscounts,
      confirmedReferrals,
      unsubscribeTokens,
      voidedIneligibleDiscounts,
      voidedLegacyBonusEntries,
    };
  } finally {
    await snapshot.close();
  }
}
