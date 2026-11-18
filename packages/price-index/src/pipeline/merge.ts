import { z } from 'zod';

import { fromDecimalString, MoneyError, type Money } from '../money/index.ts';
import {
  approvalsFileSchema,
  type ApprovalEntry,
  type ApprovalsFile,
} from '../schema/approvals.ts';
import {
  catalogueFileSchema,
  type CatalogueFile,
} from '../schema/catalogue.ts';
import {
  manualOverridesFileSchema,
  type ManualEntry,
  type ManualOverridesFile,
  type PriceOverride,
} from '../schema/manual-overrides.ts';
import {
  marketsFileSchema,
  type Market,
  type MarketsFile,
} from '../schema/markets.ts';
import {
  latestFileSchema,
  type LatestFile,
} from '../schema/price-index-files.ts';
import {
  mergeSettingsSchema,
  type MergeSettings,
} from '../schema/price-index-settings.ts';
import {
  missingReasons,
  priceRecordObjectSchema,
  recordIdentity,
  type MissingReason,
  type PriceRecord,
} from '../schema/price-record.ts';
import type { Observation, SourceGap } from '../sources/source-adapter.ts';
import { compareRecords } from '../storage/serialise.ts';
import { joinNotes, notes, valueText } from './notes.ts';

// The merge (E11.6-06, docs/features/price-index.md#validation-merge-and-the-publish-gate).
// A pure function of the previous latest.json, one run's observations and
// gaps, the founder's manual entries and decisions, the configuration and an
// injected clock. It returns the next latest.json and writes nothing.
//
// It holds exactly one record for every enabled market × catalogue plan
// (D-028 Q3 d), each decided by these rules, in this order:
//
// 1. The scraped side. An observation is this run's value. A failed page
//    keeps the previous scraped value with its old `observed_at`, and any
//    open flag (Q3 c). A plan the source no longer prices, where it had a
//    scraped value before, has disappeared.
// 2. The checks. A scraped value in another currency than the market's, or
//    not above zero, is `needs_review` and can never be approved (Q3 a); a
//    manual entry fills its gap as usual.
// 3. Precedence. A manual entry fills any gap. A scraped value that agrees
//    with a price override is `ok`, and the override is retirable. One that
//    disagrees with an override, or prices a `not_offered` plan, is a
//    `conflict` until the founder approves or rejects it (Q1).
// 4. The change threshold. A value is compared with the previous record's
//    only when that was `ok`, `manual_override` or `stale` (Q2). After a
//    `needs_review` or `conflict` record, a new scraped value stays
//    `needs_review` until approved, and so does an override unless that
//    record was a disappearance, which shows no value. Otherwise an override
//    within the threshold, or with nothing to compare with, is
//    `manual_override`.
// 5. Staleness. Only `ok`, `manual_override` and `not_offered` go `stale`:
//    scraped values a set number of days after `observed_at`, manual entries
//    after `verified_at` (Q3 b).
//
// A decision in approvals.json binds to one value: identity, `price_local`,
// `currency` and `source`. The last decision for that value counts.

export interface MergeClock {
  now(): Date;
}

/** One run's reading of the source: what `SourceAdapter.parse` returned. */
export interface MergeRun {
  /** The source every observation carries, e.g. `scraper:youfundceo.com`. */
  readonly source: string;
  /** When the run read the pages, RFC 3339 UTC. */
  readonly observedAt: string;
  readonly observations: readonly Observation[];
  readonly gaps: readonly SourceGap[];
}

export interface MergeInput {
  /** The current latest.json, or null before the first build. */
  readonly previous: LatestFile | null;
  readonly run: MergeRun;
  readonly overrides: ManualOverridesFile;
  readonly approvals: ApprovalsFile;
  readonly catalogue: CatalogueFile;
  readonly markets: MarketsFile;
  readonly settings: MergeSettings;
  readonly clock: MergeClock;
}

export const mergeErrorCodes = [
  /** An input file or value fails its schema. */
  'invalid_input',
  /** Two observations, gaps or manual entries for one record. */
  'duplicate_input',
  /** An entry for a tracked plan in a billing period the plan does not have. */
  'billing_period',
  /** A manual override in another currency than its market's. */
  'override_currency',
  /** The merge built a file that fails its own schema. A defect, never data. */
  'invalid_output',
] as const;

