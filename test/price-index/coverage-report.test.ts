import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';

import { mergePriceIndex } from '../../packages/price-index/src/pipeline/index.ts';
import {
  buildCoverageReport,
  cellCodes,
  coverageReportBaseName,
  coveragePercent,
  renderCoverageMarkdown,
  sampleRecords,
  serialiseCoverageReport,
  spotCheckSeed,
  type CoverageReportInput,
} from '../../packages/price-index/src/reports/index.ts';
import {
  coverageReportFileSchema,
  priceIndexSettingsFileSchema,
  reportSettingsSchema,
  type CatalogueFile,
  type CoverageReportFile,
  type LatestFile,
  type ManualOverridesFile,
  type MarketsFile,
  type PriceRecord,
  type RunObservationsFile,
} from '../../packages/price-index/src/schema/index.ts';
import {
  clockAt,
  gap,
  notOffered,
  observation,
  priceOverride,
  record,
  run,
  settings,
} from '../helpers/price-index-merge.ts';

// E11.6-08: the coverage report. One object, built from the merged index,
// the run's observations, the founder's manual entries and the
// configuration, is written as JSON and rendered as Markdown. Every fixture
// is explicit; nothing is generated from the report's own output.

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const runId = '20261118T093000Z';
const builtAt = '2026-11-18T12:00:00.000Z';
const manual = 'manual';
// FNV-1a of the run id, computed outside the tool, and the five records it draws.
const PINNED_SEED = 1858124318;
const PINNED_SAMPLE = [
  'SE/netflix/standard',
  'SJ/netflix/standard',
  'SB/spotify/individual',
  'SG/spotify/individual',
  'SH/spotify/individual',
];

function plan(plan_id: string, name: string) {
  return {
    plan_id,
    name,
    billing_period: 'month' as const,
    is_student: false,
    is_family: false,
  };
}

/** Spotify (one plan), Netflix (three) and Lovable (one, not on the source). */
function catalogue(): CatalogueFile {
  return {
    services: [
      {
        service_id: 'spotify',
        name: 'Spotify Premium',
        category: 'music',
        website_url: 'https://www.spotify.com/',
        status: 'launch',
        plans: [plan('individual', 'Individual')],
        source_aliases: { service: ['Spotify'], plans: {} },
      },
      {
        service_id: 'netflix',
        name: 'Netflix',
        category: 'streaming',
        website_url: 'https://www.netflix.com/',
        status: 'launch',
        plans: [
          plan('basic', 'Basic'),
          plan('standard', 'Standard'),
          plan('premium', 'Premium (4K)'),
        ],
        source_aliases: { service: ['Netflix'], plans: {} },
      },
      {
        service_id: 'lovable',
        name: 'Lovable',
        category: 'ai',
        website_url: 'https://lovable.dev/',
        status: 'launch',
        plans: [plan('pro', 'Pro')],
        source_aliases: { service: [], plans: {} },
      },
    ],
  };
}

/** Sweden and the United States enabled; Germany disabled. */
function markets(): MarketsFile {
  return {
    markets: [
      {
        code: 'SE',
        name: 'Sweden',
        slug: 'sweden',
        currency: 'SEK',
        enabled: true,
      },
      {
        code: 'DE',
        name: 'Germany',
        slug: 'germany',
        currency: 'EUR',
        enabled: false,
      },
      {
        code: 'US',
        name: 'United States',
        slug: 'united-states',
        currency: 'USD',
        enabled: true,
      },
    ],
  };
}

const unpriced = {
  price_local: null,
  price_source_text: null,
  currency: null,
  price_usd_source: null,
} as const;

const trickyNote =
  'Conflict: the manual override says 139.00 SEK *now* [see] <here> | #1_a ~x~ `y` \\ (https://www.netflix.com/se/).\n2. A second line, with ±40%.';

