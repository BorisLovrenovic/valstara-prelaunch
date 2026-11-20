import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  isPublishable,
  publishableStatuses,
  publishedView,
} from '../../packages/price-index/src/publish/gate.ts';
import {
  priceIndexSettingsFileSchema,
  priceRecordKeys,
  priceStatuses,
  sourceOrigin,
  type MergeSettings,
  type PriceRecord,
} from '../../packages/price-index/src/schema/index.ts';
import { pricesCopy } from '../../src/copy/prices.ts';
import { projectRoot } from '../helpers/price-index-run.ts';

// E11.6-13: the methodology–config reconciliation. Every statement on
// `/price-index` (src/content/price-index-methodology.md) must be literally
// true of the built system and traceable to code or configuration. Each
// sentence of the content file is matched by exactly one trace below, which
// names where the statement is true and checks it there: a number against
// config/price-index.json, a rule against the publish gate, a behaviour
// against the named test that proves it. A sentence with no trace fails, a
// trace whose sentence is gone fails, and a changed setting with an
// unchanged statement fails (the red paths at the end).

const methodologyFile = 'src/content/price-index-methodology.md';

/** The founder's wording for the methodology (D4, 2026-11-17), verbatim. */
const d4 =
  "We collect official list prices once a month from public price listings, and check them by hand against providers' own pricing pages where needed.";

interface Facts {
  readonly merge: MergeSettings;
  /** The repository files the evidence traces read, by path. */
  readonly files: ReadonlyMap<string, string>;
}

interface Trace {
  /** The whole statement; numbers the configuration sets are captured. */
  readonly statement: RegExp;
  /** Where the statement is true. */
  readonly trace: string;
  /** Null when the statement holds; otherwise why it does not. */
  readonly check: (match: RegExpExecArray, facts: Facts) => string | null;
}

/** A record of the given status, otherwise publishable. */
function record(overrides: Partial<PriceRecord>): PriceRecord {
  return {
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    price_local: '149.00',
    price_source_text: '149 kr',
    currency: 'SEK',
    price_usd_source: '16.78',
    source: 'scraper:youfundceo.com',
    source_url: `${sourceOrigin}/services/spotify/sweden`,
    observed_at: '2026-11-18T09:30:00.000Z',
    source_verified_at: '2026-11-17',
    status: 'ok',
    missing_reason: null,
    notes: null,
    ...overrides,
  };
}

/** The gate refuses every one of these statuses. */
function refuses(...statuses: PriceRecord['status'][]): string | null {
  const published = statuses.filter((status) =>
    isPublishable(record({ status })),
  );
  return published.length === 0
    ? null
    : `the publish gate passes ${published.join(', ')}`;
}

/** The named evidence is present in the file it is in. */
function evidence(
  facts: Facts,
  file: string,
  ...needles: string[]
): string | null {
  const content = facts.files.get(file);
  if (content === undefined) return `${file} is not read`;
  const missing = needles.filter((needle) => !content.includes(needle));
  return missing.length === 0
    ? null
    : `${file} no longer holds ${missing.map((item) => `"${item}"`).join(', ')}`;
}

const mergeTests = 'test/price-index/merge-status-rules.test.ts';

