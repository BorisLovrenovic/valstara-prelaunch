import { seededRandom } from '../http/random.ts';
import { isPublishable } from '../publish/gate.ts';
import { retirableOverrides } from '../pipeline/index.ts';
import type { CatalogueFile } from '../schema/catalogue.ts';
import {
  coverageReportFileSchema,
  coverageReportKeys,
  type CoverageReportFile,
  type CoverageReportKind,
} from '../schema/coverage-report.ts';
import type { ManualOverridesFile } from '../schema/manual-overrides.ts';
import type { MarketsFile } from '../schema/markets.ts';
import type { LatestFile } from '../schema/price-index-files.ts';
import {
  missingReasons,
  recordIdentity,
  type MissingReason,
  type PriceRecord,
  type PriceStatus,
} from '../schema/price-record.ts';
import type { RunObservationsFile } from '../schema/run-files.ts';
import { compareRecords } from '../storage/serialise.ts';

// The coverage report (E11.6-08, docs/features/price-index.md). One object
// is built from the merged index, the run's observations, the founder's
// manual entries and the configuration; the JSON file is that object, and
// the Markdown is rendered from it and nothing else, so both always carry
// the same figures. `scrape` writes it as a preview, `build-data` as the
// final report of the build, and `report` on demand.
//
// It is the founder's working list: the full matrix, the gaps ready for
// manual entry, every flag, the overrides that may be retired, the records
// that publish unranked, what the source lists that we do not track, and a
// reproducible sample of `ok` records to check by hand. It never shows a
// USD figure.

/** A missing combination's reasons, in the order the report groups them. */
export const missingReasonOrder: readonly MissingReason[] = [
  'not_on_source',
  ...missingReasons.filter((reason) => reason !== 'not_on_source'),
];

const flaggedStatuses = ['needs_review', 'conflict', 'stale'] as const;
type FlaggedStatus = (typeof flaggedStatuses)[number];

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Publishable records as a share of all, floored to one decimal (as the run log). */
export function coverageShare(publishable: number, records: number) {
  return {
    publishable,
    records,
    percent:
      records === 0 ? 0 : Math.floor((publishable * 1000) / records) / 10,
  };
}

/**
 * The spot-check seed of a run: FNV-1a over the run id's characters, so the
 * same run id always draws the same sample (epic rule 9: seeded, never
 * fresh).
 */