/** Every status, in the 10 records of 5 plans × 2 enabled markets. */
function latest(): LatestFile {
  const us = (overrides: Partial<PriceRecord>) =>
    record({
      market: 'US',
      currency: 'USD',
      source_url: 'https://www.youfundceo.com/services/spotify/united-states',
      ...overrides,
    });
  return {
    built_at: builtAt,
    records: [
      record({ price_local: '149.00', price_source_text: 'kr 149' }),
      us({
        price_local: '12.99',
        price_source_text: '$12.99',
        price_usd_source: '12.99',
      }),
      record({
        service_id: 'netflix',
        plan_id: 'basic',
        price_local: '129.00',
        status: 'conflict',
        notes: trickyNote,
      }),
      us({
        service_id: 'netflix',
        plan_id: 'basic',
        ...unpriced,
        source: manual,
        source_url: 'https://www.netflix.com/us/',
        observed_at: null,
        source_verified_at: '2026-11-10',
        status: 'not_offered',
      }),
      record({
        service_id: 'netflix',
        plan_id: 'standard',
        price_local: '169.00',
        price_source_text: null,
        price_usd_source: null,
        source: manual,
        source_url: 'https://www.netflix.com/se/',
        observed_at: null,
        source_verified_at: '2026-11-10',
        status: 'manual_override',
      }),
      us({
        service_id: 'netflix',
        plan_id: 'standard',
        price_local: '19.99',
        price_source_text: '$19.99',
        price_usd_source: '19.99',
        status: 'stale',
      }),
      record({
        service_id: 'netflix',
        plan_id: 'premium',
        price_local: '319.00',
        price_source_text: 'kr 319',
        status: 'needs_review',
        notes: 'A change of 46% from the last published value.',
      }),
      us({
        service_id: 'netflix',
        plan_id: 'premium',
        ...unpriced,
        status: 'missing',
        missing_reason: 'parse_failed',
      }),
      record({
        service_id: 'lovable',
        plan_id: 'pro',
        ...unpriced,
        status: 'missing',
        missing_reason: 'not_on_source',
      }),
      us({
        service_id: 'lovable',
        plan_id: 'pro',
        ...unpriced,
        status: 'missing',
        missing_reason: 'source_no_price',
      }),
    ],
  };
}

function overrides(): ManualOverridesFile {
  return {
    overrides: [
      priceOverride({
        service_id: 'netflix',
        plan_id: 'basic',
        price_local: '139.00',
        source_url: 'https://www.netflix.com/se/',
        verified_at: '2026-11-10',
      }),
      notOffered({
        market: 'US',
        service_id: 'netflix',
        plan_id: 'basic',
        source_url: 'https://www.netflix.com/us/',
        verified_at: '2026-11-10',
      }),
      priceOverride({
        service_id: 'netflix',
        plan_id: 'standard',
        price_local: '169.00',
        source_url: 'https://www.netflix.com/se/',
        verified_at: '2026-11-10',
      }),
      // The scraper now agrees with this one: it may be retired.
      priceOverride({
        market: 'US',
        price_local: '12.99',
        currency: 'USD',
        source_url: 'https://www.spotify.com/us/premium/',
      }),
    ],
  };
}

function observations(
  overridesOf: Partial<RunObservationsFile> = {},
): RunObservationsFile {
  return {
    run_id: runId,
    source: 'scraper:youfundceo.com',
    observed_at: '2026-11-18T09:30:00.000Z',
    fetch_status: 'completed',
    market_scope: null,
    pages_fetched: 12,
    observations: [],
    gaps: [],
    untracked: [
      {
        kind: 'service',
        source_service: 'disney-plus',
        source_name: 'Disney+ <Premium>',
        suggestion: null,
      },
      {
        kind: 'plan',
        service_id: 'spotify',
        source_service: 'spotify',
        source_plan: 'duo',
        source_name: 'Premium Duo',
        billing_period: 'month',
        markets: ['SE', 'US'],
        suggestion: { plan_id: 'individual' },
      },
    ],
    price_moves: null,
    failures: [],
    ...overridesOf,
  };
}