export type MergeErrorCode = (typeof mergeErrorCodes)[number];

export class MergeError extends Error {
  readonly code: MergeErrorCode;

  constructor(code: MergeErrorCode, message: string) {
    super(message);
    this.name = 'MergeError';
    this.code = code;
  }
}

const millisecondsPerDay = 86_400_000;

const observationSchema = priceRecordObjectSchema
  .pick({
    market: true,
    service_id: true,
    plan_id: true,
    billing_period: true,
    price_source_text: true,
    price_usd_source: true,
    source_url: true,
    source_verified_at: true,
  })
  .extend({
    price_local: z.string(),
    currency: z.string(),
    source: priceRecordObjectSchema.shape.source,
    observed_at: z.iso.datetime(),
  });

const gapSchema = priceRecordObjectSchema
  .pick({
    market: true,
    service_id: true,
    plan_id: true,
    billing_period: true,
    source_url: true,
  })
  .extend({ reason: z.enum(missingReasons), note: z.string().nullable() });

const runSchema = z.object({
  source: priceRecordObjectSchema.shape.source,
  observedAt: z.iso.datetime(),
  observations: z.array(observationSchema),
  gaps: z.array(gapSchema),
});

function checked<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MergeError(
      'invalid_input',
      `${what} is invalid: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

function money(value: string, currency: string, what: string): Money {
  try {
    return fromDecimalString(value, currency);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new MergeError('invalid_input', `${what}: ${error.message}`);
    }
    throw error;
  }
}

/** The fields a record takes from the scraper, observed now or kept. */
interface Scraped {
  readonly price_local: string;
  readonly price_source_text: string | null;
  readonly currency: string;
  readonly price_usd_source: string | null;
  readonly source: string;
  readonly source_url: string | null;
  readonly observed_at: string | null;
  readonly source_verified_at: string | null;
  /** The note saying the value was kept from an earlier run, if it was. */
  readonly kept: string | null;
}

type RunState =
  | { readonly kind: 'observed'; readonly observation: Observation }
  | { readonly kind: 'declared'; readonly gap: SourceGap }
  | {
      readonly kind: 'failed';
      readonly reason: MissingReason;
      readonly gap: SourceGap | null;
    };

interface Baseline {
  readonly record: PriceRecord;
  readonly money: Money;
}

interface Identity {
  readonly market: string;
  readonly service_id: string;
  readonly plan_id: string;
  readonly billing_period: PriceRecord['billing_period'];
}

interface RecordContext {
  readonly identity: Identity;
  readonly market: Market;
  readonly previous: PriceRecord | undefined;
  readonly state: RunState;
  readonly entry: ManualEntry | undefined;
  readonly decisions: readonly ApprovalEntry[];
  readonly run: MergeRun;
  readonly settings: MergeSettings;
  readonly now: Date;
}

function hasScrapedValue(record: PriceRecord): boolean {
  return (
    record.source !== 'manual' &&
    record.price_local !== null &&
    record.currency !== null
  );
}

/** A `needs_review` record with no price: a plan that disappeared. */
function isDisappearance(record: PriceRecord): boolean {
  return (
    record.status === 'needs_review' &&
    record.source !== 'manual' &&
    record.price_local === null
  );
}

function scrapedFromObservation(observation: Observation): Scraped {
  return {
    price_local: observation.price_local,
    price_source_text: observation.price_source_text,
    currency: observation.currency,
    price_usd_source: observation.price_usd_source,
    source: observation.source,
    source_url: observation.source_url,
    observed_at: observation.observed_at,
    source_verified_at: observation.source_verified_at,
    kept: null,
  };
}

function scrapedFromPrevious(previous: PriceRecord, reason: string): Scraped {
  return {
    price_local: previous.price_local as string,
    price_source_text: previous.price_source_text,
    currency: previous.currency as string,
    price_usd_source: previous.price_usd_source,
    source: previous.source,
    source_url: previous.source_url,
    observed_at: previous.observed_at,
    source_verified_at: previous.source_verified_at,
    kept: notes.kept(previous, reason),
  };
}

function isPositive(value: Money): boolean {
  return value.minor > 0n;
}

/** More than `percent` % from the baseline. Exactly `percent` % is within. */
function beyondThreshold(value: Money, base: Money, percent: number): boolean {
  const difference =
    value.minor > base.minor
      ? value.minor - base.minor
      : base.minor - value.minor;
  return difference * 100n > BigInt(percent) * base.minor;
}

function mergeRecord(context: RecordContext): PriceRecord {
  const { identity, market, previous, state, entry, decisions, run } = context;
  const percent = context.settings.change_threshold_percent;

  function lastDecision(
    value: { price_local: string | null; currency: string | null },
    source: string,
  ): ApprovalEntry | undefined {
    return decisions.findLast(
      (decision) =>
        decision.price_local === value.price_local &&
        decision.currency === value.currency &&
        decision.source === source,
    );
  }

  function baseline(): Baseline | null {
    if (
      previous === undefined ||
      !['ok', 'manual_override', 'stale'].includes(previous.status) ||
      previous.price_local === null ||
      previous.currency === null
    ) {
      return null;
    }
    return {
      record: previous,
      money: money(previous.price_local, previous.currency, 'previous record'),
    };
  }

  /**
   * After a `needs_review` or `conflict` record, a new scraped value waits
   * for an approval, whatever it is (Q2): a flagged rise never publishes
   * itself on a later build. A disappearance counts, since it is
   * `needs_review` too.
   */
  function scrapedAfterFlag(): string | null {
    return previous !== undefined &&
      (previous.status === 'needs_review' || previous.status === 'conflict')
      ? notes.afterFlag(previous)
      : null;
  }

  /**
   * The same for an override, except after a disappearance: that record
   * shows no value, so a manual entry fills it with nothing to compare with
   * (Q1). After a flagged record that shows a value, the last published
   * value is no longer in the record, so the override waits for an
   * approval rather than publish unchecked.
   */
  function overrideAfterFlag(): string | null {
    return previous !== undefined && previous.price_local !== null
      ? scrapedAfterFlag()
      : null;
  }

  /** Why a value needs an approval against the baseline, or null if not. */
  function changeFlag(value: Money): string | null {
    const base = baseline();
    if (base === null) {
      return null;
    }
    if (base.money.currency !== value.currency) {
      return notes.otherCurrency(base.record);
    }
    return beyondThreshold(value, base.money, percent)
      ? notes.beyondThreshold(percent, base.record)
      : null;
  }

  function staleScraped(record: PriceRecord): PriceRecord {
    // A scraped record with no readable observation time is never fresh.
    const observed =
      record.observed_at === null ? null : Date.parse(record.observed_at);
    const limit = context.settings.stale_after_days.scraped;
    const fresh =
      observed !== null &&
      context.now.getTime() - observed <= limit * millisecondsPerDay;
    return fresh
      ? record
      : {
          ...record,
          status: 'stale',
          notes: joinNotes([record.notes, notes.stale(limit)]),
        };
  }

  function staleManual(record: PriceRecord, verifiedAt: string): PriceRecord {
    const today = Date.parse(context.now.toISOString().slice(0, 10));
    const verified = Date.parse(verifiedAt);
    const limit = context.settings.stale_after_days.manual;
    const fresh = (today - verified) / millisecondsPerDay <= limit;
    return fresh
      ? record
      : {
          ...record,
          status: 'stale',
          notes: joinNotes([record.notes, notes.stale(limit)]),
        };
  }

  function fromScraped(
    scraped: Scraped,
    status: PriceRecord['status'],
    lines: (string | null)[],
  ): PriceRecord {
    return {
      ...identity,
      price_local: scraped.price_local,
      price_source_text: scraped.price_source_text,
      currency: scraped.currency,
      price_usd_source: scraped.price_usd_source,
      source: scraped.source,
      source_url: scraped.source_url,
      observed_at: scraped.observed_at,
      source_verified_at: scraped.source_verified_at,
      status,
      missing_reason: null,
      notes: joinNotes([scraped.kept, ...lines]),
    };
  }

  function okScraped(scraped: Scraped, lines: (string | null)[]): PriceRecord {
    return staleScraped(fromScraped(scraped, 'ok', lines));
  }

  function fromOverride(
    override: PriceOverride,
    status: PriceRecord['status'],
    lines: (string | null)[],
  ): PriceRecord {
    return {
      ...identity,
      price_local: override.price_local,
      price_source_text: null,
      currency: override.currency,
      price_usd_source: override.price_usd_source,
      source: 'manual',
      source_url: override.source_url,
      observed_at: null,
      source_verified_at: override.verified_at,
      status,
      missing_reason: null,
      notes: joinNotes([override.note, ...lines]),
    };
  }

  /** A manual entry filling the record: an override or a `not_offered`. */
  function manual(
    manualEntry: ManualEntry,
    lines: (string | null)[],
  ): PriceRecord {
    if (manualEntry.kind === 'not_offered') {
      return staleManual(
        {
          ...identity,
          price_local: null,
          price_source_text: null,
          currency: null,
          price_usd_source: null,
          source: 'manual',
          source_url: manualEntry.source_url,
          observed_at: null,
          source_verified_at: manualEntry.verified_at,
          status: 'not_offered',
          missing_reason: null,
          notes: joinNotes([manualEntry.note, ...lines]),
        },
        manualEntry.verified_at,
      );
    }
    const value = money(
      manualEntry.price_local,
      manualEntry.currency,
      'manual override',
    );
    const flag = overrideAfterFlag() ?? changeFlag(value);
    if (flag === null) {
      return staleManual(
        fromOverride(manualEntry, 'manual_override', lines),
        manualEntry.verified_at,
      );
    }
    const decision = lastDecision(manualEntry, 'manual');
    const shown = valueText(manualEntry);
    if (decision?.decision === 'approve') {
      return staleManual(
        fromOverride(manualEntry, 'manual_override', [
          ...lines,
          notes.approved(decision, shown),
        ]),
        manualEntry.verified_at,
      );
    }
    return fromOverride(manualEntry, 'needs_review', [
      ...lines,
      flag,
      decision ? notes.rejected(decision, shown) : null,
    ]);
  }

  function missing(
    reason: MissingReason,
    lines: (string | null)[],
  ): PriceRecord {
    const gap = state.kind === 'observed' ? null : state.gap;
    return {
      ...identity,
      price_local: null,
      price_source_text: null,
      currency: null,
      price_usd_source: null,
      source: run.source,
      source_url: gap?.source_url ?? null,
      observed_at: state.kind === 'declared' ? run.observedAt : null,
      source_verified_at: null,
      status: 'missing',
      missing_reason: reason,
      notes: joinNotes([gap?.note ?? null, ...lines]),
    };
  }

  // 1. The scraped side.
  let scraped: Scraped | null = null;
  let disappearance: string | null = null;
  let reason: MissingReason = 'market_failed';
  if (state.kind === 'observed') {
    scraped = scrapedFromObservation(state.observation);
  } else {
    reason = state.kind === 'declared' ? state.gap.reason : state.reason;
    if (previous !== undefined && hasScrapedValue(previous)) {
      if (state.kind === 'failed') {
        scraped = scrapedFromPrevious(previous, reason);
      } else {
        disappearance = notes.disappeared(previous);
      }
    } else if (previous !== undefined && isDisappearance(previous)) {
      // An open disappearance stays open, with its last value.
      disappearance =
        previous.notes?.split('\n')[0] ?? notes.disappeared(previous);
    }
  }

  // 2. The checks a scraped value must pass.
  let broken: string | null = null;
  let scrapedMoney: Money | null = null;
  if (scraped !== null) {
    scrapedMoney = money(scraped.price_local, scraped.currency, 'observation');
    if (scraped.currency !== market.currency) {
      broken = notes.currencyMismatch(
        scraped.currency,
        market.code,
        market.currency,
      );
    } else if (!isPositive(scrapedMoney)) {
      broken = notes.notAboveZero();
    }
  }

  // 3 and 4. Precedence, decisions and the change threshold.
  if (scraped !== null && scrapedMoney !== null && broken === null) {
    const shown = valueText(scraped);
    const decision = lastDecision(scraped, scraped.source);

    if (entry !== undefined) {
      const agrees =
        entry.kind === 'price' &&
        entry.currency === scraped.currency &&
        entry.price_local === scraped.price_local;
      if (agrees) {
        const flag = scrapedAfterFlag() ?? changeFlag(scrapedMoney);
        if (flag === null) {
          return okScraped(scraped, [notes.retirable()]);
        }
        if (decision?.decision === 'approve') {
          return okScraped(scraped, [
            notes.retirable(),
            notes.approved(decision, shown),
          ]);
        }
        return fromScraped(scraped, 'needs_review', [
          notes.matchesOverride(),
          flag,
          decision ? notes.rejected(decision, shown) : null,
        ]);
      }
      // A disagreement, or a price for a `not_offered` plan: a conflict.
      if (decision?.decision === 'approve') {
        return okScraped(scraped, [notes.approved(decision, shown)]);
      }
      if (decision?.decision === 'reject') {
        return manual(entry, [notes.rejectedForEntry(decision, shown)]);
      }
      return fromScraped(scraped, 'conflict', [notes.conflict(entry)]);
    }

    const flag = scrapedAfterFlag() ?? changeFlag(scrapedMoney);
    if (flag === null) {
      return okScraped(scraped, []);
    }
    if (decision?.decision === 'approve') {
      return okScraped(scraped, [notes.approved(decision, shown)]);
    }
    return fromScraped(scraped, 'needs_review', [
      flag,
      decision ? notes.rejected(decision, shown) : null,
    ]);
  }

  if (entry !== undefined) {
    return manual(
      entry,
      scraped !== null ? [broken, notes.setAside(valueText(scraped))] : [],
    );
  }
  if (scraped !== null) {
    // A value that breaks a check: shown for review, never approvable.
    return fromScraped(scraped, 'needs_review', [broken, notes.unapprovable()]);
  }
  if (disappearance !== null) {
    const decision = lastDecision(
      { price_local: null, currency: null },
      run.source,
    );
    if (decision?.decision === 'approve') {
      return missing(reason, [
        disappearance,
        notes.disappearanceApproved(decision),
      ]);
    }
    return {
      ...missing(reason, []),
      status: 'needs_review',
      missing_reason: null,
      notes: joinNotes([
        disappearance,
        decision ? notes.rejected(decision, 'The disappearance') : null,
      ]),
    };
  }
  return missing(reason, []);
}

function key(entry: Identity): string {
  return recordIdentity(entry);
}

/** Groups entries by identity, refusing a second one for the same record. */
function byIdentity<T extends Identity>(
  entries: readonly T[],
  what: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of entries) {
    const identity = key(entry);
    if (map.has(identity)) {
      throw new MergeError(
        'duplicate_input',
        `more than one ${what} for ${identity}`,
      );
    }
    map.set(identity, entry);
  }
  return map;
}

/** Merges one run into the price index. Pure: it reads and writes no file. */
export function mergePriceIndex(input: MergeInput): LatestFile {
  const previous =
    input.previous === null
      ? null
      : checked(latestFileSchema, input.previous, 'the previous latest.json');
  const run = checked(runSchema, input.run, 'the run') as MergeRun;
  const overrides = checked(
    manualOverridesFileSchema,
    input.overrides,
    'manual-overrides.json',
  );
  const approvals = checked(
    approvalsFileSchema,
    input.approvals,
    'approvals.json',
  );
  const catalogue = checked(
    catalogueFileSchema,
    input.catalogue,
    'the catalogue',
  );
  const markets = checked(marketsFileSchema, input.markets, 'the markets');
  const settings = checked(
    mergeSettingsSchema,
    input.settings,
    'the merge settings',
  );
  const now = input.clock.now();

  const observations = byIdentity(run.observations, 'observation');
  const gaps = byIdentity(run.gaps, 'gap');
  for (const identity of observations.keys()) {
    if (gaps.has(identity)) {
      throw new MergeError(
        'duplicate_input',
        `both an observation and a gap for ${identity}`,
      );
    }
  }
  const entries = byIdentity(overrides.overrides, 'manual entry');
  const previousRecords = new Map(
    (previous?.records ?? []).map((record) => [key(record), record]),
  );
  const decisions = new Map<string, ApprovalEntry[]>();
  for (const decision of approvals.approvals) {
    const list = decisions.get(key(decision)) ?? [];
    list.push(decision);
    decisions.set(key(decision), list);
  }

  const enabled = markets.markets.filter((market) => market.enabled);
  const marketByCode = new Map(enabled.map((market) => [market.code, market]));
  const planPeriods = new Map<string, PriceRecord['billing_period']>();
  for (const service of catalogue.services) {
    for (const plan of service.plans) {
      planPeriods.set(
        `${service.service_id}/${plan.plan_id}`,
        plan.billing_period,
      );
    }
  }

  // The billing-period check, and the override's market currency: an entry
  // for a tracked plan in an enabled market must match the configuration.
  // Entries for a removed plan or a disabled market produce no record.
  const inputs: [string, readonly Identity[]][] = [
    ['observation', run.observations],
    ['gap', run.gaps],
    ['manual entry', overrides.overrides],
  ];
  for (const [what, list] of inputs) {
    for (const entry of list) {
      const period = planPeriods.get(`${entry.service_id}/${entry.plan_id}`);
      if (marketByCode.has(entry.market) && period !== undefined) {
        if (entry.billing_period !== period) {
          throw new MergeError(
            'billing_period',
            `${what} for ${key(entry)}: the plan is billed by the ${period}, not the ${entry.billing_period}`,
          );
        }
      }
    }
  }
  for (const entry of overrides.overrides) {
    const market = marketByCode.get(entry.market);
    if (
      entry.kind === 'price' &&
      market !== undefined &&
      planPeriods.has(`${entry.service_id}/${entry.plan_id}`) &&
      entry.currency !== market.currency
    ) {
      throw new MergeError(
        'override_currency',
        `manual override for ${key(entry)} is in ${entry.currency}, but ${market.code} uses ${market.currency}`,
      );
    }
  }

  const records: PriceRecord[] = [];
  for (const service of catalogue.services) {
    for (const plan of service.plans) {
      for (const market of enabled) {
        const identity: Identity = {
          market: market.code,
          service_id: service.service_id,
          plan_id: plan.plan_id,
          billing_period: plan.billing_period,
        };
        const id = key(identity);
        const observation = observations.get(id);
        const gap = gaps.get(id);
        const state: RunState =
          observation !== undefined
            ? { kind: 'observed', observation }
            : gap !== undefined &&
                (gap.reason === 'source_no_price' ||
                  gap.reason === 'not_on_source')
              ? { kind: 'declared', gap }
              : {
                  kind: 'failed',
                  reason: gap?.reason ?? 'market_failed',
                  gap: gap ?? null,
                };
        records.push(
          mergeRecord({
            identity,
            market,
            previous: previousRecords.get(id),
            state,
            entry: entries.get(id),
            decisions: decisions.get(id) ?? [],
            run,
            settings,
            now,
          }),
        );
      }
    }
  }

  const result = latestFileSchema.safeParse({
    built_at: now.toISOString(),
    records: records.sort(compareRecords),
  });
  if (!result.success) {
    throw new MergeError(
      'invalid_output',
      `the merge built an invalid latest.json: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

/**
 * The price overrides the scraper now agrees with: the record is `ok` from
 * the scraper at exactly the override's value, so the override can be
 * retired. The coverage report (E11.6-08) lists them.
 */
export function retirableOverrides(
  latest: LatestFile,
  overrides: ManualOverridesFile,
): PriceOverride[] {
  const records = new Map(
    latest.records.map((record) => [key(record), record]),
  );
  return overrides.overrides.filter((entry): entry is PriceOverride => {
    if (entry.kind !== 'price') {
      return false;
    }
    const record = records.get(key(entry));
    return (
      record !== undefined &&
      record.status === 'ok' &&
      record.source !== 'manual' &&
      record.price_local === entry.price_local &&
      record.currency === entry.currency
    );
  });
}