const traces: readonly Trace[] = [
  {
    statement: new RegExp(
      `^${d4.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`,
      'u',
    ),
    trace:
      "D4, the founder's wording (2026-11-17). Once a month: the monthly report is one per calendar month, and a price read in one monthly run is still within the scraped staleness limit at the next; by hand: an override must cite the service's own site (E11.6-08), and the coverage report samples records to spot-check against it",
    check: (_match, facts) =>
      facts.merge.stale_after_days.scraped >= 31
        ? evidence(facts, 'test/price-index/override-cli.test.ts', 'source_url')
        : `a scraped price goes stale after ${facts.merge.stale_after_days.scraped} days, so a monthly collection could not keep it up`,
  },
  {
    statement: /^Each price is the list price of one plan in one market\.$/u,
    trace: 'one record per market × service × plan × billing period',
    check: (_match, facts) =>
      evidence(
        facts,
        'packages/price-index/src/schema/price-record.ts',
        'export function recordIdentity(',
      ),
  },
  {
    statement:
      /^It is shown in that market's own currency, exactly as it is listed\.$/u,
    trace:
      "the page shows `price_local` exactly, and a record not in its market's currency fails the build (src/server/prices/site.ts)",
    check: (_match, facts) =>
      evidence(
        facts,
        'src/server/prices/site.ts',
        'amount: record.price_local,',
        "which is not ${market.name}'s currency",
      ),
  },
  {
    statement: /^We never convert a price into another currency\.$/u,
    trace:
      'no FX anywhere: the record has no converted field, and the published view carries no USD figure',
    check: () => {
      const keys: readonly string[] = priceRecordKeys;
      if (keys.some((key) => /fx|convert/u.test(key))) {
        return 'the price record carries a converted field';
      }
      const view = publishedView({
        built_at: '2026-11-18T10:00:00.000Z',
        records: [record({})],
      });
      return view.records.some((item) => 'price_usd_source' in item)
        ? 'the published view carries a USD figure'
        : null;
    },
  },
  {
    statement:
      /^Beside each price is the date it was last verified: the date the listing last checked it, the date we checked it by hand, or, where the listing gives no date, the day we read it\.$/u,
    trace:
      "`verificationDate` in src/server/prices/site.ts: `source_verified_at` (the listing's last-checked date, or the founder's for a manual entry), else the day of `observed_at`",
    check: (_match, facts) =>
      evidence(
        facts,
        'src/server/prices/site.ts',
        'record.source_verified_at ?? record.observed_at?.slice(0, 10)',
      ),
  },
  {
    statement: /^We publish a price only when it passes every check\.$/u,
    trace: 'the publish gate passes only `ok` and approved `manual_override`',
    check: () =>
      JSON.stringify(publishableStatuses) ===
      JSON.stringify(['ok', 'manual_override'])
        ? refuses(
            ...priceStatuses.filter(
              (status) => status !== 'ok' && status !== 'manual_override',
            ),
          )
        : `the gate publishes ${publishableStatuses.join(', ')}`,
  },
  {
    statement: /^It must be in the market's own currency and above zero\.$/u,
    trace:
      'the merge makes a value in another currency or at zero `needs_review`, never approvable, and the gate refuses a zero price',
    check: (_match, facts) =>
      isPublishable(record({ price_local: '0.00' }))
        ? 'the gate passes a price of zero'
        : evidence(
            facts,
            mergeTests,
            "test('the currency check: a value in another currency is needs_review",
            "test('the price check: a price of zero is needs_review",
          ),
  },
  {
    statement:
      /^A price that has changed by more than (\d+)% since the last price we published is held back until a person has checked it and approved it\.$/u,
    trace: 'config/price-index.json merge.change_threshold_percent',
    check: (match, facts) =>
      Number(match[1]) === facts.merge.change_threshold_percent
        ? (refuses('needs_review') ??
          evidence(
            facts,
            mergeTests,
            "test('±40%: exactly 40% passes, and anything more is needs_review, up or down'",
          ))
        : `the statement says ${match[1]}%, the setting is ${facts.merge.change_threshold_percent}%`,
  },
  {
    statement:
      /^If a listing and our own hand check disagree, neither price is published until a person decides\.$/u,
    trace:
      'a scraped value against an override or a not_offered entry is `conflict`, which the gate refuses until `review approve|reject`',
    check: (_match, facts) =>
      refuses('conflict') ??
      evidence(
        facts,
        mergeTests,
        "test('precedence: the scraper disagreeing with an override is a conflict, with both values in the record'",
        "test('a conflict approved: the scraper value publishes as ok'",
      ),
  },
  {
    statement:
      /^If a plan disappears from a listing, we flag it for a person to check rather than removing it quietly\.$/u,
    trace: 'a disappearance is `needs_review`, never a deletion',
    check: (_match, facts) =>
      refuses('needs_review') ??
      evidence(
        facts,
        mergeTests,
        "test('disappearance: a plan the source no longer prices becomes needs_review with its last value in notes, never deleted'",
      ),
  },
  {
    statement: /^Where we have no verified price for a plan, we show none\.$/u,
    trace:
      'a page is generated only from publishable records; `missing`, `not_offered`, `needs_review`, `conflict` and `stale` are refused',
    check: () =>
      refuses('missing', 'not_offered', 'needs_review', 'conflict', 'stale'),
  },
  {
    statement:
      /^Each time we update the index, a price we read from a listing more than (\d+) days earlier, or checked by hand more than (\d+) days earlier, is marked out of date and taken off our pages until it has been checked again\.$/u,
    trace:
      'config/price-index.json merge.stale_after_days.scraped and .manual, applied by every `build-data`; a `stale` record is refused by the gate',
    check: (match, facts) => {
      const { scraped, manual } = facts.merge.stale_after_days;
      if (Number(match[1]) !== scraped) {
        return `the statement says ${match[1]} days for a listing, the setting is ${scraped}`;
      }
      if (Number(match[2]) !== manual) {
        return `the statement says ${match[2]} days by hand, the setting is ${manual}`;
      }
      return (
        refuses('stale') ??
        evidence(
          facts,
          mergeTests,
          "test('staleness: the limits are configurable'",
        )
      );
    },
  },
  {
    statement:
      /^We record a price change only when one published price replaces another\.$/u,
    trace:
      'change detection compares published values only (E11.6-09): a first observation, a status change and a formatting difference log nothing',
    check: (_match, facts) =>
      evidence(
        facts,
        'test/price-index/change-detection.test.ts',
        "test('a first observation produces no entry'",
        "test('a status change produces no entry'",
      ),
  },
  {
    statement: /^Our record of past changes is never edited\.$/u,
    trace: 'changes.json is append-only, enforced in CI',
    check: (_match, facts) =>
      evidence(
        facts,
        'test/price-index/changes-append-only.test.mjs',
        "test('changes.json is one of the append-only files",
      ),
  },
  {
    statement:
      /^Where we compare markets, we rank them by price on a common basis and show each price in its own market's currency\.$/u,
    trace:
      "`rankMarkets()` orders by one figure for every market, and every comparison shows each market's own published price",
    check: (_match, facts) =>
      evidence(
        facts,
        'packages/price-index/src/publish/gate.ts',
        'export function rankMarkets(',
      ) ??
      evidence(
        facts,
        'src/server/prices/site.ts',
        'ranked.record.currency !== market.currency',
      ),
  },
];

