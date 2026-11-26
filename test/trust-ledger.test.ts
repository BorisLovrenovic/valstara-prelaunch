// E11.8-01: the Trust Ledger, unit and against a real database with an
// injected clock. The Tests line: the append-only guard · schema validation
// red paths · ordering and archive · the waitlist figures against seeded data
// · admin authentication and audit · flag off. The rendered page, its links
// and sitemap are in test/trust-ledger-rendered.test.mjs; the third-party and
// storage gates and the accessibility and layout checks in
// test/trust-ledger-browser.test.mjs.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';

import type { APIContext } from 'astro';
import { z } from 'astro/zod';
import * as prettier from 'prettier';

import { scanTrustLedgerAppendOnly } from '../scripts/ci/trust-ledger-append-only.mjs';
import { adminCopy } from '../src/copy/admin.ts';
import { layoutCopy } from '../src/copy/layout.ts';
import { trustLedgerCopy } from '../src/copy/trust-ledger.ts';
import { createTrustLedgerFiguresRoute } from '../src/pages/api/admin/trust-ledger/waitlist.ts';
import {
  adminActor,
  createAdminAuthenticator,
} from '../src/server/admin-auth/authenticate.ts';
import { createAdminAuthMiddleware } from '../src/server/admin-auth/middleware.ts';
import { adminRouteRegistry } from '../src/server/admin-auth/route-registry.ts';
import { generateTotp } from '../src/server/admin-auth/totp.ts';
import {
  AdminCommandError,
  adminCommands,
  runAdminCommand,
} from '../src/server/admin/cli.ts';
import { DatabaseUnavailableError } from '../src/server/db/errors.ts';
import { campaignFlagRegistry } from '../src/server/flags/registry.ts';
import type { Flag } from '../src/server/flags/types.ts';
import { childSitemaps, sitemapPaths } from '../src/server/seo.ts';
import {
  defaultTrustLedgerDirectory,
  trustLedgerCommandLine,
} from '../src/server/trust-ledger/cli.ts';
import {
  readTrustLedgerFigures,
  trustLedgerDraft,
  trustLedgerDraftSource,
} from '../src/server/trust-ledger/draft.ts';
import {
  trustLedgerEntryProblems,
  trustLedgerEntrySchema,
  trustLedgerTextLimits,
} from '../src/server/trust-ledger/entry-schema.ts';
import { createTrustLedgerFiguresHandler } from '../src/server/trust-ledger/figures-http.ts';
import {
  createTrustLedger,
  TrustLedgerInvalidError,
  trustLedgerFileProblems,
} from '../src/server/trust-ledger/ledger.ts';
import {
  trustLedgerCount,
  trustLedgerView,
  type TrustLedgerEntryView,
} from '../src/server/trust-ledger/presentation.ts';
import {
  trustLedgerCacheControl,
  trustLedgerPageEnabled,
  trustLedgerSitemapXml,
  trustLedgerVisible,
} from '../src/server/trust-ledger/route.ts';
import {
  createTrustLedgerFiguresService,
  TrustLedgerFiguresRefusedError,
  trustLedgerMonthRange,
} from '../src/server/trust-ledger/waitlist-figures.ts';