function input(overridesOf: Partial<CoverageReportInput> = {}) {
  return {
    kind: 'final',
    observations: observations(),
    latest: latest(),
    overrides: overrides(),
    catalogue: catalogue(),
    markets: markets(),
    spotChecks: 5,
    ...overridesOf,
  } satisfies CoverageReportInput;
}

const identity = (entry: {
  market: string;
  service_id: string;
  plan_id: string;
}) => `${entry.market}/${entry.service_id}/${entry.plan_id}`;

test('the matrix has exactly one cell per enabled market × catalogue plan, none for a disabled market', () => {
  const report = buildCoverageReport(input());
  assert.deepEqual(report.markets, ['SE', 'US']);
  assert.deepEqual(
    report.matrix.map((row) => [
      row.service_id,
      row.plan_id,
      row.cells.map((cell) => cell.market),
    ]),
    [
      ['lovable', 'pro', ['SE', 'US']],
      ['netflix', 'basic', ['SE', 'US']],
      ['netflix', 'premium', ['SE', 'US']],
      ['netflix', 'standard', ['SE', 'US']],
      ['spotify', 'individual', ['SE', 'US']],
    ],
  );
  assert.deepEqual(
    report.matrix.flatMap((row) =>
      row.cells.map((cell) => [
        `${cell.market}/${row.service_id}/${row.plan_id}`,
        cell.status,
        cell.missing_reason,
      ]),
    ),
    [
      ['SE/lovable/pro', 'missing', 'not_on_source'],
      ['US/lovable/pro', 'missing', 'source_no_price'],
      ['SE/netflix/basic', 'conflict', null],
      ['US/netflix/basic', 'not_offered', null],
      ['SE/netflix/premium', 'needs_review', null],
      ['US/netflix/premium', 'missing', 'parse_failed'],
      ['SE/netflix/standard', 'manual_override', null],
      ['US/netflix/standard', 'stale', null],
      ['SE/spotify/individual', 'ok', null],
      ['US/spotify/individual', 'ok', null],
    ],
  );
  assert.ok(!JSON.stringify(report).includes('"DE"'));
});

test('a plan removed from the catalogue leaves no cell, even with a stray record left over', () => {
  const smaller = catalogue();
  smaller.services = smaller.services.filter(
    (service) => service.service_id !== 'lovable',
  );
  const netflix = smaller.services.find((s) => s.service_id === 'netflix')!;
  netflix.plans = netflix.plans.filter((p) => p.plan_id !== 'premium');
  const report = buildCoverageReport(input({ catalogue: smaller }));
  const rows = report.matrix.map((row) => `${row.service_id}/${row.plan_id}`);
  assert.deepEqual(rows, [
    'netflix/basic',
    'netflix/standard',
    'spotify/individual',
  ]);
  assert.equal(report.coverage.overall.records, 6);
  const text = serialiseCoverageReport(report);
  assert.ok(!text.includes('lovable'), 'a removed service is still reported');
  assert.ok(!text.includes('"premium"'), 'a removed plan is still reported');
});

test('a matrix cell with no record is a broken index, never a silent gap', () => {
  const broken = latest();
  broken.records = broken.records.filter(
    (entry) => !(entry.market === 'US' && entry.service_id === 'lovable'),
  );
  assert.throws(
    () => buildCoverageReport(input({ latest: broken })),
    /no record for US\/lovable\/pro\/month/,
  );
});

test('coverage overall, per market and per service, floored to one decimal', () => {
  const { coverage } = buildCoverageReport(input());
  // Publishable: SE spotify (ok), US spotify (ok), SE netflix standard (manual_override).
  assert.deepEqual(coverage.overall, {
    publishable: 3,
    records: 10,
    percent: 30,
  });
  assert.equal(coverage.overall.percent, coveragePercent(latest()));
  assert.deepEqual(coverage.by_market, [
    { market: 'SE', publishable: 2, records: 5, percent: 40 },
    { market: 'US', publishable: 1, records: 5, percent: 20 },
  ]);
  assert.deepEqual(coverage.by_service, [
    { service_id: 'lovable', publishable: 0, records: 2, percent: 0 },
    { service_id: 'netflix', publishable: 1, records: 6, percent: 16.6 },
    { service_id: 'spotify', publishable: 2, records: 2, percent: 100 },
  ]);
});

