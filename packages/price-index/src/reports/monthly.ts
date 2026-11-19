import { monthlyReportCopy as copy } from '../../copy/monthly-report.ts';
import { fromDecimalString } from '../money/money.ts';
import { compareChangeSize } from '../pipeline/changes.ts';
import { isPublishable, rankMarkets } from '../publish/gate.ts';
import type { CatalogueFile } from '../schema/catalogue.ts';
import type { ChangeEntry } from '../schema/changes.ts';
import type { MarketsFile } from '../schema/markets.ts';
import {
  monthlyReportFileSchema,
  monthlyReportKeys,
  type MonthlyChange,
  type MonthlyPlan,
  type MonthlyReportFile,
} from '../schema/monthly-report.ts';
import type { LatestFile } from '../schema/price-index-files.ts';
import { recordIdentity, type PriceRecord } from '../schema/price-record.ts';
import type { RunObservationsFile } from '../schema/run-files.ts';
import { markdownText, prettierJson, table, tidy } from './coverage.ts';

// The monthly report (E11.6-09): `price-index monthly-report --month
// YYYY-MM` writes data/price-index/monthly/YYYY-MM.json for the page and
// reports/monthly/YYYY-MM.md for outreach. Both are built from published
// values only:
//
// - the month's changes come from changes.json, which holds only published
//   values, and a change counts only while its record still passes the
//   publish gate in the month's last snapshot;
// - the extremes and spread come from `rankMarkets()` over that snapshot,
//   shown in local prices. The ranking's USD figure orders the markets and
//   gives the spread's ratio, and is never written;
// - the counts are of published markets.
//
// The Markdown also carries the founder-only cross-check against the
// source's "Price moves". It is computed here, written to the Markdown only,
// never to the JSON, and changes no value.

type PriceMove = NonNullable<RunObservationsFile['price_moves']>[number];

/** The source's period codes, as the catalogue's billing periods. */
const movePeriods: Readonly<Record<string, PriceRecord['billing_period']>> = {
  m: 'month',
  y: 'year',
};

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** A two-decimal USD figure in cents. The schema has checked its form. */
function usdCents(value: string): bigint {
  return BigInt(value.replace('.', ''));
}

/** `a / b` with one decimal, rounded half up, as text. */
function ratioText(a: bigint, b: bigint): string {
  const tenths = (a * 20n + b) / (2n * b);
  return `${tenths / 10n}.${tenths % 10n}`;
}

function inMonth(date: string, month: string): boolean {
  return date.startsWith(`${month}-`);
}

interface PlanKey {
  service_id: string;
  plan_id: string;
  billing_period: PriceRecord['billing_period'];
}

function catalogueKeys(catalogue: CatalogueFile): PlanKey[] {
  return catalogue.services
    .flatMap((service) =>
      service.plans.map((plan) => ({
        service_id: service.service_id,
        plan_id: plan.plan_id,
        billing_period: plan.billing_period,
      })),
    )
    .sort(
      (a, b) =>
        compareText(a.service_id, b.service_id) ||
        compareText(a.plan_id, b.plan_id) ||
        compareText(a.billing_period, b.billing_period),
    );
}

function planKeyOf(entry: PlanKey): string {
  return `${entry.service_id}\u0000${entry.plan_id}\u0000${entry.billing_period}`;
}

export interface MonthlyReportInput {
  month: string;
  /** The month's last snapshot, by name. */
  snapshot: { name: string; file: LatestFile };
  /** The whole change log, in append order. */
  changes: readonly ChangeEntry[];
  catalogue: CatalogueFile;
  markets: MarketsFile;
}

/**
 * The published records of the snapshot that the report may count: those
 * the publish gate passes, for an enabled market and a catalogue plan.
 */
function countableRecords(input: MonthlyReportInput): Map<string, PriceRecord> {
  const enabled = new Set(
    input.markets.markets
      .filter((market) => market.enabled)
      .map((market) => market.code),
  );
  const plans = new Set(catalogueKeys(input.catalogue).map(planKeyOf));
  return new Map(
    input.snapshot.file.records
      .filter(
        (record) =>
          isPublishable(record) &&
          enabled.has(record.market) &&
          plans.has(planKeyOf(record)),
      )
      .map((record) => [recordIdentity(record), record]),
  );
}