export function spotCheckSeed(runId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < runId.length; index += 1) {
    hash ^= runId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * `count` of `records` drawn without replacement by a source seeded with
 * `seed` (a partial Fisher–Yates shuffle over the records in identity
 * order), returned in identity order. All of them when there are fewer.
 */
export function sampleRecords(
  records: readonly PriceRecord[],
  seed: number,
  count: number,
): PriceRecord[] {
  const pool = [...records].sort(compareRecords);
  const random = seededRandom(seed);
  const take = Math.min(count, pool.length);
  for (let index = 0; index < take; index += 1) {
    const pick = index + Math.floor(random() * (pool.length - index));
    [pool[index], pool[pick]] = [pool[pick]!, pool[index]!];
  }
  return pool.slice(0, take).sort(compareRecords);
}

export interface CoverageReportInput {
  kind: CoverageReportKind;
  observations: RunObservationsFile;
  /** The merged index the report is about: a preview, or the build's latest.json. */
  latest: LatestFile;
  overrides: ManualOverridesFile;
  catalogue: CatalogueFile;
  markets: MarketsFile;
  /** How many `ok` records to sample (`reports.spot_checks`). */
  spotChecks: number;
}

/** The coverage report of one merged index, validated against its schema. */
export function buildCoverageReport(
  input: CoverageReportInput,
): CoverageReportFile {
  const { latest, catalogue, observations } = input;
  const enabled = input.markets.markets.filter((market) => market.enabled);
  const enabledCodes = new Set(enabled.map((market) => market.code));
  const currencyOf = new Map(
    enabled.map((market) => [market.code, market.currency]),
  );
  const byIdentity = new Map(
    latest.records.map((record) => [recordIdentity(record), record]),
  );
  const services = [...catalogue.services].sort((a, b) =>
    compareText(a.service_id, b.service_id),
  );

  // The matrix: exactly one cell per enabled market × catalogue plan. The
  // merge guarantees a record for each, so a gap here is a broken index.
  const matrix = services.flatMap((service) =>
    [...service.plans]
      .sort((a, b) => compareText(a.plan_id, b.plan_id))
      .map((plan) => ({
        service_id: service.service_id,
        plan_id: plan.plan_id,
        billing_period: plan.billing_period,
        cells: enabled.map((market) => {
          const identity = recordIdentity({
            market: market.code,
            service_id: service.service_id,
            plan_id: plan.plan_id,
            billing_period: plan.billing_period,
          });
          const record = byIdentity.get(identity);
          if (record === undefined) {
            throw new Error(`the merged index has no record for ${identity}`);
          }
          return {
            market: market.code,
            status: record.status,
            missing_reason: record.missing_reason,
          };
        }),
      })),
  );
  const matrixRecords = matrix.flatMap((row) =>
    row.cells.map((cell) =>
      byIdentity.get(
        recordIdentity({
          market: cell.market,
          service_id: row.service_id,
          plan_id: row.plan_id,
          billing_period: row.billing_period,
        }),
      )!,
    ),
  );
  const tracked = [...matrixRecords].sort(compareRecords);

  const share = (records: readonly PriceRecord[]) =>
    coverageShare(records.filter(isPublishable).length, records.length);

  const missing = missingReasonOrder.flatMap((reason) =>
    services.flatMap((service) => {
      const combinations = tracked
        .filter(
          (record) =>
            record.service_id === service.service_id &&
            record.status === 'missing' &&
            record.missing_reason === reason,
        )
        .map((record) => ({
          market: record.market,
          currency: currencyOf.get(record.market)!,
          plan_id: record.plan_id,
          billing_period: record.billing_period,
        }));
      return combinations.length === 0
        ? []
        : [
            {
              reason,
              service_id: service.service_id,
              service_name: service.name,
              website_url: service.website_url,
              combinations,
            },
          ];
    }),
  );

  const manualFor = new Map(
    input.overrides.overrides.map((entry) => [recordIdentity(entry), entry]),
  );
  const flagged = flaggedStatuses.flatMap((status) =>
    tracked
      .filter((record) => record.status === status)
      .map((record) => {
        const entry = manualFor.get(recordIdentity(record));
        return {
          market: record.market,
          service_id: record.service_id,
          plan_id: record.plan_id,
          billing_period: record.billing_period,
          status: status as FlaggedStatus,
          shown:
            record.price_local === null || record.currency === null
              ? null
              : {
                  price_local: record.price_local,
                  currency: record.currency,
                  source: record.source ?? 'unknown',
                },
          manual:
            entry === undefined
              ? null
              : {
                  kind: entry.kind,
                  price_local:
                    entry.kind === 'price' ? entry.price_local : null,
                  currency: entry.kind === 'price' ? entry.currency : null,
                  verified_at: entry.verified_at,
                  source_url: entry.source_url,
                },
          notes: record.notes,
        };
      }),
  );

  const retirable = retirableOverrides(latest, input.overrides)
    .filter((entry) => enabledCodes.has(entry.market))
    .map((entry) => ({
      market: entry.market,
      service_id: entry.service_id,
      plan_id: entry.plan_id,
      billing_period: entry.billing_period,
      price_local: entry.price_local,
      currency: entry.currency,
    }))
    .sort(
      (a, b) =>
        compareText(a.service_id, b.service_id) ||
        compareText(a.plan_id, b.plan_id) ||
        compareText(a.billing_period, b.billing_period) ||
        compareText(a.market, b.market),
    );

  const unranked = tracked
    .filter(
      (record) => isPublishable(record) && record.price_usd_source === null,
    )
    .map((record) => ({
      market: record.market,
      service_id: record.service_id,
      plan_id: record.plan_id,
      billing_period: record.billing_period,
      price_local: record.price_local!,
      currency: record.currency!,
      source: record.source ?? 'unknown',
    }));

  const untracked = observations.untracked.map((entry) =>
    entry.kind === 'service'
      ? {
          kind: 'service' as const,
          service_id: null,
          source_service: entry.source_service,
          source_plan: null,
          source_name: entry.source_name,
          billing_period: null,
          markets: [],
          suggestion: entry.suggestion?.service_id ?? null,
        }
      : {
          kind: 'plan' as const,
          service_id: entry.service_id,
          source_service: entry.source_service,
          source_plan: entry.source_plan,
          source_name: entry.source_name,
          billing_period: entry.billing_period,
          markets: [...entry.markets],
          suggestion: entry.suggestion?.plan_id ?? null,
        },
  );

  const websiteOf = new Map(
    services.map((service) => [service.service_id, service.website_url]),
  );
  const seed = spotCheckSeed(observations.run_id);
  const spotRecords = sampleRecords(
    tracked.filter((record) => record.status === 'ok'),
    seed,
    input.spotChecks,
  ).map((record) => ({
    market: record.market,
    service_id: record.service_id,
    plan_id: record.plan_id,
    billing_period: record.billing_period,
    price_local: record.price_local!,
    currency: record.currency!,
    price_source_text: record.price_source_text,
    source_url: record.source_url,
    official_url: websiteOf.get(record.service_id)!,
  }));

  return coverageReportFileSchema.parse({
    kind: input.kind,
    run_id: observations.run_id,
    source: observations.source,
    fetch_status: observations.fetch_status,
    market_scope: observations.market_scope,
    built_at: latest.built_at,
    markets: enabled.map((market) => market.code),
    coverage: {
      overall: share(tracked),
      by_market: enabled.map((market) => ({
        market: market.code,
        ...share(tracked.filter((record) => record.market === market.code)),
      })),
      by_service: services.map((service) => ({
        service_id: service.service_id,
        ...share(
          tracked.filter((record) => record.service_id === service.service_id),
        ),
      })),
    },
    matrix,
    missing,
    flagged,
    retirable_overrides: retirable,
    unranked,
    untracked,
    spot_checks: {
      requested: input.spotChecks,
      seed,
      records: spotRecords,
    },
  });
}

/** `coverage-2026-11-18`: the report's file name without its extension. */
export function coverageReportBaseName(report: CoverageReportFile): string {
  return `coverage-${report.built_at.slice(0, 10)}`;
}

/** Prettier's line width, which a list of plain values must fit to stay on one line. */
const printWidth = 80;

function isPlain(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

/**
 * JSON as Prettier writes it: two-space indentation, every non-empty object
 * expanded, and a list of plain values on one line when that line fits
 * within 80 columns, one value a line otherwise.
 */
function prettierJson(
  value: unknown,
  indent: string,
  prefix: string,
  suffix: string,
): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    if (value.every(isPlain)) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
      if (prefix.length + inline.length + suffix.length <= printWidth) {
        return inline;
      }
    }
    const items = value.map(
      (item, index) =>
        `${inner}${prettierJson(item, inner, inner, index < value.length - 1 ? ',' : '')}`,
    );
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return '{}';
    }
    const lines = entries.map(([key, item], index) => {
      const head = `${inner}${JSON.stringify(key)}: `;
      return `${head}${prettierJson(item, inner, head, index < entries.length - 1 ? ',' : '')}`;
    });
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/**
 * The canonical bytes of the JSON report: keys in the schema's order, in
 * Prettier's JSON layout with a trailing newline (epic rule 8).
 */