test('missing combinations are grouped by service, not_on_source first, ready for manual entry', () => {
  const { missing } = buildCoverageReport(input());
  assert.deepEqual(missing, [
    {
      reason: 'not_on_source',
      service_id: 'lovable',
      service_name: 'Lovable',
      website_url: 'https://lovable.dev/',
      combinations: [
        {
          market: 'SE',
          currency: 'SEK',
          plan_id: 'pro',
          billing_period: 'month',
        },
      ],
    },
    {
      reason: 'source_no_price',
      service_id: 'lovable',
      service_name: 'Lovable',
      website_url: 'https://lovable.dev/',
      combinations: [
        {
          market: 'US',
          currency: 'USD',
          plan_id: 'pro',
          billing_period: 'month',
        },
      ],
    },
    {
      reason: 'parse_failed',
      service_id: 'netflix',
      service_name: 'Netflix',
      website_url: 'https://www.netflix.com/',
      combinations: [
        {
          market: 'US',
          currency: 'USD',
          plan_id: 'premium',
          billing_period: 'month',
        },
      ],
    },
  ]);
});

test('every needs_review, conflict and stale record is listed, with both values for a conflict', () => {
  const { flagged } = buildCoverageReport(input());
  assert.deepEqual(
    flagged.map((entry) => [identity(entry), entry.status]),
    [
      ['SE/netflix/premium', 'needs_review'],
      ['SE/netflix/basic', 'conflict'],
      ['US/netflix/standard', 'stale'],
    ],
  );
  const conflict = flagged.find((entry) => entry.status === 'conflict')!;
  assert.deepEqual(conflict.shown, {
    price_local: '129.00',
    currency: 'SEK',
    source: 'scraper:youfundceo.com',
  });
  assert.deepEqual(conflict.manual, {
    kind: 'price',
    price_local: '139.00',
    currency: 'SEK',
    verified_at: '2026-11-10',
    source_url: 'https://www.netflix.com/se/',
  });
});

test('retirable overrides and publishable records without a USD figure are listed', () => {
  const report = buildCoverageReport(input());
  assert.deepEqual(report.retirable_overrides, [
    {
      market: 'US',
      service_id: 'spotify',
      plan_id: 'individual',
      billing_period: 'month',
      price_local: '12.99',
      currency: 'USD',
    },
  ]);
  assert.deepEqual(report.unranked, [
    {
      market: 'SE',
      service_id: 'netflix',
      plan_id: 'standard',
      billing_period: 'month',
      price_local: '169.00',
      currency: 'SEK',
      source: 'manual',
    },
  ]);
});

test('the untracked list keeps every entry and its suggestion, which is never applied', () => {
  const given = catalogue();
  const before = JSON.stringify(given);
  const report = buildCoverageReport(input({ catalogue: given }));
  assert.deepEqual(report.untracked, [
    {
      kind: 'service',
      service_id: null,
      source_service: 'disney-plus',
      source_plan: null,
      source_name: 'Disney+ <Premium>',
      billing_period: null,
      markets: [],
      suggestion: null,
    },
    {
      kind: 'plan',
      service_id: 'spotify',
      source_service: 'spotify',
      source_plan: 'duo',
      source_name: 'Premium Duo',
      billing_period: 'month',
      markets: ['SE', 'US'],
      suggestion: 'individual',
    },
  ]);
  assert.equal(JSON.stringify(given), before);
});

test('the report carries no USD figure', () => {
  const text = serialiseCoverageReport(buildCoverageReport(input()));
  assert.ok(!text.includes('price_usd_source'));
  for (const usd of ['13.67', '14.80']) {
    assert.ok(!text.includes(usd), `the USD figure ${usd} is in the report`);
  }
});