/** The month's changes whose records the gate still passes, in log order. */
function monthChanges(
  input: MonthlyReportInput,
  countable: ReadonlyMap<string, PriceRecord>,
): ChangeEntry[] {
  return input.changes.filter(
    (entry) =>
      inMonth(entry.detected_on, input.month) &&
      countable.has(recordIdentity(entry)),
  );
}

/** The report's figures: the monthly JSON, before serialisation. */
export function buildMonthlyReport(
  input: MonthlyReportInput,
): MonthlyReportFile {
  const countable = countableRecords(input);
  const changes = monthChanges(input, countable);
  const enabled = new Set(
    input.markets.markets
      .filter((market) => market.enabled)
      .map((market) => market.code),
  );

  const plans: MonthlyPlan[] = [];
  for (const key of catalogueKeys(input.catalogue)) {
    const published = [...countable.values()].filter(
      (record) => planKeyOf(record) === planKeyOf(key),
    );
    if (published.length === 0) {
      continue;
    }
    const ranked = rankMarkets(input.snapshot.file, key).filter((entry) =>
      enabled.has(entry.market),
    );
    let mostExpensive: MonthlyPlan['most_expensive'] = null;
    let leastExpensive: MonthlyPlan['least_expensive'] = null;
    let spread: string | null = null;
    if (ranked.length >= 2) {
      const top = ranked[0]!;
      const lowestRank = ranked.at(-1)!.rank;
      const bottom = ranked.find((entry) => entry.rank === lowestRank)!;
      mostExpensive = {
        market: top.market,
        price_local: top.record.price_local,
        currency: top.record.currency,
      };
      leastExpensive = {
        market: bottom.market,
        price_local: bottom.record.price_local,
        currency: bottom.record.currency,
      };
      const usd = (market: string) =>
        usdCents(
          countable.get(recordIdentity({ ...key, market }))!
            .price_usd_source as string,
        );
      const low = usd(bottom.market);
      spread = low > 0n ? ratioText(usd(top.market), low) : null;
    }
    let rose = 0;
    let fell = 0;
    for (const record of published) {
      const own = changes.filter(
        (entry) => recordIdentity(entry) === recordIdentity(record),
      );
      if (own.length === 0) {
        continue;
      }
      const first = fromDecimalString(
        own[0]!.old_price_local,
        own[0]!.currency,
      ).minor;
      const last = fromDecimalString(
        own.at(-1)!.new_price_local,
        own.at(-1)!.currency,
      ).minor;
      if (last > first) {
        rose += 1;
      } else if (last < first) {
        fell += 1;
      }
    }
    plans.push({
      ...key,
      published_markets: published.length,
      ranked_markets: ranked.length,
      most_expensive: mostExpensive,
      least_expensive: leastExpensive,
      spread_ratio: spread,
      rose_in: rose,
      fell_in: fell,
    });
  }

  return monthlyReportFileSchema.parse({
    month: input.month,
    snapshot: input.snapshot.name,
    built_at: input.snapshot.file.built_at,
    markets: enabled.size,
    changes: [...changes]
      .sort(compareChangeSize)
      .map((entry): MonthlyChange => ({
        market: entry.market,
        service_id: entry.service_id,
        plan_id: entry.plan_id,
        billing_period: entry.billing_period,
        old_price_local: entry.old_price_local,
        new_price_local: entry.new_price_local,
        currency: entry.currency,
        change_percent: entry.change_percent,
        detected_on: entry.detected_on,
      })),
    plans,
  });
}

/**
 * The canonical bytes of the monthly JSON: keys in the schema's order, in
 * Prettier's JSON layout with a trailing newline (epic rule 8).
 */
export function serialiseMonthlyReport(report: MonthlyReportFile): string {
  const parsed = monthlyReportFileSchema.parse(report);
  const canonical = Object.fromEntries(
    monthlyReportKeys.map((key) => [key, parsed[key]]),
  );
  return `${prettierJson(canonical, '', '', '')}\n`;
}

// ---------------------------------------------------------------------------
// The founder-only cross-check.

export interface CrossCheckInput {
  month: string;
  /** The runs built this month, each with its price moves, or null when the raw store no longer holds them. */
  runs: readonly { runId: string; priceMoves: readonly PriceMove[] | null }[];
  /** The whole change log, in append order. */
  changes: readonly ChangeEntry[];
  catalogue: CatalogueFile;
  markets: MarketsFile;
}

