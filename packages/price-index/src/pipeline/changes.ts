import { fromDecimalString } from '../money/money.ts';
import { isPublishable } from '../publish/gate.ts';
import type { ChangeEntry } from '../schema/changes.ts';
import type { LatestFile } from '../schema/price-index-files.ts';
import { recordIdentity, type PriceRecord } from '../schema/price-record.ts';
import { compareRecords } from '../storage/serialise.ts';

// Change detection (E11.6-09). A real change is a published value replaced
// by a different published value for the same record and currency
// (docs/features/price-index.md#change-log-and-monthly-report). So:
//
// - a first observation is not a change: there is no published value before;
// - a status change is not a change: a value that leaves or returns to the
//   publish gate is compared with the last value the gate let through, and
//   an equal value logs nothing;
// - a formatting difference is not a change: values are compared in exact
//   minor units, never as the source's text;
// - a `needs_review` value is logged only once approved, because only then
//   does it pass the gate, and it is dated by its observation.
//
// "Published" is always the publish gate's own `isPublishable()`.

/** A published record's value, as the gate let it through. */
function publishedValue(record: PriceRecord) {
  return fromDecimalString(
    record.price_local as string,
    record.currency as string,
  );
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * `(new − old) / old` as a signed percentage with one decimal, rounded half
 * away from zero, from exact minor units. A fall keeps its sign even when it
 * rounds to `-0.0`.
 */
export function changePercent(oldMinor: bigint, newMinor: bigint): string {
  if (oldMinor <= 0n) {
    throw new RangeError('a change is measured from a price above zero');
  }
  const difference = newMinor - oldMinor;
  const magnitude = difference < 0n ? -difference : difference;
  // Tenths of a percent: |difference| × 1000 / old, rounded half up.
  const tenths = (magnitude * 2000n + oldMinor) / (2n * oldMinor);
  const sign = difference < 0n ? '-' : '';
  return `${sign}${tenths / 10n}.${tenths % 10n}`;
}

/**
 * The date of the observation that carried a record's value: its
 * `observed_at` for a scraped value, its `source_verified_at` (the date the
 * founder verified it) for a manual entry, which has no `observed_at`.
 */
export function observationDate(record: PriceRecord, builtAt: string): string {
  return (
    record.observed_at?.slice(0, 10) ??
    record.source_verified_at ??
    builtAt.slice(0, 10)
  );
}

/**
 * The last published record of every identity that `next` publishes,
 * looked up newest first in `history`: the previous latest.json, then the
 * snapshots before it. An identity whose newest record is not published (a
 * `needs_review` waiting for approval, a `stale` or `missing` record) is
 * looked up further back, so the value it last published is the baseline.
 * One file is read at a time, and the walk stops as soon as every identity
 * has its baseline. An identity never published before has none.
 */
export async function lastPublishedRecords(
  next: LatestFile,
  history: AsyncIterable<LatestFile> | Iterable<LatestFile>,
): Promise<Map<string, PriceRecord>> {
  const wanted = new Set(
    next.records.filter(isPublishable).map((record) => recordIdentity(record)),
  );
  const found = new Map<string, PriceRecord>();
  if (wanted.size === 0) {
    return found;
  }
  for await (const file of history) {
    for (const record of file.records) {
      const identity = recordIdentity(record);
      if (wanted.has(identity) && isPublishable(record)) {
        found.set(identity, record);
        wanted.delete(identity);
      }
    }
    if (wanted.size === 0) {
      break;
    }
  }
  return found;
}

function sameEntry(a: ChangeEntry, b: ChangeEntry): boolean {
  return (
    a.market === b.market &&
    a.service_id === b.service_id &&
    a.plan_id === b.plan_id &&
    a.billing_period === b.billing_period &&
    a.old_price_local === b.old_price_local &&
    a.new_price_local === b.new_price_local &&
    a.currency === b.currency &&
    a.detected_on === b.detected_on
  );
}

/**
 * The real changes a build makes: every record `next` publishes whose value
 * differs, in exact minor units and the same currency, from the value its
 * identity last published (`baselines`, from `lastPublishedRecords`). An
 * entry already in the log (`logged`) is not repeated, so rebuilding the
 * same data logs a change once. Entries are in identity order.
 */
export function detectChanges(input: {
  next: LatestFile;
  baselines: ReadonlyMap<string, PriceRecord>;
  logged: readonly ChangeEntry[];
}): ChangeEntry[] {
  const changes: ChangeEntry[] = [];
  const records = input.next.records.filter(isPublishable).sort(compareRecords);
  for (const record of records) {
    const baseline = input.baselines.get(recordIdentity(record));
    if (
      baseline === undefined ||
      !isPublishable(baseline) ||
      baseline.currency !== record.currency
    ) {
      continue;
    }
    const before = publishedValue(baseline);
    const after = publishedValue(record);
    if (before.minor === after.minor) {
      continue;
    }
    const entry: ChangeEntry = {
      market: record.market,
      service_id: record.service_id,
      plan_id: record.plan_id,
      billing_period: record.billing_period,
      old_price_local: baseline.price_local as string,
      new_price_local: record.price_local as string,
      currency: record.currency as string,
      change_percent: changePercent(before.minor, after.minor),
      detected_on: observationDate(record, input.next.built_at),
      source: record.source,
    };
    if (!input.logged.some((logged) => sameEntry(logged, entry))) {
      changes.push(entry);
    }
  }
  return changes;
}

/**
 * Changes ordered largest percentage first, by size whatever the direction,
 * compared exactly; equal sizes in identity order, then by date.
 */
export function compareChangeSize(a: ChangeEntry, b: ChangeEntry): number {
  const aOld = fromDecimalString(a.old_price_local, a.currency).minor;
  const aNew = fromDecimalString(a.new_price_local, a.currency).minor;
  const bOld = fromDecimalString(b.old_price_local, b.currency).minor;
  const bNew = fromDecimalString(b.new_price_local, b.currency).minor;
  const aSize = (aNew > aOld ? aNew - aOld : aOld - aNew) * bOld;
  const bSize = (bNew > bOld ? bNew - bOld : bOld - bNew) * aOld;
  if (aSize !== bSize) {
    return aSize > bSize ? -1 : 1;
  }
  return (
    compareText(a.service_id, b.service_id) ||
    compareText(a.plan_id, b.plan_id) ||
    compareText(a.billing_period, b.billing_period) ||
    compareText(a.market, b.market) ||
    compareText(a.detected_on, b.detected_on)
  );
}