/** 3 plans × 20 markets, every one `ok`: 60 records to sample from. */
function manyOk(): { latest: LatestFile; markets: MarketsFile } {
  const codes = 'ABCDEFGHIJKLMNOPQRST'.split('').map((letter) => `S${letter}`);
  const marketFile: MarketsFile = {
    markets: codes.map((code) => ({
      code,
      name: `Market ${code}`,
      slug: `market-${code.toLowerCase()}`,
      currency: 'SEK',
      enabled: true,
    })),
  };
  const records: PriceRecord[] = [];
  for (const code of codes) {
    for (const [service_id, plan_id] of [
      ['spotify', 'individual'],
      ['netflix', 'basic'],
      ['netflix', 'standard'],
      ['netflix', 'premium'],
      ['lovable', 'pro'],
    ] as const) {
      records.push(
        record({
          market: code,
          service_id,
          plan_id,
          ...(service_id === 'lovable'
            ? {
                ...unpriced,
                status: 'missing',
                missing_reason: 'not_on_source',
              }
            : {}),
        }),
      );
    }
  }
  return { latest: { built_at: builtAt, records }, markets: marketFile };
}

test('the same run id always yields the same spot-check sample', () => {
  const { latest: many, markets: marketFile } = manyOk();
  const sample = (id: string, records = many.records) =>
    buildCoverageReport(
      input({
        latest: { built_at: builtAt, records },
        markets: marketFile,
        observations: observations({ run_id: id }),
      }),
    ).spot_checks;

  const first = sample(runId);
  assert.equal(first.requested, 5);
  assert.equal(first.records.length, 5);
  assert.equal(first.seed, spotCheckSeed(runId));
  assert.deepEqual(sample(runId), first);
  // The order the merge happened to list the records in does not matter.
  assert.deepEqual(sample(runId, [...many.records].reverse()), first);
  // Another run draws another sample.
  assert.notDeepEqual(sample('20261218T093000Z').records, first.records);
  // Only `ok` records, each with the service's official URL.
  for (const entry of first.records) {
    assert.notEqual(entry.service_id, 'lovable');
    assert.equal(
      entry.official_url,
      catalogue().services.find((s) => s.service_id === entry.service_id)!
        .website_url,
    );
  }
  // The pinned sample of this run id: a change to the seed or the draw shows here.
  assert.equal(first.seed, PINNED_SEED);
  assert.deepEqual(first.records.map(identity), PINNED_SAMPLE);
  assert.notEqual(spotCheckSeed(runId), spotCheckSeed(`${runId}-2`));
});

test('the sample draws without replacement, and takes every record when there are fewer than N', () => {
  const { latest: many } = manyOk();
  const ok = many.records.filter((entry) => entry.status === 'ok');
  const all = sampleRecords(ok, 42, 60);
  assert.equal(new Set(all.map((entry) => identity(entry))).size, 60);
  assert.equal(sampleRecords(ok.slice(0, 3), 42, 5).length, 3);
  const report = buildCoverageReport(input());
  assert.deepEqual(report.spot_checks.records.map(identity), [
    'SE/spotify/individual',
    'US/spotify/individual',
  ]);
});

test('the spot-check count comes from config/price-index.json, 5 by default', async () => {
  const file = priceIndexSettingsFileSchema.parse(
    JSON.parse(
      await readFile(join(projectRoot, 'config/price-index.json'), 'utf8'),
    ),
  );
  assert.deepEqual(file.reports, { spot_checks: 5 });
  for (const bad of [
    {},
    { spot_checks: 0 },
    { spot_checks: 2.5 },
    { spot_checks: 5, extra: 1 },
  ]) {
    assert.equal(
      reportSettingsSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  }
  const { latest: many, markets: marketFile } = manyOk();
  const report = buildCoverageReport(
    input({ latest: many, markets: marketFile, spotChecks: 7 }),
  );
  assert.equal(report.spot_checks.records.length, 7);
});

// ---------------------------------------------------------------------------
// JSON–Markdown parity: every figure is read back out of the Markdown.

function sectionOf(markdown: string, title: string): string {
  const start = markdown.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `no section ${title}`);
  const rest = markdown.slice(start + title.length + 5);
  const end = rest.indexOf('\n## ');
  return end < 0 ? rest : rest.slice(0, end);
}