import {
  createPartnerFixture,
  insertMember,
  insertPartner,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const run = promisify(execFile);
const fixtureDirectory = resolve('test/fixtures/trust-ledger');

async function fixtureEntry(month: '2026-12' | '2027-01') {
  return JSON.parse(
    await readFile(join(fixtureDirectory, `${month}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

// ── P11 Part 2, word for word ───────────────────────────────────────────────

/** Every line of P11 Part 2: its headings, paragraphs and list items. */
async function partTwoLines(): Promise<{
  headings: string[];
  lines: string[];
}> {
  const source = await readFile(
    'docs/prerequisites/p11-trust-ledger-text.md',
    'utf8',
  );
  const start = source.indexOf('## Part 2 — The first entry: December 2026');
  const end = source.indexOf('\n---\n', start);
  assert.ok(start > 0 && end > start, 'P11 Part 2 is present');
  const headings: string[] = [];
  const lines: string[] = [];
  for (const raw of source.slice(start, end).split('\n').slice(1)) {
    const line = raw.trim();
    if (line === '') continue;
    // The waitlist figures come from the draft command, not from P11.
    if (line.startsWith('*Written by')) continue;
    if (line.startsWith('### ')) headings.push(line.slice(4));
    else lines.push(line.replace(/^- /u, ''));
  }
  return { headings, lines };
}

function viewText(view: TrustLedgerEntryView): {
  headings: string[];
  lines: string[];
} {
  return {
    headings: view.sections.map((section) => section.heading),
    lines: view.sections.flatMap((section) =>
      section.blocks.flatMap((block) =>
        block.kind === 'paragraphs' ? block.paragraphs : block.items,
      ),
    ),
  };
}

test('the schema holds P11 Part 2 word for word, and the page view renders every line of it', async () => {
  const entry = await fixtureEntry('2026-12');
  assert.deepEqual(trustLedgerEntryProblems(entry), []);
  const ledger = createTrustLedger({ '2026-12.json': entry });
  const [view] = trustLedgerView(ledger);
  assert.ok(view);
  const rendered = viewText(view);
  const partTwo = await partTwoLines();
  // Every P11 heading is a section, in P11's order.
  assert.deepEqual(rendered.headings, partTwo.headings);
  assert.equal(partTwo.lines.length, 33);
  for (const line of partTwo.lines)
    assert.ok(rendered.lines.includes(line), `P11 Part 2 renders: ${line}`);
  // Nothing beyond P11 is rendered but the draft command's waitlist lines.
  assert.deepEqual(
    rendered.lines.filter((line) => !partTwo.lines.includes(line)),
    [
      'Counted on 1 January 2027.',
      'Total: 1,287',
      'New this month: 1,287',
      'Joined through a referral: 412 of 1,287',
    ],
  );
});

// ── Schema validation red paths ─────────────────────────────────────────────

/** Sets (or, with `deleted`, removes) the value at a dotted path. */
const deleted = Symbol('deleted');
function setPath(target: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1))
    node = node[key] as Record<string, unknown>;
  const last = keys.at(-1) as string;
  if (value === deleted) delete node[last];
  else node[last] = value;
}

const redPaths: readonly [string, string, unknown, RegExp][] = [
  ['a missing section', 'introduction', deleted, /introduction/u],
  ['an empty section', 'launchStatus', [], /launchStatus/u],
  ['an empty paragraph', 'whatWentWrong', [''], /is empty/u],
  [
    'a paragraph over its length',
    'introduction',
    ['a'.repeat(trustLedgerTextLimits.paragraphCharacters + 1)],
    /introduction\.0/u,
  ],
  ['an unknown month', 'month', '2026-13', /YYYY-MM/u],
  [
    'an unknown build status',
    'buildProgress.0.status',
    'finished',
    /buildProgress\.0\.status/u,
  ],
  [
    'a negative count',
    'partnerProgramme.active',
    -1,
    /partnerProgramme\.active/u,
  ],
  ['a rounded count', 'waitlist.total', 1287.5, /waitlist\.total/u],
  [
    'a count written as text',
    'supplyReadiness.launchProducts',
    '33',
    /supplyReadiness\.launchProducts/u,
  ],
  [
    'suppliers that do not add up',
    'supplyReadiness.total.rejected',
    181,
    /verified \+ rejected must equal evaluated/u,
  ],
  [
    'more products with supply than products',
    'supplyReadiness.launchProductsWithVerifiedSupply',
    34,
    /cannot exceed launch products/u,
  ],
  [
    'more approved partners than applications',
    'partnerProgramme.approved',
    1,
    /approved cannot exceed applications received/u,
  ],
  [
    'more referred than new members',
    'waitlist.joinedThroughReferral',
    1288,
    /cannot exceed new this month/u,
  ],
  [
    'figures counted before their month',
    'waitlist.countedOn',
    '2026-11-30',
    /counted on or after the first day/u,
  ],
  [
    'an impossible date',
    'policyChanges.items.0.date',
    '2026-02-30',
    /policyChanges/u,
  ],
  [
    'a dated list and a none statement at once',
    'corrections',
    { none: 'None.', items: [] },
    /corrections/u,
  ],
  [
    'an email address',
    'whatWentWrong',
    ['Write to someone@example.com about it.'],
    /holds an email address/u,
  ],
  [
    'a web address',
    'focusForNextMonth',
    ['See https://example.com.'],
    /holds a web address/u,
  ],
  [
    'an IP address',
    'whatWeChanged',
    ['Blocked 203.0.113.9.'],
    /holds an IP address/u,
  ],
  ['markup', 'introduction', ['<script>no</script>'], /holds markup/u],
  ['an exclamation mark', 'launchStatus', ['On track!'], /exclamation mark/u],
  [
    'a second line',
    'launchStatus',
    ['On track.\nReally.'],
    /more than one line/u,
  ],
  [
    'a padded line',
    'launchStatus',
    [' On track.'],
    /starts or ends with a space/u,
  ],
];

test('schema validation red paths: every broken entry is refused with its reason', async () => {
  const valid = await fixtureEntry('2026-12');
  for (const [name, path, value, reason] of redPaths) {
    const entry = clone(valid);
    setPath(entry, path, value);
    const problems = trustLedgerEntryProblems(entry);
    assert.ok(problems.length > 0, `${name} is refused`);
    assert.match(problems.join('\n'), reason, name);
  }
  // The second fixture's optional sections are valid too.
  assert.deepEqual(trustLedgerEntryProblems(await fixtureEntry('2027-01')), []);
});

test("from 2027-01 an entry must give the month's supplier figures; before then it may leave them null", async () => {
  // Green path: P11 Part 2's December 2026 entry gives totals only.
  const december = await fixtureEntry('2026-12');
  assert.equal(
    (december.supplyReadiness as { thisMonth: unknown }).thisMonth,
    null,
  );
  assert.deepEqual(trustLedgerEntryProblems(december), []);

  // Red path: January 2027, and any later month, with thisMonth null.
  const january = await fixtureEntry('2027-01');
  assert.deepEqual(trustLedgerEntryProblems(january), []);
  const later = clone(january);
  later.month = '2027-06';
  setPath(later, 'waitlist.countedOn', '2027-07-01');
  assert.deepEqual(trustLedgerEntryProblems(later), []);
  for (const entry of [january, later]) {
    const refused = clone(entry);
    setPath(refused, 'supplyReadiness.thisMonth', null);
    assert.deepEqual(trustLedgerEntryProblems(refused), [
      "supplyReadiness.thisMonth: From 2027-01, supplyReadiness.thisMonth must give the month's own supplier figures (evaluated, verified and rejected), not null.",
    ]);
  }

  // The boundary: the same January entry dated December 2026 may leave it null.
  const beforeJanuary = clone(january);
  beforeJanuary.month = '2026-12';
  setPath(beforeJanuary, 'supplyReadiness.thisMonth', null);
  assert.deepEqual(trustLedgerEntryProblems(beforeJanuary), []);
});

test('the schema cannot represent a supplier name, revenue, margin or person', async () => {
  // Planted fields: each is refused, at the top and inside every section.
  const valid = await fixtureEntry('2026-12');
  const planted: readonly [string, string, unknown][] = [
    ['revenue', 'revenue', 1000],
    ['margin', 'margin', 0.3],
    ['profit', 'profit', 10],
    ['a supplier register', 'suppliers', [{ name: 'Acme' }]],
    ['a supplier name', 'supplyReadiness.total.supplierName', 'Acme'],
    ['a supplier price', 'supplyReadiness.price', 9.99],
    ['a partner name', 'partnerProgramme.names', ['A partner']],
    ['partner earnings', 'partnerProgramme.earnings', 100],
    ['a person', 'waitlist.member', { email: 'a@example.test' }],
    ['a person on an item', 'buildProgress.0.owner', 'Someone'],
    ['a person on a dated item', 'policyChanges.items.0.author', 'Someone'],
  ];
  for (const [name, path, value] of planted) {
    const entry = clone(valid);
    setPath(entry, path, value);
    assert.notDeepEqual(trustLedgerEntryProblems(entry), [], name);
  }

  // And the schema itself: every object is closed, every number is a
  // non-negative integer, and its fields are exactly these.
  const fields = new Set<string>();
  const numbers: string[] = [];
  function walk(node: unknown, path: string): void {
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, path));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const schema = node as Record<string, unknown>;
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false, `${path} is closed`);
    }
    if (schema.type === 'number' || schema.type === 'integer') {
      assert.equal(schema.type, 'integer', `${path} is a count`);
      assert.equal(schema.minimum, 0, `${path} is not negative`);
      numbers.push(path);
    }
    const properties = schema.properties as Record<string, unknown> | undefined;
    for (const [key, child] of Object.entries(properties ?? {})) {
      fields.add(key);
      walk(child, `${path}.${key}`);
    }
    for (const key of ['items', 'anyOf', 'oneOf', 'allOf'])
      if (key in schema) walk(schema[key], path);
  }
  walk(z.toJSONSchema(trustLedgerEntrySchema, { io: 'input' }), 'entry');
  assert.deepEqual([...fields].sort(), [
    'active',
    'applicationsReceived',
    'approved',
    'buildProgress',
    'corrections',
    'countedOn',
    'date',
    'evaluated',
    'focusForNextMonth',
    'howWeCountChanges',
    'introduction',
    'item',
    'items',
    'joinedThroughReferral',
    'launchProducts',
    'launchProductsWithVerifiedSupply',
    'launchStatus',
    'month',
    'newThisMonth',
    'none',
    'note',
    'partnerProgramme',
    'policyChanges',
    'rejected',
    'status',
    'supplyReadiness',
    'text',
    'thisMonth',
    'total',
    'verified',
    'waitlist',
    'whatWeChanged',
    'whatWentWrong',
  ]);
  for (const field of fields)
    assert.doesNotMatch(
      field,
      /name|revenue|margin|profit|price|cost|earning|email|person|customer|address|phone/iu,
      field,
    );
  // Three waitlist counts, three supplier totals and three for the month,
  // two launch-product counts and three partner counts.
  assert.equal(numbers.length, 14);
});

test('an entry file must be named for its own month, and any problem invalidates the whole ledger', async () => {
  const entry = await fixtureEntry('2026-12');
  assert.deepEqual(
    trustLedgerFileProblems({
      'december.json': entry,
      '2026-11.json': entry,
      '2026-12.md': entry,
    }),
    [
      '2026-11.json: its month is 2026-12, not 2026-11',
      '2026-12.md: an entry file is named YYYY-MM.json',
      'december.json: an entry file is named YYYY-MM.json',
    ],
  );
  const broken = clone(entry);
  broken.launchStatus = [];
  assert.throws(
    () =>
      createTrustLedger({
        '2026-12.json': entry,
        '2027-01.json': { ...broken, month: '2027-01' },
      }),
    (error: unknown) =>
      error instanceof TrustLedgerInvalidError &&
      error.problems.some((problem) =>
        problem.startsWith('2027-01.json: launchStatus'),
      ),
  );
});

// ── Ordering and archive ────────────────────────────────────────────────────

test('ordering and archive: every entry renders, newest first, each with its sections in the fixed order', async () => {
  const december = await fixtureEntry('2026-12');
  const january = await fixtureEntry('2027-01');
  const november: Record<string, unknown> = {
    ...clone(december),
    month: '2026-11',
    waitlist: { ...(december.waitlist as object), countedOn: '2026-12-01' },
  };
  // Given in no particular order.
  const ledger = createTrustLedger({
    '2026-12.json': december,
    '2027-01.json': january,
    '2026-11.json': november,
  });
  assert.equal(ledger.published, true);
  const views = trustLedgerView(ledger);
  assert.deepEqual(
    views.map(({ month, heading, newest, id }) => ({
      month,
      heading,
      newest,
      id,
    })),
    [
      {
        month: '2027-01',
        heading: 'January 2027',
        newest: true,
        id: 'trust-ledger-2027-01',
      },
      {
        month: '2026-12',
        heading: 'December 2026',
        newest: false,
        id: 'trust-ledger-2026-12',
      },
      {
        month: '2026-11',
        heading: 'November 2026',
        newest: false,
        id: 'trust-ledger-2026-11',
      },
    ],
  );
  const sections = trustLedgerCopy.sections;
  const fixedOrder = [
    sections.introduction,
    sections.waitlist,
    sections.buildProgress,
    sections.supplyReadiness,
    sections.partnerProgramme,
    sections.policyChanges,
    sections.corrections,
    sections.launchStatus,
    sections.whatWentWrong,
    sections.whatWeChanged,
    sections.focusForNextMonth,
  ];
  assert.deepEqual(
    views[1]?.sections.map(({ heading }) => heading),
    fixedOrder,
  );
  // An entry that changes "How we count" says so, before the launch status.
  assert.deepEqual(
    views[0]?.sections.map(({ heading }) => heading),
    [
      ...fixedOrder.slice(0, 7),
      sections.howWeCountChanges,
      ...fixedOrder.slice(7),
    ],
  );
  // Every heading id is unique across the page.
  const ids = views.flatMap((view) => [
    view.id,
    ...view.sections.map(({ id }) => id),
  ]);
  assert.equal(new Set(ids).size, ids.length);
  // The January figures: the month's own supplier counts, a correction with
  // its date, and a share of zero, all exact.
  const january_ = viewText(views[0] as TrustLedgerEntryView).lines;
  for (const line of [
    'Total: 2,500',
    'New this month: 1,213',
    'Joined through a referral: 0 of 1,213',
    'Suppliers evaluated: 1,210',
    'Suppliers evaluated this month: 3',
    'Verified this month: 3',
    'Rejected this month: 0',
    'Launch products with verified supply: 32 of 34',
    'Applications received: 9',
    '14 January 2027: synthetic correction to an earlier figure.',
    'Synthetic: no policy changed this month.',
    'Synthetic build item one: in progress',
  ])
    assert.ok(january_.includes(line), line);
  assert.equal(createTrustLedger({}).published, false);
  assert.deepEqual(trustLedgerView(createTrustLedger({})), []);
  assert.throws(() => trustLedgerCount(1.5), RangeError);
  assert.equal(trustLedgerCount(1234567), '1,234,567');
});

// ── Flag off ────────────────────────────────────────────────────────────────

const flagsWith = (enabled: boolean | null): Flag[] =>
  enabled === null ? [] : [{ key: 'trust_ledger.page', enabled }];

test('flag off: the page is hidden and the sitemap lists nothing; with no entry it is hidden even with the flag on', async () => {
  assert.equal(campaignFlagRegistry['trust_ledger.page'], false);
  const published = { published: true };
  const empty = { published: false };
  // A lookup that returns nothing falls back to the code default: off.
  assert.equal(trustLedgerPageEnabled(flagsWith(null)), false);
  assert.equal(trustLedgerVisible(flagsWith(null), published), false);
  assert.equal(trustLedgerVisible(flagsWith(false), published), false);
  assert.equal(trustLedgerVisible(flagsWith(true), empty), false);
  assert.equal(trustLedgerVisible(flagsWith(false), empty), false);
  assert.equal(trustLedgerVisible(flagsWith(true), published), true);
  const emptyUrlset =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n';
  assert.equal(trustLedgerSitemapXml(flagsWith(false), published), emptyUrlset);
  assert.equal(trustLedgerSitemapXml(flagsWith(true), empty), emptyUrlset);
  assert.equal(
    trustLedgerSitemapXml(flagsWith(true), published),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://valstara.com/trust-ledger</loc></url>\n</urlset>\n',
  );
  assert.equal(trustLedgerCacheControl, 'private, no-store');
  // The static index always lists the child sitemap; the static pages
  // sitemap never lists the page.
  assert.equal(childSitemaps.trustLedger, '/sitemaps/trust-ledger.xml');
  assert.equal(
    sitemapPaths(['src/pages/trust-ledger.astro', 'src/pages/about.astro'], [])
      .length,
    1,
  );
  // The footer link is copy that renders only with a committed entry.
  assert.deepEqual(layoutCopy.trustLedgerFooterLink, {
    group: 'company',
    href: '/trust-ledger',
    label: 'Trust Ledger',
  });
  assert.equal(
    (layoutCopy.footerLinks as readonly { href: string }[]).some(
      (link) => link.href === '/trust-ledger',
    ),
    false,
  );
  // This ticket commits no entry (D-076 Q2): the repository's own ledger is
  // empty, so no link renders and the page answers 404 until December.
  const committed = (await readdir('src/content/trust-ledger')).filter(
    (name) => !name.startsWith('.'),
  );
  assert.deepEqual(committed, []);
});

// ── The draft ───────────────────────────────────────────────────────────────

const figuresBody = {
  month: '2026-12',
  counted_at: '2027-01-02T09:00:00.000Z',
  verified_total: 1287,
  verified_in_month: 1287,
  verified_in_month_through_referral: 412,
};

test('the draft holds the counts and empty sections, fails the schema until completed, and is formatted as Prettier writes it', async () => {
  const figures = readTrustLedgerFigures(figuresBody, '2026-12');
  assert.ok(figures);
  for (const body of [
    { ...figuresBody, month: '2026-11' },
    { ...figuresBody, counted_at: 'yesterday' },
    { ...figuresBody, verified_total: -1 },
    { ...figuresBody, verified_in_month: 1.5 },
    { ...figuresBody, verified_in_month_through_referral: 1288 },
    { ...figuresBody, verified_total: 10 },
  ])
    assert.equal(readTrustLedgerFigures(body, '2026-12'), null);
  const draft = trustLedgerDraft(figures);
  assert.deepEqual(draft.waitlist, {
    countedOn: '2027-01-02',
    total: 1287,
    newThisMonth: 1287,
    joinedThroughReferral: 412,
  });
  // Every key in the schema's order, every founder section still empty.
  assert.deepEqual(Object.keys(draft), [
    'month',
    'introduction',
    'waitlist',
    'buildProgress',
    'supplyReadiness',
    'partnerProgramme',
    'policyChanges',
    'corrections',
    'launchStatus',
    'whatWentWrong',
    'whatWeChanged',
    'focusForNextMonth',
  ]);
  const problems = trustLedgerEntryProblems(draft);
  for (const section of [
    'introduction',
    'buildProgress',
    'supplyReadiness.total.evaluated',
    'partnerProgramme.active',
    'launchStatus',
    'focusForNextMonth',
  ])
    assert.ok(
      problems.some((problem) => problem.startsWith(section)),
      `${section} must be completed`,
    );
  // Completed with P11 Part 2's sections, it is the entry.
  const completed = {
    ...(await fixtureEntry('2026-12')),
    waitlist: draft.waitlist,
  };
  assert.deepEqual(trustLedgerEntryProblems(completed), []);
  const source = trustLedgerDraftSource(figures);
  assert.equal(
    await prettier.check(source, { parser: 'json', filepath: '2026-12.json' }),
    true,
  );
});

// ── The prebuild check ──────────────────────────────────────────────────────

test('an entry that fails its schema fails the build: the check runs before every build', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    packageJson.scripts.prebuild ?? '',
    /tsx scripts\/ci\/trust-ledger-check\.ts/u,
  );
  const script = resolve('scripts/ci/trust-ledger-check.ts');
  const tsx = resolve('node_modules/.bin/tsx');
  const root = await mkdtemp(join(tmpdir(), 'valstara-ledger-build-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await copyFile(
      'scripts/forbidden-copy.json',
      join(root, 'scripts/forbidden-copy.json'),
    );
    // No folder at all, and a folder with only its placeholder, hold none.
    await run(tsx, [script], { cwd: root });
    const folder = join(root, 'src/content/trust-ledger');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, '.gitkeep'), '\n');
    await run(tsx, [script], { cwd: root });
    await copyFile(
      join(fixtureDirectory, '2026-12.json'),
      join(folder, '2026-12.json'),
    );
    await run(tsx, [script], { cwd: root });
    const broken = await fixtureEntry('2027-01');
    broken.launchStatus = [];
    await writeFile(join(folder, '2027-01.json'), JSON.stringify(broken));
    await writeFile(join(folder, 'notes.txt'), 'draft');
    await assert.rejects(run(tsx, [script], { cwd: root }), (error: Error) => {
      const stderr = String((error as Error & { stderr?: string }).stderr);
      assert.match(stderr, /A Trust Ledger entry failed its checks/u);
      assert.match(stderr, /2027-01\.json: launchStatus/u);
      assert.match(stderr, /notes\.txt: an entry file is named YYYY-MM\.json/u);
      return true;
    });
    // A forbidden-copy term fails the build, not only the CI scan.
    await rm(join(folder, 'notes.txt'));
    const term = (
      JSON.parse(await readFile('scripts/forbidden-copy.json', 'utf8')) as {
        entries: { term: string }[];
      }
    ).entries[0]?.term;
    assert.ok(term);
    const worded = await fixtureEntry('2027-01');
    worded.launchStatus = [`We are ${term} on track.`];
    await writeFile(join(folder, '2027-01.json'), JSON.stringify(worded));
    await assert.rejects(run(tsx, [script], { cwd: root }), (error: Error) => {
      assert.match(
        String((error as Error & { stderr?: string }).stderr),
        new RegExp(`2027-01\\.json: forbidden copy "${term}"`, 'u'),
      );
      return true;
    });
    await writeFile(join(folder, '2027-01.json'), '{ not json');
    await assert.rejects(run(tsx, [script], { cwd: root }), /not valid JSON/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── The append-only guard ───────────────────────────────────────────────────

test('the append-only guard fails a changed or deleted published entry, planted on a branch, and allows a new one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-ledger-history-'));
  const folder = join(root, 'src/content/trust-ledger');
  const howWeCount = join(root, 'src/content/trust-ledger-how-we-count.md');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root }).toString('utf8').trim();
  const commit = (message: string) => {
    git('add', '-A');
    git(
      '-c',
      'user.name=Ledger Test',
      '-c',
      'user.email=ledger@example.test',
      'commit',
      '-qm',
      message,
    );
  };
  const issues = (base?: string) =>
    scanTrustLedgerAppendOnly({ root, base }).map(
      ({ path, message, scan }) => ({ path, message, scan }),
    );
  const december = await readFile(join(fixtureDirectory, '2026-12.json'));
  const january = await fixtureEntry('2027-01');
  try {
    await mkdir(folder, { recursive: true });
    git('init', '-q', '-b', 'main');
    await writeFile(join(folder, '2026-12.json'), december);
    await copyFile('src/content/trust-ledger-how-we-count.md', howWeCount);
    commit('publish');
    assert.deepEqual(issues(), []);

    // A branch adds the next month: allowed.
    git('switch', '-q', '-c', 'next-month');
    const withoutAnnouncement = clone(january);
    delete withoutAnnouncement.howWeCountChanges;
    await writeFile(
      join(folder, '2027-01.json'),
      JSON.stringify(withoutAnnouncement),
    );
    commit('add january');
    assert.deepEqual(issues('main'), []);

    // A planted change to the published entry, committed on the branch.
    const planted = Buffer.from(
      december.toString('utf8').replace('"total": 1287', '"total": 1288'),
    );
    assert.notDeepEqual(planted, december);
    await writeFile(join(folder, '2026-12.json'), planted);
    commit('edit december');
    assert.deepEqual(issues('main'), [
      {
        path: 'src/content/trust-ledger/2026-12.json',
        message:
          'a published Trust Ledger entry was edited; correct it in the next entry instead',
        scan: 'trust-ledger-append-only',
      },
    ]);
    // Even a whitespace-only change is a change.
    await writeFile(join(folder, '2026-12.json'), `${december.toString()}\n`);
    assert.equal(issues('main').length, 1);
    git('checkout', '-q', '--', '.');
    // A deletion, uncommitted, compared with HEAD as `npm run check` does.
    git('checkout', '-q', 'main');
    await rm(join(folder, '2026-12.json'));
    assert.deepEqual(
      issues().map(({ message }) => message),
      ['a published Trust Ledger entry was deleted'],
    );
    git('checkout', '-q', '--', '.');
    assert.deepEqual(issues(), []);

    // "How we count" changes only with a new entry that announces it.
    git('switch', '-q', '-c', 'definitions');
    await writeFile(
      howWeCount,
      `${await readFile(howWeCount, 'utf8')}\nA changed definition.\n`,
    );
    commit('change how we count');
    assert.deepEqual(
      issues('main').map(({ path, message }) => ({ path, message })),
      [
        {
          path: 'src/content/trust-ledger-how-we-count.md',
          message:
            '"How we count" changed without a new entry that announces the change in howWeCountChanges',
        },
      ],
    );
    // A new entry that does not announce it is not enough.
    await writeFile(
      join(folder, '2027-01.json'),
      JSON.stringify(withoutAnnouncement),
    );
    commit('add january without the announcement');
    assert.equal(issues('main').length, 1);
    // The new entry announcing the change makes it allowed.
    await writeFile(join(folder, '2027-01.json'), JSON.stringify(january));
    commit('announce the change');
    assert.deepEqual(issues('main'), []);
    // A published entry announcing an old change does not cover a new one.
    git('switch', '-q', 'main');
    git('merge', '-q', '--ff-only', 'definitions');
    git('switch', '-q', '-c', 'later');
    await writeFile(
      howWeCount,
      `${await readFile(howWeCount, 'utf8')}\nAnother change.\n`,
    );
    commit('change again');
    assert.equal(issues('main').length, 1);
    await rm(howWeCount);
    commit('delete');
    assert.deepEqual(
      issues('main').map(({ message }) => message),
      ['"How we count" was deleted'],
    );
    // This repository passes the check against its own HEAD.
    assert.deepEqual(scanTrustLedgerAppendOnly({ root: process.cwd() }), []);
    // An unresolvable base is reported, never passed.
    assert.match(
      issues('no-such-branch')[0]?.message ?? '',
      /could not resolve the revision/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── The waitlist figures against seeded data ────────────────────────────────

const now = new Date('2027-01-02T09:00:00.000Z');
const clock = () => now;
let fixture: PartnerFixture;

before(async () => {
  fixture = await createPartnerFixture('trust-ledger');
});

after(async () => {
  await fixture?.dispose();
});

async function verified(at: string): Promise<string> {
  return (await insertMember(fixture, { at: new Date(at) })).id;
}

async function edge(
  referrerId: string,
  referredId: string,
  options: {
    readonly state?: 'attributed' | 'confirmed' | 'rejected';
    readonly voided?: boolean;
    readonly partnerId?: string;
  } = {},
): Promise<void> {
  const state = options.state ?? 'confirmed';
  await fixture.owner.execute({
    text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state,
        reward_state, rejected_reason, confirmed_at, voided_at, void_reason,
        voided_by, partner_id, attribution_method, welcome_discount_pct)
      VALUES ($1, $2, $3, $4,
        CASE WHEN $4 = 'confirmed' THEN 'settled' ELSE 'none' END,
        CASE WHEN $4 = 'rejected' THEN 'self_referral' END,
        CASE WHEN $4 <> 'attributed' THEN now() END,
        CASE WHEN $5::boolean THEN now() END,
        CASE WHEN $5::boolean THEN 'Test void' END,
        CASE WHEN $5::boolean THEN 'admin.operator' END,
        $6::uuid,
        CASE WHEN $6::uuid IS NULL THEN 'link' ELSE 'code' END,
        CASE WHEN $6::uuid IS NULL THEN NULL ELSE 10 END)`,
    values: [
      randomUUID(),
      referrerId,
      referredId,
      state,
      options.voided === true,
      options.partnerId ?? null,
    ],
  });
}

interface Seeded {
  readonly total: number;
  readonly december: number;
  readonly decemberReferred: number;
  readonly ids: readonly string[];
}

async function seed(): Promise<Seeded> {
  const ids: string[] = [];
  // Before and after December, and on both of its edges.
  const referrer = await verified('2026-10-15T12:00:00.000Z');
  ids.push(referrer, await verified('2026-11-30T23:59:59.999Z'));
  ids.push(await verified('2027-01-01T00:00:00.000Z'));
  const first = await verified('2026-12-01T00:00:00.000Z');
  const last = await verified('2026-12-31T23:59:59.999Z');
  ids.push(first, last);
  // December, through a member's link: counted as referred.
  const linked = await verified('2026-12-05T10:00:00.000Z');
  await edge(referrer, linked);
  // December, through a partner's code: a referral too (P11 Part 1).
  const partner = await insertPartner(fixture, { status: 'active' });
  const coded = await verified('2026-12-06T10:00:00.000Z');
  await edge(partner.subscriberId, coded, { partnerId: partner.id });
  // December, but the referral was voided, rejected or never confirmed.
  const voided = await verified('2026-12-07T10:00:00.000Z');
  await edge(referrer, voided, { voided: true });
  const rejected = await verified('2026-12-08T10:00:00.000Z');
  await edge(referrer, rejected, { state: 'rejected' });
  const unconfirmed = await verified('2026-12-09T10:00:00.000Z');
  await edge(referrer, unconfirmed, { state: 'attributed' });
  ids.push(linked, coded, voided, rejected, unconfirmed, partner.subscriberId);
  // Unverified, or no longer a member: never counted, even when referred.
  const pending = (
    await insertMember(fixture, {
      status: 'pending',
      at: new Date('2026-12-10T10:00:00.000Z'),
    })
  ).id;
  await edge(referrer, pending, { state: 'attributed' });
  await insertMember(fixture, {
    status: 'expired',
    at: new Date('2026-12-11T10:00:00.000Z'),
  });
  const left = await verified('2026-12-12T10:00:00.000Z');
  await edge(referrer, left);
  await fixture.owner.execute({
    text: `UPDATE subscriber SET status = 'unsubscribed',
      unsubscribed_at = '2026-12-20T10:00:00Z' WHERE id = $1`,
    values: [left],
  });
  return {
    // The referrer, 30 Nov, 1 Jan, 1 Dec, 31 Dec, the five referred in
    // December and the partner's own member row (verified 1 November).
    total: 11,
    // 1 Dec, 31 Dec, and the five referred.
    december: 7,
    // The member link and the partner code.
    decemberReferred: 2,
    ids,
  };
}

async function audits(): Promise<{ actor: string; detail: unknown }[]> {
  return fixture.owner.list<{ actor: string; detail: unknown }>(
    {
      text: `SELECT actor, detail FROM audit_log
        WHERE action = 'trust_ledger.waitlist_counted' ORDER BY at, id`,
    },
    100,
  ) as Promise<{ actor: string; detail: unknown }[]>;
}

let seeded: Seeded | undefined;

test('the waitlist figures reconcile exactly with a seeded database, count only verified members, and count partner codes as referrals', async () => {
  seeded ??= await seed();
  const service = createTrustLedgerFiguresService(fixture.app, { clock });
  const before_ = (await audits()).length;
  const figures = await service.figures({
    month: '2026-12',
    actor: 'founder:test',
  });
  assert.deepEqual(figures, {
    month: '2026-12',
    countedAt: now,
    verifiedTotal: seeded.total,
    verifiedInMonth: seeded.december,
    verifiedInMonthThroughReferral: seeded.decemberReferred,
  });
  // The same counts the plain definitions give, computed independently.
  const independent = await fixture.owner.readOne<{
    total: number;
    month: number;
  }>({
    text: `SELECT
        (SELECT count(*)::int FROM subscriber WHERE status = 'verified') AS total,
        (SELECT count(*)::int FROM subscriber WHERE status = 'verified'
          AND verified_at >= '2026-12-01T00:00:00Z'
          AND verified_at < '2027-01-01T00:00:00Z') AS month`,
  });
  assert.deepEqual(independent, {
    total: seeded.total,
    month: seeded.december,
  });
  // November and January have their own counts.
  const november = await service.figures({
    month: '2026-11',
    actor: 'founder:test',
  });
  // 30 November, and the partner's own member row (1 November).
  assert.equal(november.verifiedInMonth, 2);
  assert.equal(november.verifiedInMonthThroughReferral, 0);
  const january = await service.figures({
    month: '2027-01',
    actor: 'founder:test',
  });
  assert.equal(january.verifiedInMonth, 1);
  // Each read is audited with the actor, the month and the counts, and the
  // audit names no one.
  const recorded = (await audits()).slice(before_);
  assert.deepEqual(recorded[0], {
    actor: 'founder:test',
    detail: {
      month: '2026-12',
      counted_at: now.toISOString(),
      verified_total: seeded.total,
      verified_in_month: seeded.december,
      verified_in_month_through_referral: seeded.decemberReferred,
    },
  });
  assert.equal(recorded.length, 3);
  const serialised = JSON.stringify([figures, recorded]);
  assert.doesNotMatch(serialised, /@/u);
  for (const id of seeded.ids) assert.equal(serialised.includes(id), false);
  assert.deepEqual(trustLedgerMonthRange('2026-12'), {
    start: new Date('2026-12-01T00:00:00.000Z'),
    end: new Date('2027-01-01T00:00:00.000Z'),
  });
});

test('the waitlist figures are refused for a malformed or future month or a system actor, and nothing is audited', async () => {
  const service = createTrustLedgerFiguresService(fixture.app, { clock });
  const before_ = (await audits()).length;
  for (const [month, actor, refusal] of [
    ['2026-13', 'founder:test', 'month'],
    ['December', 'founder:test', 'month'],
    ['2027-02', 'founder:test', 'future_month'],
    ['2026-12', 'system:maintenance', 'actor'],
    ['2026-12', ' ', 'actor'],
  ] as const) {
    await assert.rejects(
      service.figures({ month, actor }),
      (error: unknown) =>
        error instanceof TrustLedgerFiguresRefusedError &&
        error.refusal === refusal,
      `${month} ${actor}`,
    );
  }
  assert.equal((await audits()).length, before_);
  // The month the clock is in has begun, so it has figures.
  await service.figures({ month: '2027-01', actor: 'founder:test' });
  assert.equal((await audits()).length, before_ + 1);
});

test('the route shapes counts only, refuses any other query, and never forwards a database error', async () => {
  const fake = (result: () => Promise<never> | ReturnType<typeof okFigures>) =>
    createTrustLedgerFiguresHandler({ figures: result });
  const okFigures = async () => ({
    month: '2026-12',
    countedAt: now,
    verifiedTotal: 3,
    verifiedInMonth: 2,
    verifiedInMonthThroughReferral: 1,
  });
  const ok = await fake(okFigures)({
    actor: adminActor,
    url: new URL(
      'https://valstara.com/api/admin/trust-ledger/waitlist?month=2026-12',
    ),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await ok.json(), {
    month: '2026-12',
    counted_at: now.toISOString(),
    verified_total: 3,
    verified_in_month: 2,
    verified_in_month_through_referral: 1,
  });
  for (const query of [
    '',
    '?month=2026-12&month=2026-11',
    '?month=2026-12&x=1',
    '?from=2026-12',
  ])
    assert.deepEqual(
      await (
        await fake(okFigures)({
          actor: adminActor,
          url: new URL(
            `https://valstara.com/api/admin/trust-ledger/waitlist${query}`,
          ),
        })
      ).json(),
      {
        error: {
          code: 'invalid_input',
          message: adminCopy.trustLedgerFigures.query,
        },
      },
    );
  const unavailable = await fake(async () => {
    throw new DatabaseUnavailableError(
      new Error('connection refused at 10.0.0.1'),
    );
  })({
    actor: adminActor,
    url: new URL(
      'https://valstara.com/api/admin/trust-ledger/waitlist?month=2026-12',
    ),
  });
  assert.equal(unavailable.status, 503);
  const text = await unavailable.text();
  assert.doesNotMatch(text, /10\.0\.0\.1|refused/u);
  assert.match(text, /temporarily unavailable/u);
});

// ── Admin authentication and audit ──────────────────────────────────────────

const credential = 'test-admin-credential-with-32-characters';
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const code = generateTotp(totpSecret, now);

async function adminServer(): Promise<{
  origin: string;
  requests: () => number;
  close(): Promise<void>;
}> {
  const route = createTrustLedgerFiguresRoute(
    createTrustLedgerFiguresService(fixture.app, { clock }),
  );
  const middleware = createAdminAuthMiddleware(
    createAdminAuthenticator({ credential, totpSecret }, clock),
  );
  let count = 0;
  const server: Server = createServer(async (incoming, outgoing) => {
    count += 1;
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (typeof value === 'string') headers.set(key, value);
    const request = new Request(url, { method: incoming.method, headers });
    const locals = {};
    const response = await middleware({ locals, request, url }, async () =>
      request.method === 'GET' &&
      url.pathname === '/api/admin/trust-ledger/waitlist'
        ? route({ locals, params: {}, request, url } as unknown as APIContext)
        : new Response(null, { status: 404 }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests: () => count,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function io(typed: string) {
  const lines: string[] = [];
  const prompts: string[] = [];
  return {
    lines,
    prompts,
    io: {
      async prompt(question: string) {
        prompts.push(question);
        return typed;
      },
      write(line: string) {
        lines.push(line);
      },
      writeChunk() {},
    },
  };
}

test('admin authentication and audit: the route and the draft command are refused without the authenticator code, and each run is audited as the operator', async (t) => {
  seeded ??= await seed();
  const server = await adminServer();
  t.after(() => server.close());
  const directory = await mkdtemp(join(tmpdir(), 'valstara-ledger-draft-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const commandLine = trustLedgerCommandLine(directory);
  const environment = {
    ADMIN_API_ORIGIN: server.origin,
    ADMIN_CREDENTIAL: credential,
  };
  const draft = ['trust-ledger', 'draft', '--month', '2026-12'];
  assert.deepEqual(
    adminRouteRegistry.find(
      (entry) => entry.pathname === '/api/admin/trust-ledger/waitlist',
    ),
    {
      source: 'src/pages/api/admin/trust-ledger/waitlist.ts',
      pathname: '/api/admin/trust-ledger/waitlist',
      methods: [{ method: 'GET', audit: 'required' }],
    },
  );
  // The founder command is its own command line: the admin command line,
  // which never touches the file system, does not carry it.
  assert.equal(adminCommands['trust-ledger draft'], undefined);
  assert.equal(
    defaultTrustLedgerDirectory,
    resolve('src/content/trust-ledger') + '/',
  );
  const before_ = (await audits()).length;

  // At the command line, no code or a malformed one sends nothing and writes
  // nothing.
  for (const typed of ['', '12345', 'abcdef']) {
    const terminal = io(typed);
    await assert.rejects(
      runAdminCommand(draft, environment, terminal.io, fetch, commandLine),
      (error: unknown) =>
        error instanceof AdminCommandError &&
        /A six-digit authenticator code is required\. Nothing was sent\./u.test(
          error.message,
        ),
    );
    assert.deepEqual(terminal.lines, []);
  }
  assert.equal(server.requests(), 0);
  // A missing or malformed month is refused before anything is asked.
  for (const args of [
    ['trust-ledger', 'draft'],
    ['trust-ledger', 'draft', '--month', '2026-13'],
    ['trust-ledger', 'draft', '--month', '2026-12', '--force'],
  ]) {
    const terminal = io(code);
    await assert.rejects(
      runAdminCommand(args, environment, terminal.io, fetch, commandLine),
      /Name the month: --month YYYY-MM\./u,
    );
    assert.deepEqual(terminal.prompts, []);
  }

  // At the API, a missing or wrong code is 401, and nothing is audited.
  for (const totp of [null, '000000']) {
    const response = await fetch(
      new URL('/api/admin/trust-ledger/waitlist?month=2026-12', server.origin),
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          ...(totp === null ? {} : { 'X-Valstara-TOTP': totp }),
        },
      },
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'unauthorized');
  }
  const wrongKey = await fetch(
    new URL('/api/admin/trust-ledger/waitlist?month=2026-12', server.origin),
    { headers: { Authorization: 'Bearer wrong', 'X-Valstara-TOTP': code } },
  );
  assert.equal(wrongKey.status, 401);
  assert.equal((await audits()).length, before_);
  assert.deepEqual(await readdir(directory), []);

  // With the code: the command writes the entry with the exact counts, and
  // the read is audited as the authenticated operator.
  const terminal = io(code);
  await runAdminCommand(draft, environment, terminal.io, fetch, commandLine);
  assert.deepEqual(terminal.lines, [
    'Wrote src/content/trust-ledger/2026-12.json with the waitlist figures counted at 2027-01-02T09:00:00.000Z:',
    `total ${seeded.total}, new this month ${seeded.december}, joined through a referral ${seeded.decemberReferred}.`,
    'Complete every other section, then make the checks in docs/features/trust-ledger.md before publishing.',
  ]);
  assert.deepEqual(await readdir(directory), ['2026-12.json']);
  const written = await readFile(join(directory, '2026-12.json'), 'utf8');
  const entry = JSON.parse(written) as ReturnType<typeof trustLedgerDraft>;
  assert.deepEqual(entry.waitlist, {
    countedOn: '2027-01-02',
    total: seeded.total,
    newThisMonth: seeded.december,
    joinedThroughReferral: seeded.decemberReferred,
  });
  // The file holds counts and empty sections: no key, no code, no person.
  assert.equal(written.includes(credential), false);
  assert.equal(written.includes(code), false);
  assert.doesNotMatch(written, /@|counted_at|verified_total/u);
  for (const id of seeded.ids) assert.equal(written.includes(id), false);
  const recorded = (await audits()).slice(before_);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.actor, adminActor);

  // A second run refuses the existing entry before asking for anything or
  // sending a request, so nothing more is audited and the file is unchanged.
  const requests = server.requests();
  const again = io(code);
  await assert.rejects(
    runAdminCommand(draft, environment, again.io, fetch, commandLine),
    /An entry for 2026-12 already exists in src\/content\/trust-ledger\/\. A published entry never changes\. Nothing was written\./u,
  );
  assert.deepEqual(again.prompts, []);
  assert.equal(server.requests(), requests);
  assert.equal((await audits()).length, before_ + 1);
  assert.equal(
    await readFile(join(directory, '2026-12.json'), 'utf8'),
    written,
  );

  // A file that appears while the request runs is never overwritten.
  const raced = io(code);
  await assert.rejects(
    runAdminCommand(
      ['trust-ledger', 'draft', '--month', '2026-11'],
      environment,
      raced.io,
      async (input, init) => {
        await writeFile(join(directory, '2026-11.json'), 'the founder’s own');
        return fetch(input, init);
      },
      commandLine,
    ),
    /An entry for 2026-11 already exists/u,
  );
  assert.equal(
    await readFile(join(directory, '2026-11.json'), 'utf8'),
    'the founder’s own',
  );

  // A refused month at the API writes nothing.
  const future = io(code);
  await assert.rejects(
    runAdminCommand(
      ['trust-ledger', 'draft', '--month', '2027-02'],
      environment,
      future.io,
      fetch,
      commandLine,
    ),
    new RegExp(
      `invalid_input: ${adminCopy.trustLedgerFigures.futureMonth}`,
      'u',
    ),
  );
  assert.deepEqual((await readdir(directory)).sort(), [
    '2026-11.json',
    '2026-12.json',
  ]);
});

test('the draft command loads under plain Node, as the founder runs it', async () => {
  // The command line runs .ts under Node's type stripping, which accepts
  // erasable syntax only (memory: node-type-stripping-erasable-only).
  await run(process.execPath, [
    '--import',
    './src/server/trust-ledger/cli.ts',
    '-e',
    '0',
  ]);
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['trust-ledger'],
    'node ./src/server/trust-ledger/cli.ts',
  );
});