/** The content file's frontmatter and its statements: every sentence of its body. */
function statementsOf(source: string): {
  frontmatter: string;
  statements: string[];
} {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  assert.ok(match, 'the methodology has frontmatter');
  const statements = match[2]!
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block !== '' && !block.startsWith('#'))
    .flatMap((paragraph) =>
      paragraph.replace(/\s+/gu, ' ').split(/(?<=\.)\s+(?=[A-Z])/u),
    );
  return { frontmatter: match[1]!, statements };
}

/** Every reason a statement is not reconciled; empty when all are. */
function reconcile(statements: readonly string[], facts: Facts): string[] {
  const issues: string[] = [];
  const used = new Set<Trace>();
  for (const statement of statements) {
    const matches = traces.flatMap((trace) => {
      const match = trace.statement.exec(statement);
      return match === null ? [] : [{ trace, match }];
    });
    if (matches.length !== 1) {
      issues.push(
        `"${statement}" ${matches.length === 0 ? 'has no trace' : 'matches more than one trace'}`,
      );
      continue;
    }
    const [{ trace, match }] = matches as [
      { trace: Trace; match: RegExpExecArray },
    ];
    used.add(trace);
    const problem = trace.check(match, facts);
    if (problem !== null) {
      issues.push(`"${statement}" (${trace.trace}): ${problem}`);
    }
  }
  for (const trace of traces) {
    if (!used.has(trace)) {
      issues.push(`the trace ${trace.statement} has no statement`);
    }
  }
  return issues;
}

/**
 * Every sentence that says or implies the prices are read from official or
 * providers' pages. The only mention of such pages allowed is the hand check
 * against them (D4): the data is collected from a public price listing.
 */
function officialPageClaims(texts: readonly string[]): string[] {
  const allowed =
    /\bcheck(?:ed)? (?:them |it )?by hand against providers' own pricing pages\b/giu;
  const pages =
    /\b(?:official|providers?'?|provider's|their own)\s+(?:own\s+)?(?:pricing\s+|price\s+)?(?:pages?|websites?|sites?)\b|\bpricing pages?\b/iu;
  return texts.filter((text) => pages.test(text.replace(allowed, '')));
}

async function facts(merge?: MergeSettings): Promise<Facts> {
  const settings = priceIndexSettingsFileSchema.parse(
    JSON.parse(
      await readFile(join(projectRoot, 'config/price-index.json'), 'utf8'),
    ),
  );
  const paths = [
    'packages/price-index/src/schema/price-record.ts',
    'packages/price-index/src/publish/gate.ts',
    'src/server/prices/site.ts',
    mergeTests,
    'test/price-index/change-detection.test.ts',
    'test/price-index/changes-append-only.test.mjs',
    'test/price-index/override-cli.test.ts',
  ];
  const files = new Map<string, string>();
  for (const path of paths) {
    files.set(path, await readFile(join(projectRoot, path), 'utf8'));
  }
  return { merge: merge ?? settings.merge, files };
}