function tableAfter(text: string, heading: string): string[][] {
  const lines = text.slice(text.indexOf(heading)).split('\n');
  const first = lines.findIndex((line) => line.startsWith('|'));
  const rows: string[][] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith('|')) {
      break;
    }
    rows.push(
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  }
  return rows.filter((_, index) => index !== 1); // the delimiter row
}

function topItems(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('- '));
}

function assertParity(report: CoverageReportFile, markdown: string) {
  const overall =
    /Overall: (\d+) of (\d+) records publishable \(([\d.]+)%\)/u.exec(markdown);
  assert.ok(overall);
  assert.deepEqual(
    [
      Number.parseInt(overall[1]!, 10),
      Number.parseInt(overall[2]!, 10),
      overall[3],
    ],
    [
      report.coverage.overall.publishable,
      report.coverage.overall.records,
      String(report.coverage.overall.percent),
    ],
  );
  const coverage = sectionOf(markdown, 'Coverage');
  const byMarket = tableAfter(coverage, '### By market');
  assert.deepEqual(
    byMarket.slice(1),
    report.coverage.by_market.map((row) => [
      row.market,
      String(row.publishable),
      String(row.records),
      `${row.percent}%`,
    ]),
  );
  const byService = tableAfter(coverage, '### By service');
  assert.deepEqual(
    byService.slice(1),
    report.coverage.by_service.map((row) => [
      row.service_id,
      String(row.publishable),
      String(row.records),
      `${row.percent}%`,
    ]),
  );

  const matrix = tableAfter(sectionOf(markdown, 'Matrix'), '| Plan');
  assert.deepEqual(matrix[0], ['Plan', ...report.markets]);
  const fromCode = new Map(
    Object.entries(cellCodes).map(([status, code]) => [code, status]),
  );
  assert.deepEqual(
    matrix
      .slice(1)
      .map((row) => [
        row[0],
        ...row.slice(1).map((code) => fromCode.get(code)),
      ]),
    report.matrix.map((row) => [
      `${row.service_id}/${row.plan_id}/${row.billing_period}`,
      ...row.cells.map((cell) =>
        cell.status === 'missing'
          ? `missing:${cell.missing_reason}`
          : cell.status,
      ),
    ]),
  );

  const missing = sectionOf(markdown, 'Missing, for manual entry');
  const groups = missing.split('\n').filter((line) => line.startsWith('### '));
  assert.deepEqual(
    groups,
    report.missing.map(
      (group) =>
        `### \`${group.reason}\`: ${group.service_name} (\`${group.service_id}\`)`,
    ),
  );
  assert.deepEqual(
    topItems(missing),
    report.missing.flatMap((group) =>
      group.combinations.map(
        (entry) =>
          `- \`${entry.market}\` \`${entry.plan_id}\` (${entry.billing_period}), in \`${entry.currency}\``,
      ),
    ),
  );

  const flagged = topItems(
    sectionOf(markdown, 'Flagged: needs_review, conflict and stale'),
  );
  assert.equal(flagged.length, report.flagged.length);
  report.flagged.forEach((entry, index) => {
    const line = flagged[index]!;
    assert.ok(
      line.includes(
        `\`${entry.market}\` \`${entry.service_id}\` \`${entry.plan_id}\``,
      ),
      line,
    );
    assert.ok(line.includes(`**${entry.status}**`), line);
    if (entry.shown !== null) {
      assert.ok(
        line.includes(`\`${entry.shown.price_local} ${entry.shown.currency}\``),
        line,
      );
    }
    if (entry.manual?.kind === 'price') {
      assert.ok(
        line.includes(
          `manual entry \`${entry.manual.price_local} ${entry.manual.currency}\``,
        ),
        line,
      );
    }
  });

  for (const [title, entries] of [
    ['Retirable overrides', report.retirable_overrides],
    ['Publishable without a USD figure (never ranked)', report.unranked],
  ] as const) {
    const items = topItems(sectionOf(markdown, title));
    assert.deepEqual(
      items.map((line) =>
        /^- `(\w+)` `([\w-]+)` `([\w-]+)` \(\w+\): .*`([\d.]+) (\w+)`/u
          .exec(line)!
          .slice(1),
      ),
      entries.map((entry) => [
        entry.market,
        entry.service_id,
        entry.plan_id,
        entry.price_local,
        entry.currency,
      ]),
      title,
    );
  }

  const untracked = topItems(sectionOf(markdown, 'Untracked on source'));
  assert.equal(untracked.length, report.untracked.length);
  report.untracked.forEach((entry, index) => {
    assert.ok(untracked[index]!.includes(`\`${entry.source_service}\``));
    assert.ok(
      untracked[index]!.includes(
        entry.suggestion === null
          ? 'no suggestion'
          : `suggestion \`${entry.suggestion}\`, not applied`,
      ),
    );
  });

  const spot = sectionOf(markdown, 'Spot checks');
  assert.ok(
    spot.includes(
      `${report.spot_checks.records.length} of ${report.spot_checks.requested} requested`,
    ),
  );
  assert.ok(spot.includes(`seed ${report.spot_checks.seed}`));
  assert.deepEqual(
    topItems(spot).map((line) =>
      /^- `(\w+)` `([\w-]+)` `([\w-]+)` \(\w+\): `([\d.]+) (\w+)`.*official <([^>]+)>/u
        .exec(line)!
        .slice(1),
    ),
    report.spot_checks.records.map((entry) => [
      entry.market,
      entry.service_id,
      entry.plan_id,
      entry.price_local,
      entry.currency,
      entry.official_url,
    ]),
  );
}