export interface CrossCheck {
  /** Runs whose price moves were read. */
  readRuns: string[];
  /** Runs built this month whose price moves are gone or were never read. */
  missingRuns: string[];
  /** The source's moves dated this month, for a tracked plan in an enabled market, that the log does not hold. */
  undetected: PriceMove[];
  /** The log's changes this month that no move the source lists matches. */
  unlisted: ChangeEntry[];
}

function moveMatches(move: PriceMove, entry: ChangeEntry): boolean {
  return (
    move.market === entry.market &&
    move.service_id === entry.service_id &&
    move.plan_id === entry.plan_id &&
    movePeriods[move.period] === entry.billing_period &&
    move.currency === entry.currency &&
    move.old_price === entry.old_price_local &&
    move.new_price === entry.new_price_local
  );
}

/**
 * Both kinds of disagreement between our change log and the source's
 * "Price moves". A move and a change agree when they name the same market,
 * plan, billing period, currency, old price and new price; their dates may
 * differ, because the source dates a move when it saw it and we date a
 * change by our own observation. It reads no file and changes nothing.
 */
export function crossCheckPriceMoves(input: CrossCheckInput): CrossCheck {
  const readRuns = input.runs
    .filter((run) => run.priceMoves !== null)
    .map((run) => run.runId);
  const missingRuns = input.runs
    .filter((run) => run.priceMoves === null)
    .map((run) => run.runId);
  const seen = new Set<string>();
  const moves: PriceMove[] = [];
  for (const run of input.runs) {
    for (const move of run.priceMoves ?? []) {
      const key = JSON.stringify([
        move.market,
        move.source_service,
        move.source_plan,
        move.period,
        move.currency,
        move.old_price,
        move.new_price,
        move.date,
      ]);
      if (!seen.has(key)) {
        seen.add(key);
        moves.push(move);
      }
    }
  }
  const enabled = new Set(
    input.markets.markets
      .filter((market) => market.enabled)
      .map((market) => market.code),
  );
  const plans = new Set(catalogueKeys(input.catalogue).map(planKeyOf));
  const tracked = moves.filter((move) => {
    const period = movePeriods[move.period];
    return (
      move.service_id !== null &&
      move.plan_id !== null &&
      period !== undefined &&
      enabled.has(move.market) &&
      plans.has(
        planKeyOf({
          service_id: move.service_id,
          plan_id: move.plan_id,
          billing_period: period,
        }),
      )
    );
  });
  const undetected = tracked
    .filter(
      (move) =>
        inMonth(move.date, input.month) &&
        !input.changes.some((entry) => moveMatches(move, entry)),
    )
    .sort(
      (a, b) =>
        compareText(a.service_id ?? '', b.service_id ?? '') ||
        compareText(a.plan_id ?? '', b.plan_id ?? '') ||
        compareText(a.market, b.market) ||
        compareText(a.date, b.date),
    );
  const unlisted = input.changes
    .filter(
      (entry) =>
        inMonth(entry.detected_on, input.month) &&
        !moves.some((move) => moveMatches(move, entry)),
    )
    .sort(compareChangeSize);
  return { readRuns, missingRuns, undetected, unlisted };
}

// ---------------------------------------------------------------------------
// The Markdown.

export interface MonthlyMarkdownNames {
  catalogue: CatalogueFile;
  markets: MarketsFile;
}

function namer(names: MonthlyMarkdownNames) {
  const marketNames = new Map(
    names.markets.markets.map((market) => [market.code, market.name]),
  );
  const services = new Map(
    names.catalogue.services.map((service) => [service.service_id, service]),
  );
  return {
    market: (code: string) => markdownText(marketNames.get(code) ?? code),
    plan(serviceId: string, planId: string) {
      const service = services.get(serviceId);
      const plan = service?.plans.find((entry) => entry.plan_id === planId);
      return markdownText(
        copy.plan(service?.name ?? serviceId, plan?.name ?? planId),
      );
    },
  };
}

function section(title: string, body: readonly string[]): string[] {
  return [`## ${title}`, '', ...body, ''];
}

