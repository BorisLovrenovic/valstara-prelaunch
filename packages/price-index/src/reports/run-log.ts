import { valueText } from '../pipeline/notes.ts';
import { isPublishable } from '../publish/gate.ts';
import type { LatestFile } from '../schema/price-index-files.ts';
import {
  priceStatuses,
  recordIdentity,
  type PriceRecord,
  type PriceStatus,
} from '../schema/price-record.ts';
import {
  runLogFileSchema,
  runLogKeys,
  type RunLogFile,
  type RunObservationsFile,
} from '../schema/run-files.ts';

// The run's figures (E11.6-07): the counts `scrape` prints for its preview,
// and the run log `build-data` writes to reports/runs/<run_id>.json. Every
// figure is computed from two inputs only, the run's observations and the
// merged latest.json, so the preview and the final log count the same way.
//
// There is no "not modified" count: the fetcher makes no conditional
// request, so no page can answer "not modified" (E11.6-07 founder decision
// 1 of 2026-11-18). The changed count is the number of real price changes
// the build logs to changes.json (E11.6-09).

export type RunFigures = Pick<
  RunLogFile,
  'coverage_percent' | 'counts' | 'failed_markets' | 'failures'
>;

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** The records of `latest`, counted by status; every status is present. */
export function recordsByStatus(
  latest: LatestFile,
): Record<PriceStatus, number> {
  const counts = Object.fromEntries(
    priceStatuses.map((status) => [status, 0]),
  ) as Record<PriceStatus, number>;
  for (const record of latest.records) {
    counts[record.status] += 1;
  }
  return counts;
}

/**
 * Publishable records (the publish gate's `ok` and approved
 * `manual_override`) as a percentage of every record, floored to one
 * decimal so a nearly complete index never reads as 100%. An index with no
 * records covers 0%.
 */
export function coveragePercent(latest: LatestFile): number {
  const total = latest.records.length;
  if (total === 0) {
    return 0;
  }
  const publishable = latest.records.filter(isPublishable).length;
  return Math.floor((publishable * 1000) / total) / 10;
}

/**
 * The markets with at least one record whose page failed this run
 * (`parse_failed` or `market_failed`), each with how many of its records
 * did. Their previous values are kept by the merge. A market outside a
 * `--market` run is not failed: the run did not ask for it.
 */
export function failedMarkets(
  observations: RunObservationsFile,
): RunLogFile['failed_markets'] {
  const failed = new Map<string, number>();
  for (const gap of observations.gaps) {
    if (gap.reason === 'parse_failed' || gap.reason === 'market_failed') {
      failed.set(gap.market, (failed.get(gap.market) ?? 0) + 1);
    }
  }
  return [...failed]
    .sort(([a], [b]) => compareText(a, b))
    .map(([market, failedRecords]) => ({
      market,
      failed_records: failedRecords,
    }));
}

/**
 * Every figure of a run, against the latest.json it was merged into.
 * `changed` is the number of real changes the build logs (E11.6-09).
 */
export function runFigures(
  observations: RunObservationsFile,
  latest: LatestFile,
  changed: number,
): RunFigures {
  const failed = failedMarkets(observations);
  return {
    coverage_percent: coveragePercent(latest),
    counts: {
      fetched: observations.pages_fetched,
      matched: observations.observations.length,
      unmatched: observations.untracked.length,
      records_by_status: recordsByStatus(latest),
      failed_markets: failed.length,
      changed,
    },
    failed_markets: failed,
    failures: [...observations.failures].sort(
      (a, b) =>
        compareText(a.url, b.url) ||
        compareText(a.market ?? '', b.market ?? ''),
    ),
  };
}

/** The run log of one build: the run, the build and the figures. */
export function buildRunLog(input: {
  observations: RunObservationsFile;
  latest: LatestFile;
  snapshot: string;
  /** The real changes the build appended to changes.json. */
  changed: number;
}): RunLogFile {
  const { observations, latest } = input;
  return runLogFileSchema.parse({
    run_id: observations.run_id,
    source: observations.source,
    fetch_status: observations.fetch_status,
    market_scope: observations.market_scope,
    observed_at: observations.observed_at,
    built_at: latest.built_at,
    snapshot: input.snapshot,
    ...runFigures(observations, latest, input.changed),
  });
}