test('the JSON and the Markdown report the same figures', () => {
  const report = buildCoverageReport(input());
  assertParity(report, renderCoverageMarkdown(report));
  // The JSON file is the object itself.
  assert.deepEqual(
    coverageReportFileSchema.parse(JSON.parse(serialiseCoverageReport(report))),
    report,
  );
});

test('parity holds over a large index, with every section empty but the ones it fills', () => {
  const { latest: many, markets: marketFile } = manyOk();
  const report = buildCoverageReport(
    input({
      latest: many,
      markets: marketFile,
      overrides: { overrides: [] },
      observations: observations({ untracked: [] }),
    }),
  );
  const markdown = renderCoverageMarkdown(report);
  assertParity(report, markdown);
  assert.match(sectionOf(markdown, 'Retirable overrides'), /None\./);
  assert.match(sectionOf(markdown, 'Untracked on source'), /None\./);
});

test('the parity check catches a figure that differs', () => {
  const report = buildCoverageReport(input());
  const markdown = renderCoverageMarkdown(report);
  const tampered = markdown.replace('| SE     | 2 ', '| SE     | 3 ');
  assert.notEqual(tampered, markdown);
  assert.throws(() => assertParity(report, tampered));
});

test('both files are deterministic and in the repository format, whatever the notes hold', async () => {
  const report = buildCoverageReport(input());
  const shuffled = buildCoverageReport(
    input({
      latest: { built_at: builtAt, records: [...latest().records].reverse() },
      overrides: { overrides: [...overrides().overrides].reverse() },
    }),
  );
  assert.equal(
    serialiseCoverageReport(shuffled),
    serialiseCoverageReport(report),
  );
  assert.equal(
    renderCoverageMarkdown(shuffled),
    renderCoverageMarkdown(report),
  );
  assert.equal(coverageReportBaseName(report), 'coverage-2026-11-18');

  for (const [name, text] of [
    ['coverage-2026-11-18.json', serialiseCoverageReport(report)],
    ['coverage-2026-11-18.md', renderCoverageMarkdown(report)],
  ] as const) {
    const filepath = join(projectRoot, 'reports', name);
    const options = (await prettier.resolveConfig(filepath)) ?? {};
    assert.equal(
      await prettier.format(text, { ...options, filepath }),
      text,
      `${name} is not in Prettier's format`,
    );
  }
  // Twenty markets: the list of market codes is too long for one line.
  const { latest: many, markets: marketFile } = manyOk();
  const wide = serialiseCoverageReport(
    buildCoverageReport(input({ latest: many, markets: marketFile })),
  );
  const widePath = join(projectRoot, 'reports', 'coverage-2026-11-18.json');
  assert.equal(
    await prettier.format(wide, {
      ...((await prettier.resolveConfig(widePath)) ?? {}),
      filepath: widePath,
    }),
    wide,
  );
  assert.match(wide, /"markets": \[\n {4}"SA",\n/);
  // The note's Markdown characters stay literal text.
  const markdown = renderCoverageMarkdown(report);
  assert.ok(markdown.includes('\\*now\\* \\[see\\] \\<here\\> \\| \\#1\\_a'));
  assert.ok(markdown.includes('  - 2\\. A second line'));
});

test('a catalogue addition appears as missing cells, and a removal leaves none (through the merge)', () => {
  const merge = (catalogueFile: CatalogueFile) =>
    mergePriceIndex({
      previous: null,
      run: run({
        observations: [
          observation(),
          observation({
            market: 'US',
            price_local: '12.99',
            price_source_text: '$12.99',
            currency: 'USD',
            price_usd_source: '12.99',
          }),
        ],
        gaps: catalogueFile.services
          .filter((service) => service.service_id !== 'spotify')
          .flatMap((service) =>
            service.plans.flatMap((p) =>
              ['SE', 'US'].map((market) =>
                gap({
                  market,
                  service_id: service.service_id,
                  plan_id: p.plan_id,
                }),
              ),
            ),
          ),
      }),
      overrides: { overrides: [] },
      approvals: { approvals: [] },
      catalogue: catalogueFile,
      markets: markets(),
      settings: settings(),
      clock: clockAt(builtAt),
    });
  const report = (catalogueFile: CatalogueFile) =>
    buildCoverageReport(
      input({
        catalogue: catalogueFile,
        latest: merge(catalogueFile),
        overrides: { overrides: [] },
      }),
    );

  const base = catalogue();
  base.services = base.services.filter((s) => s.service_id === 'spotify');
  const before = report(base);
  assert.deepEqual(
    before.matrix.map((row) => row.service_id),
    ['spotify'],
  );

  const added = catalogue();
  added.services = added.services.filter((s) => s.service_id !== 'netflix');
  added.services.push({
    service_id: 'crunchyroll',
    name: 'Crunchyroll',
    category: 'streaming',
    website_url: 'https://www.crunchyroll.com/',
    status: 'launch',
    plans: [plan('mega-fan', 'Mega Fan')],
    source_aliases: { service: [], plans: {} },
  });
  const after = report(added);
  const newCells = after.matrix
    .filter((row) => row.service_id === 'crunchyroll')
    .flatMap((row) => row.cells);
  assert.deepEqual(
    newCells.map((cell) => [cell.market, cell.status, cell.missing_reason]),
    [
      ['SE', 'missing', 'not_on_source'],
      ['US', 'missing', 'not_on_source'],
    ],
  );
  assert.ok(
    after.missing.some(
      (group) =>
        group.service_id === 'crunchyroll' && group.combinations.length === 2,
    ),
  );

  // Removed again: no cell, no figure, no missing group.
  const removed = report(base);
  assert.deepEqual(removed, before);
  assert.ok(!serialiseCoverageReport(removed).includes('crunchyroll'));
});
