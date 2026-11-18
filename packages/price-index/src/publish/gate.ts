import {
  latestFileSchema,
  type LatestFile,
} from '../schema/price-index-files.ts';
import type { PriceRecord } from '../schema/price-record.ts';

// The publish gate (E11.6-06, epic rule 4). Only `ok` records and approved
// `manual_override` records reach a page, a hub, a sitemap, an FAQ, a ranking
// or a published report figure, and these three functions are the only way
// anything finds out which records those are. Every `manual_override` the
// merge writes is approved: it is within the change threshold of the last
// published value, has nothing to compare with, or carries a `review approve`
// (D-028 Q2), so the gate reads the status alone.
//
// This module imports only `src/schema`, so the site can import it without
// pulling in any other part of the tool (ADR-033).

export const publishableStatuses = ['ok', 'manual_override'] as const;

export type PublishableStatus = (typeof publishableStatuses)[number];

/**
 * A record as the site sees it. `price_usd_source` is left out: it ranks
 * markets and is never displayed (epic rule 3), so the view cannot show it.
 * `notes` is left out too: they are the merge's working notes for the
 * founder, and can name a value the gate refused, such as a scraped price
 * set aside or rejected.
 */
export interface PublishedRecord {
  readonly market: string;
  readonly service_id: string;
  readonly plan_id: string;
  readonly billing_period: PriceRecord['billing_period'];
  readonly price_local: string;
  readonly price_source_text: string | null;
  readonly currency: string;
  readonly source: string;
  readonly source_url: string | null;
  readonly observed_at: string | null;
  readonly source_verified_at: string | null;
  readonly status: PublishableStatus;
}

export interface PublishedView {
  readonly built_at: string;
  readonly records: readonly PublishedRecord[];
}

/** A plan, as rankings take it: one service × plan × billing period. */
export interface RankedPlan {
  readonly service_id: string;
  readonly plan_id: string;
  readonly billing_period: PriceRecord['billing_period'];
}

export interface RankedMarket {
  /** 1 for the most expensive. Equal USD figures share a rank (1, 1, 3). */
  readonly rank: number;
  readonly market: string;
  readonly record: PublishedRecord;
}

/** latest.json failed its schema, so nothing in it is published. */
export class PublishGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishGateError';
  }
}

/**
 * True only for an `ok` or `manual_override` record that carries a price
 * above zero and its currency. Every other status (`needs_review`,
 * `conflict`, `stale`, `missing`, `not_offered`) is never published.
 */
export function isPublishable(record: PriceRecord): boolean {
  return (
    (record.status === 'ok' || record.status === 'manual_override') &&
    record.price_local !== null &&
    record.currency !== null &&
    /[1-9]/.test(record.price_local)
  );
}

// A file validated once is not validated again on every page that reads it.
const validatedFiles = new WeakMap<object, LatestFile>();

function validated(latest: LatestFile): LatestFile {
  const known = validatedFiles.get(latest);
  if (known) {
    return known;
  }
  const result = latestFileSchema.safeParse(latest);
  if (!result.success) {
    throw new PublishGateError(
      `latest.json is invalid, so nothing is published: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  validatedFiles.set(latest, result.data);
  return result.data;
}

function published(record: PriceRecord): PublishedRecord {
  return {
    market: record.market,
    service_id: record.service_id,
    plan_id: record.plan_id,
    billing_period: record.billing_period,
    price_local: record.price_local as string,
    price_source_text: record.price_source_text,
    currency: record.currency as string,
    source: record.source,
    source_url: record.source_url,
    observed_at: record.observed_at,
    source_verified_at: record.source_verified_at,
    status: record.status as PublishableStatus,
  };
}

/**
 * The publishable records of a latest.json, without their USD figures or
 * notes, in the file's order. An invalid file throws `PublishGateError`: it publishes
 * nothing rather than something unchecked.
 */
export function publishedView(latest: LatestFile): PublishedView {
  const file = validated(latest);
  return {
    built_at: file.built_at,
    records: file.records.filter(isPublishable).map(published),
  };
}

/** A two-decimal USD figure in cents. The schema has checked its form. */
function usdCents(value: string): bigint {
  return BigInt(value.replace('.', ''));
}

/**
 * The enabled markets of one plan, most expensive first, ranked by
 * `price_usd_source` among publishable records that have one. A record
 * without a USD figure is published but never ranked, so M, the number of
 * markets a page says it ranks among, is this list's length. Ties share a
 * rank, and are listed by market code.
 */
export function rankMarkets(
  latest: LatestFile,
  plan: RankedPlan,
): RankedMarket[] {
  const candidates = validated(latest)
    .records.filter(
      (record) =>
        record.service_id === plan.service_id &&
        record.plan_id === plan.plan_id &&
        record.billing_period === plan.billing_period &&
        isPublishable(record) &&
        record.price_usd_source !== null,
    )
    .map((record) => ({
      record,
      cents: usdCents(record.price_usd_source as string),
    }))
    .sort((a, b) =>
      a.cents === b.cents
        ? a.record.market < b.record.market
          ? -1
          : a.record.market > b.record.market
            ? 1
            : 0
        : a.cents > b.cents
          ? -1
          : 1,
    );
  return candidates.map(({ record, cents }) => ({
    rank: 1 + candidates.filter((other) => other.cents > cents).length,
    market: record.market,
    record: published(record),
  }));
}