/**
 * The canonical bytes of a run log: keys in the schema's order, two-space
 * indentation and a trailing newline (epic rule 8). It holds no list of
 * plain values, so Prettier keeps the layout `JSON.stringify` writes.
 */
export function serialiseRunLog(log: RunLogFile): string {
  const parsed = runLogFileSchema.parse(log);
  const canonical = Object.fromEntries(
    runLogKeys.map((key) => [key, parsed[key]]),
  );
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function statusLine(record: PriceRecord): string {
  const reason =
    record.missing_reason === null ? '' : ` (${record.missing_reason})`;
  const value = record.price_local === null ? '' : ` ${valueText(record)}`;
  const source = record.price_local === null ? '' : ` from ${record.source}`;
  return `${record.status}${reason}${value}${source}`;
}

function sameSubstance(a: PriceRecord, b: PriceRecord): boolean {
  return (
    a.status === b.status &&
    a.price_local === b.price_local &&
    a.currency === b.currency &&
    a.source === b.source &&
    a.missing_reason === b.missing_reason
  );
}

/**
 * What a merge would change in latest.json, one line per record whose
 * status, value, currency, source or missing reason differs: `+` a new
 * record, `~` a changed one, `-` one that would leave. A refreshed
 * `observed_at` or note alone is not a change. Records in identity order.
 */
export function describeChanges(
  previous: LatestFile | null,
  next: LatestFile,
): string[] {
  const before = new Map(
    (previous?.records ?? []).map((record) => [recordIdentity(record), record]),
  );
  const after = new Map(
    next.records.map((record) => [recordIdentity(record), record]),
  );
  const identities = [...new Set([...before.keys(), ...after.keys()])].sort(
    compareText,
  );
  const lines: string[] = [];
  for (const identity of identities) {
    const old = before.get(identity);
    const now = after.get(identity);
    if (old === undefined && now !== undefined) {
      lines.push(`+ ${identity}: ${statusLine(now)}`);
    } else if (old !== undefined && now === undefined) {
      lines.push(`- ${identity}: ${statusLine(old)}, leaves latest.json`);
    } else if (old !== undefined && now !== undefined) {
      if (!sameSubstance(old, now)) {
        lines.push(`~ ${identity}: ${statusLine(old)} → ${statusLine(now)}`);
      }
    }
  }
  return lines;
}

/** The console summary every run-reading command ends with. */
export function formatSummary(input: {
  heading: string;
  marketScope: string | null;
  figures: RunFigures;
  reports: readonly string[];
}): string {
  const { counts, failed_markets: failed } = input.figures;
  const byStatus = priceStatuses
    .map((status) => `${status} ${counts.records_by_status[status]}`)
    .join(' · ');
  const total = Object.values(counts.records_by_status).reduce(
    (sum, value) => sum + value,
    0,
  );
  const publishable =
    counts.records_by_status.ok + counts.records_by_status.manual_override;
  const lines = [
    input.heading,
    `  Markets: ${input.marketScope ?? 'every enabled market'}`,
    `  Coverage: ${input.figures.coverage_percent}% (${publishable} of ${total} records publishable)`,
    `  Fetched ${counts.fetched} · matched ${counts.matched} · unmatched ${counts.unmatched} · changed ${counts.changed}`,
    `  Records by status: ${byStatus}`,
    `  Failed markets: ${
      failed.length === 0
        ? 'none'
        : failed
            .map((entry) => `${entry.market} (${entry.failed_records})`)
            .join(', ')
    }`,
  ];
  if (input.reports.length > 0) {
    lines.push('  Reports:', ...input.reports.map((path) => `    ${path}`));
  }
  return `${lines.join('\n')}\n`;
}