export function serialiseCoverageReport(report: CoverageReportFile): string {
  const parsed = coverageReportFileSchema.parse(report);
  const canonical = Object.fromEntries(
    coverageReportKeys.map((key) => [key, parsed[key]]),
  );
  return `${prettierJson(canonical, '', '', '')}\n`;
}

// ---------------------------------------------------------------------------
// The Markdown, rendered from the report object alone.

/** The matrix's cell codes, one per status and missing reason. */
export const cellCodes: Readonly<
  Record<Exclude<PriceStatus, 'missing'> | `missing:${MissingReason}`, string>
> = {
  ok: 'ok',
  manual_override: 'mo',
  needs_review: 'nr',
  conflict: 'cf',
  stale: 'st',
  not_offered: 'no',
  'missing:not_on_source': 'm-nos',
  'missing:source_no_price': 'm-snp',
  'missing:parse_failed': 'm-pf',
  'missing:market_failed': 'm-mf',
};

export function cellCode(cell: {
  status: PriceStatus;
  missing_reason: MissingReason | null;
}): string {
  return cell.status === 'missing'
    ? cellCodes[`missing:${cell.missing_reason ?? 'not_on_source'}`]
    : cellCodes[cell.status];
}

/**
 * Free text (a note, a source's name) made literal in Markdown: every
 * character Markdown could read as syntax is escaped, and Prettier keeps
 * the escapes as written.
 */