async function methodology() {
  return statementsOf(
    await readFile(join(projectRoot, methodologyFile), 'utf8'),
  );
}

test('every methodology statement is traced to the code or configuration it describes, and holds there', async () => {
  const { statements } = await methodology();
  assert.ok(statements.length >= traces.length);
  assert.deepEqual(reconcile(statements, await facts()), []);
});

test("the methodology opens with the founder's D4 wording, verbatim", async () => {
  const { statements } = await methodology();
  assert.equal(statements[0], d4);
});

test('a changed setting with an unchanged statement fails the reconciliation', async () => {
  const { statements } = await methodology();
  const current = (await facts()).merge;
  const threshold = reconcile(
    statements,
    await facts({ ...current, change_threshold_percent: 30 }),
  );
  assert.equal(threshold.length, 1);
  assert.match(threshold[0]!, /says 40%, the setting is 30%/u);

  const scraped = reconcile(
    statements,
    await facts({
      ...current,
      stale_after_days: { ...current.stale_after_days, scraped: 60 },
    }),
  );
  assert.equal(scraped.length, 1);
  assert.match(scraped[0]!, /says 45 days for a listing, the setting is 60/u);

  const manual = reconcile(
    statements,
    await facts({
      ...current,
      stale_after_days: { ...current.stale_after_days, manual: 120 },
    }),
  );
  assert.equal(manual.length, 1);
  assert.match(manual[0]!, /says 90 days by hand, the setting is 120/u);

  // A cadence the staleness limit could not keep up is refused too.
  const cadence = reconcile(
    statements,
    await facts({
      ...current,
      stale_after_days: { ...current.stale_after_days, scraped: 20 },
    }),
  );
  assert.ok(cadence.some((issue) => /monthly collection/u.test(issue)));
});

test('an untraced statement, a statement changed against its code, and a trace without a statement each fail', async () => {
  const { statements } = await methodology();
  const real = await facts();
  assert.match(
    reconcile([...statements, 'We check every price every day.'], real).join(
      '\n',
    ),
    /"We check every price every day\." has no trace/u,
  );
  assert.match(
    reconcile(
      statements.filter((statement) => !statement.startsWith('Our record')),
      real,
    ).join('\n'),
    /has no statement/u,
  );
  // The evidence a statement cites must still be where it says.
  const files = new Map(real.files);
  files.set(
    mergeTests,
    (files.get(mergeTests) as string).replaceAll('disappearance', 'removal'),
  );
  assert.match(
    reconcile(statements, { ...real, files }).join('\n'),
    /disappears from a listing.*no longer holds/u,
  );
});

test('no statement claims the prices are read from official pages, and none names the data source', async () => {
  const { frontmatter, statements } = await methodology();
  const copy = pricesCopy.priceIndex;
  const texts = [
    ...statements,
    frontmatter,
    copy.dataset.name,
    copy.dataset.description,
    copy.reportsHeading,
    copy.noReports,
    copy.pricesLink,
    pricesCopy.page.methodologyLink,
    pricesCopy.monthly.description('2026-10'),
    pricesCopy.monthly.intro(20, '2026-10-30'),
    pricesCopy.monthly.extremesBasis,
  ];
  assert.deepEqual(officialPageClaims(texts), []);
  const source = new URL(sourceOrigin).hostname.replace(/^www\./u, '');
  for (const text of texts) {
    assert.doesNotMatch(text, new RegExp(source.split('.')[0]!, 'iu'));
  }
  // The hand check against providers' pages is the only mention allowed;
  // a claim that the prices come from those pages is caught.
  assert.deepEqual(
    officialPageClaims([
      'We take prices from official pricing pages.',
      "Prices are read from each provider's own website.",
      'Every price comes from the providers’ pricing pages.',
      d4,
    ]),
    [
      'We take prices from official pricing pages.',
      "Prices are read from each provider's own website.",
      'Every price comes from the providers’ pricing pages.',
    ],
  );
  // The Dataset says what the methodology says.
  assert.ok(
    copy.dataset.description.includes(
      "once a month from public price listings, and check them by hand against providers' own pricing pages where needed",
    ),
  );
});