/**
 * The outreach Markdown, from the report's figures, the catalogue's and the
 * markets' names, and the cross-check, which goes only here.
 */
export function renderMonthlyMarkdown(
  report: MonthlyReportFile,
  names: MonthlyMarkdownNames,
  crossCheck: CrossCheck,
): string {
  const name = namer(names);
  const monthName = copy.monthName(report.month);
  const lines: string[] = [
    `# ${copy.title(monthName)}`,
    '',
    copy.introduction(
      report.markets,
      copy.dayName(report.built_at.slice(0, 10)),
    ),
    '',
  ];

  lines.push(
    ...section(
      copy.changesHeading,
      report.changes.length === 0
        ? [copy.noChanges(monthName)]
        : [
            table(
              copy.changesColumns,
              report.changes.map((entry) => [
                name.plan(entry.service_id, entry.plan_id),
                name.market(entry.market),
                copy.price(entry.old_price_local, entry.currency),
                copy.price(entry.new_price_local, entry.currency),
                copy.percent(entry.change_percent),
              ]),
            ),
          ],
    ),
  );

  const direction = report.plans.flatMap((plan) => {
    const label = name.plan(plan.service_id, plan.plan_id);
    return [
      ...(plan.rose_in > 0
        ? [`- ${copy.rose(label, plan.rose_in, plan.published_markets)}`]
        : []),
      ...(plan.fell_in > 0
        ? [`- ${copy.fell(label, plan.fell_in, plan.published_markets)}`]
        : []),
    ];
  });
  lines.push(
    ...section(
      copy.directionHeading,
      direction.length === 0 ? [copy.noDirection] : direction,
    ),
  );

  const ranked = report.plans.filter(
    (plan) => plan.most_expensive !== null && plan.least_expensive !== null,
  );
  const unranked = report.plans.length - ranked.length;
  lines.push(
    ...section(copy.extremesHeading, [
      ...(ranked.length === 0
        ? [copy.noExtremes]
        : [
            copy.extremesBasis,
            '',
            ...ranked.map((plan) => {
              const most = plan.most_expensive!;
              const least = plan.least_expensive!;
              const sentence = copy.extremes(
                name.plan(plan.service_id, plan.plan_id),
                {
                  market: name.market(most.market),
                  price: copy.price(most.price_local, most.currency),
                },
                {
                  market: name.market(least.market),
                  price: copy.price(least.price_local, least.currency),
                },
              );
              return plan.spread_ratio === null
                ? `- ${sentence}`
                : `- ${sentence} ${copy.spread(plan.spread_ratio)}`;
            }),
          ]),
      ...(unranked > 0 && ranked.length > 0
        ? ['', copy.unranked(unranked)]
        : []),
    ]),
  );

  const crossCheckBody: string[] = [copy.crossCheckNotice, ''];
  if (crossCheck.readRuns.length === 0) {
    crossCheckBody.push(copy.crossCheckUnavailable);
  } else {
    crossCheckBody.push(copy.crossCheckRuns(crossCheck.readRuns.join(', ')));
    if (crossCheck.missingRuns.length > 0) {
      crossCheckBody.push(
        '',
        copy.crossCheckMissingRuns(crossCheck.missingRuns.join(', ')),
      );
    }
    crossCheckBody.push(
      '',
      `### ${copy.undetectedHeading}`,
      '',
      ...(crossCheck.undetected.length === 0
        ? [copy.none]
        : crossCheck.undetected.map(
            (move) =>
              `- ${copy.move(
                name.plan(move.service_id ?? '', move.plan_id ?? ''),
                name.market(move.market),
                copy.price(move.old_price, move.currency),
                copy.price(move.new_price, move.currency),
                move.date,
              )}`,
          )),
      '',
      `### ${copy.unlistedHeading}`,
      '',
      ...(crossCheck.unlisted.length === 0
        ? [copy.none]
        : crossCheck.unlisted.map(
            (entry) =>
              `- ${copy.change(
                name.plan(entry.service_id, entry.plan_id),
                name.market(entry.market),
                copy.price(entry.old_price_local, entry.currency),
                copy.price(entry.new_price_local, entry.currency),
                entry.detected_on,
              )}`,
          )),
    );
  }
  lines.push(...section(copy.crossCheckHeading, crossCheckBody));
  return tidy(lines);
}