export function markdownText(value: string): string {
  return value
    .replace(/[\\`*_[\]<>|#~]/gu, '\\$&')
    .replace(/^(\d+)([.)])/u, '$1\\$2')
    .replace(/^([-+=])/u, '\\$1');
}

function code(value: string): string {
  return `\`${value.replaceAll('`', "'")}\``;
}

function link(url: string): string {
  return `<${url.replace(/[<>\s]/gu, encodeURIComponent)}>`;
}

/** A table padded the way Prettier pads one: every column to its widest cell, at least 3. */
function table(header: readonly string[], rows: readonly string[][]): string {
  const widths = header.map((title, column) =>
    Math.max(3, title.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(' | ')} |`;
  return [
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
  ].join('\n');
}

function identityText(entry: {
  market: string;
  service_id: string;
  plan_id: string;
  billing_period: string;
}): string {
  return `${code(entry.market)} ${code(entry.service_id)} ${code(entry.plan_id)} (${entry.billing_period})`;
}

function section(title: string, body: readonly string[]): string[] {
  return [`## ${title}`, '', ...(body.length === 0 ? ['None.'] : body), ''];
}

/** One blank line between blocks, never two, as Prettier writes Markdown. */
function tidy(lines: readonly string[]): string {
  return `${lines
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd()}\n`;
}

function percentText(figure: { percent: number }): string {
  return `${figure.percent}%`;
}

/** The Markdown report: the same figures as the JSON, for reading. */
export function renderCoverageMarkdown(report: CoverageReportFile): string {
  const { coverage } = report;
  const lines: string[] = [];
  lines.push(
    `# Coverage report ${report.built_at.slice(0, 10)} (${report.kind})`,
    '',
    `Run ${code(report.run_id)} from ${code(report.source)}: fetch ${code(report.fetch_status)}, markets ${report.market_scope === null ? 'all enabled' : code(report.market_scope)}. Merged at ${code(report.built_at)}.`,
    '',
    report.kind === 'preview'
      ? 'This is a preview: what `build-data` would write now. Nothing in `data/price-index/` has changed.'
      : 'This is the final report of the build that wrote `data/price-index/latest.json`.',
    '',
  );

  lines.push(
    ...section('Coverage', [
      `Overall: ${coverage.overall.publishable} of ${coverage.overall.records} records publishable (${percentText(coverage.overall)}).`,
      '',
      '### By market',
      '',
      table(
        ['Market', 'Publishable', 'Records', 'Coverage'],
        coverage.by_market.map((row) => [
          row.market,
          String(row.publishable),
          String(row.records),
          percentText(row),
        ]),
      ),
      '',
      '### By service',
      '',
      table(
        ['Service', 'Publishable', 'Records', 'Coverage'],
        coverage.by_service.map((row) => [
          row.service_id,
          String(row.publishable),
          String(row.records),
          percentText(row),
        ]),
      ),
    ]),
  );

  const legend = Object.entries(cellCodes)
    .map(([status, short]) => `${code(short)} ${code(status)}`)
    .join(', ');
  lines.push(
    ...section(
      'Matrix',
      report.matrix.length === 0 || report.markets.length === 0
        ? []
        : [
            `One cell per enabled market and catalogue plan: ${legend}.`,
            '',
            table(
              ['Plan', ...report.markets],
              report.matrix.map((row) => [
                `${row.service_id}/${row.plan_id}/${row.billing_period}`,
                ...row.cells.map(cellCode),
              ]),
            ),
          ],
    ),
  );

  lines.push(
    ...section(
      'Missing, for manual entry',
      report.missing.flatMap((group) => [
        `### ${code(group.reason)}: ${markdownText(group.service_name)} (${code(group.service_id)})`,
        '',
        `Official site: ${link(group.website_url)}`,
        '',
        ...group.combinations.map(
          (entry) =>
            `- ${code(entry.market)} ${code(entry.plan_id)} (${entry.billing_period}), in ${code(entry.currency)}`,
        ),
        '',
      ]),
    ),
  );

  lines.push(
    ...section(
      'Flagged: needs_review, conflict and stale',
      report.flagged.flatMap((entry) => {
        const shown =
          entry.shown === null
            ? 'shows no price'
            : `shows ${code(`${entry.shown.price_local} ${entry.shown.currency}`)} from ${code(entry.shown.source)}`;
        const manual =
          entry.manual === null
            ? ''
            : entry.manual.kind === 'price'
              ? `; manual entry ${code(`${entry.manual.price_local} ${entry.manual.currency}`)}, verified ${entry.manual.verified_at} (${link(entry.manual.source_url)})`
              : `; manual entry: not offered, verified ${entry.manual.verified_at} (${link(entry.manual.source_url)})`;
        return [
          `- ${identityText(entry)}: **${entry.status}**, ${shown}${manual}`,
          ...(entry.notes ?? '')
            .split('\n')
            .filter((note) => note.trim().length > 0)
            .map((note) => `  - ${markdownText(note.trim())}`),
        ];
      }),
    ),
  );

  lines.push(
    ...section(
      'Retirable overrides',
      report.retirable_overrides.map(
        (entry) =>
          `- ${identityText(entry)}: the scraper now agrees at ${code(`${entry.price_local} ${entry.currency}`)}`,
      ),
    ),
  );

  lines.push(
    ...section(
      'Publishable without a USD figure (never ranked)',
      report.unranked.map(
        (entry) =>
          `- ${identityText(entry)}: ${code(`${entry.price_local} ${entry.currency}`)} from ${code(entry.source)}`,
      ),
    ),
  );

  lines.push(
    ...section(
      'Untracked on source',
      report.untracked.map((entry) => {
        const what =
          entry.kind === 'service'
            ? `service ${code(entry.source_service)}`
            : `plan ${code(entry.source_plan ?? '')} of ${code(entry.source_service)} (${entry.billing_period}) for ${code(entry.service_id ?? '')}`;
        const where =
          entry.markets.length === 0
            ? ''
            : ` in ${entry.markets.map(code).join(', ')}`;
        const suggestion =
          entry.suggestion === null
            ? 'no suggestion'
            : `suggestion ${code(entry.suggestion)}, not applied`;
        return `- ${what} "${markdownText(entry.source_name)}"${where}: ${suggestion}`;
      }),
    ),
  );

  const spot = report.spot_checks;
  lines.push(
    ...section('Spot checks', [
      `${spot.records.length} of ${spot.requested} requested \`ok\` records, sampled with seed ${spot.seed} from the run id. Check each against the provider's own page.`,
      '',
      ...spot.records.map(
        (entry) =>
          `- ${identityText(entry)}: ${code(`${entry.price_local} ${entry.currency}`)}${entry.price_source_text === null ? '' : ` shown as ${code(entry.price_source_text)}`}; official ${link(entry.official_url)}${entry.source_url === null ? '' : `; read from ${link(entry.source_url)}`}`,
      ),
    ]),
  );

  return tidy(lines);
}
