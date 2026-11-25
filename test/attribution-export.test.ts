// E11.7-14: the attribution export. Its Tests line: idempotency · schema
// validation · graph completeness with voids · coupon and discount fields ·
// the document–export reconciliation. The database tests run against a real,
// migrated scratch database and the real command line.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type {
  AttributionExportSnapshot,
  AttributionReferralRow,
} from '../src/server/db/attribution-export.ts';
import {
  AttributionExportIntegrityError,
  attributionExportFields,
  attributionExportFiles,
  attributionExportSections,
  csvLine,
  exportAttribution,
  jsonRecord,
  referralRecord,
  type AttributionExportFile,
  type AttributionRecordKind,
} from '../src/server/partner/attribution-export.ts';
import {
  couponExpiresAt,
  couponLadder,
} from '../src/server/referral/config.ts';

import {
  createPartnerFixture,
  insertMember,
  insertPartner,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const run = promisify(execFile);
const actor = 'founder:test';
const expiry = '2032-10-01T00:00:00.000Z';
const kinds = Object.keys(attributionExportSections) as AttributionRecordKind[];
type Json = Record<string, unknown>;

// ---------------------------------------------------------------- fixtures

async function member(
  f: PartnerFixture,
  options: {
    readonly status?: string;
    readonly wave?: string;
    readonly at?: Date;
  } = {},
): Promise<string> {
  const { id } = await insertMember(f, {
    status: options.status ?? 'verified',
    ...(options.at === undefined ? {} : { at: options.at }),
  });
  await f.owner.execute({
    text: 'UPDATE subscriber SET access_window = $2 WHERE id = $1',
    values: [id, options.wave ?? 'wave-3'],
  });
  return id;
}

async function partner(
  f: PartnerFixture,
  status: 'approved' | 'active' | 'paused' | 'terminated' | 'rejected',
  partnerType = 'creator',
): Promise<{ id: string; subscriberId: string; code: string | null }> {
  const inserted = await insertPartner(f, { status, partnerType });
  await f.owner.execute({
    text: "UPDATE subscriber SET access_window = 'wave-1' WHERE id = $1",
    values: [inserted.subscriberId],
  });
  // The approval record `partner.approved` writes in the same transaction.
  await f.owner.execute({
    text: `INSERT INTO audit_log (id, at, actor, action, subject_type, subject_id, detail)
      VALUES ($1, '2026-11-03T09:00:00Z', $2, 'partner.approved', 'partner', $3,
        jsonb_build_object('after', jsonb_build_object(
          'status', 'approved', 'status_changed_at', '2026-11-03T09:00:00.000Z')))`,
    values: [randomUUID(), actor, inserted.id],
  });
  return inserted;
}

async function edge(
  f: PartnerFixture,
  referrerId: string,
  referredId: string,
  options: {
    readonly state?: 'attributed' | 'confirmed' | 'rejected';
    readonly partnerId?: string;
    readonly discount?: number;
    readonly method?: 'link' | 'code' | 'retroactive';
    readonly voided?: boolean;
    readonly rejectedReason?: string;
    readonly stateBeforeRejection?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const state = options.state ?? 'confirmed';
  await f.owner.execute({
    text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state,
        reward_state, created_at, confirmed_at, voided_at, void_reason, voided_by,
        partner_id, attribution_method, welcome_discount_pct, rejected_reason,
        state_before_rejection)
      VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'attributed' THEN 'none' ELSE 'settled' END,
        '2026-11-05T10:00:00Z',
        CASE WHEN $4 = 'attributed' THEN NULL ELSE '2026-11-05T10:01:00Z'::timestamptz END,
        CASE WHEN $5::boolean THEN '2026-11-06T10:00:00Z'::timestamptz END,
        CASE WHEN $5::boolean THEN 'Duplicate household, "same" card' END,
        CASE WHEN $5::boolean THEN 'admin.operator' END,
        $6, $7, $8, $9, $10)`,
    values: [
      id,
      referrerId,
      referredId,
      state,
      options.voided === true,
      options.partnerId ?? null,
      options.method ?? 'link',
      options.discount ?? null,
      options.rejectedReason ?? null,
      options.stateBeforeRejection ?? null,
    ],
  });
  return id;
}

async function coupon(
  f: PartnerFixture,
  ownerId: string,
  number: number,
  percent: number | null,
): Promise<string> {
  const id = randomUUID();
  await f.owner.execute({
    text: `INSERT INTO referral_coupon (id, subscriber_id, coupon_number, percent,
        state, created_at, updated_at)
      VALUES ($1, $2, $3, $4::smallint, CASE WHEN $4::smallint IS NULL THEN 'void' ELSE 'held' END,
        '2026-11-07T10:00:00Z', '2026-11-07T10:00:00Z')`,
    values: [id, ownerId, number, percent],
  });
  return id;
}

async function suppress(f: PartnerFixture, subscriberId: string) {
  await f.owner.execute({
    text: `INSERT INTO suppression (email_normalised, reason, source)
      SELECT email_normalised, 'manual', 'test' FROM subscriber WHERE id = $1`,
    values: [subscriberId],
  });
}

interface Graph {
  readonly partners: {
    readonly active: string;
    readonly paused: string;
    readonly terminated: string;
    readonly suppressed: string;
    readonly excluded: readonly string[];
  };
  readonly exportedEdges: {
    readonly partnerLink: string;
    readonly partnerCodeVoided: string;
    readonly retroactive: string;
    readonly ambassador: string;
    readonly member: string;
    readonly memberVoided: string;
    readonly suppressedPartnerEdge: string;
  };
  readonly excludedEdges: readonly string[];
  readonly memberId: string;
  readonly heldCoupons: readonly string[];
  readonly excludedCoupons: readonly string[];
  readonly welcomeDiscounts: Readonly<Record<string, number>>;
  readonly outsideSet: readonly string[];
}

/**
 * One attribution graph covering every inclusion rule: partner edges by each
 * method, member edges, voids, edges and people outside the export set, a
 * contracted partner whose address is suppressed (D-073 Q3), held and void
 * coupons, and both kinds of separately carried welcome discount.
 */
async function seedGraph(f: PartnerFixture): Promise<Graph> {
  const active = await partner(f, 'active');
  await f.owner.execute({
    text: `UPDATE partner SET display_name = 'Maya, "M" Example' WHERE id = $1`,
    values: [active.id],
  });
  const paused = await partner(f, 'paused', 'student_ambassador');
  const terminated = await partner(f, 'terminated');
  const approved = await partner(f, 'approved');
  const rejected = await partner(f, 'rejected');
  const suppressedPartner = await partner(f, 'active');
  await suppress(f, suppressedPartner.subscriberId);
  const disqualifiedPartner = await partner(f, 'active');
  await f.owner.execute({
    text: `UPDATE subscriber SET status = 'disqualified', disqualified_at = '2026-11-08T10:00:00Z',
      disqualification_previous_status = 'verified' WHERE id = $1`,
    values: [disqualifiedPartner.subscriberId],
  });
  // A contracted partner whose member record left the waitlist.
  const departedPartner = await partner(f, 'active');
  await f.owner.execute({
    text: `UPDATE subscriber SET status = 'unsubscribed' WHERE id = $1`,
    values: [departedPartner.subscriberId],
  });

  const memberId = await member(f, { wave: 'wave-2' });
  const friend = () => member(f, { wave: 'wave-1' });
  const partnerLink = await edge(f, active.subscriberId, await friend(), {
    partnerId: active.id,
    discount: 10,
    method: 'link',
  });
  const partnerCodeVoided = await edge(f, active.subscriberId, await friend(), {
    partnerId: active.id,
    discount: 15,
    method: 'code',
    voided: true,
  });
  const retroactive = await edge(f, active.subscriberId, await friend(), {
    partnerId: active.id,
    discount: 20,
    method: 'retroactive',
  });
  const ambassador = await edge(f, paused.subscriberId, await friend(), {
    partnerId: paused.id,
    discount: 15,
  });
  const memberEdge = await edge(f, memberId, await member(f), {
    method: 'code',
  });
  const memberVoided = await edge(f, memberId, await member(f), {
    voided: true,
  });
  // D-073 Q3: the partner contract, not mail consent, carries the partner
  // edge of a verified partner whose address is suppressed; the friend's
  // discount travels on the edge.
  const suppressedFriend = await friend();
  const suppressedPartnerEdge = await edge(
    f,
    suppressedPartner.subscriberId,
    suppressedFriend,
    { partnerId: suppressedPartner.id, discount: 20 },
  );

  const pending = await member(f, { status: 'pending' });
  const unsubscribed = await member(f, { status: 'unsubscribed' });
  const departedFriend = await member(f, {
    status: 'unsubscribed',
    wave: 'wave-1',
  });
  const excludedEdges = [
    // Waiting on the referred person's confirmation.
    await edge(f, memberId, pending, { state: 'attributed' }),
    // Rejected by fraud review.
    await edge(f, memberId, await member(f), {
      state: 'rejected',
      rejectedReason: 'duplicate_identity',
      stateBeforeRejection: 'confirmed',
    }),
    // The referred person left the waitlist.
    await edge(f, memberId, unsubscribed),
    // The partner left the waitlist: the friend keeps the discount.
    await edge(f, departedPartner.subscriberId, await friend(), {
      partnerId: departedPartner.id,
      discount: 20,
    }),
    // The partner was disqualified: the edge is rejected, the perk kept.
    await edge(f, disqualifiedPartner.subscriberId, await friend(), {
      state: 'rejected',
      rejectedReason: 'referrer_disqualified',
      stateBeforeRejection: 'confirmed',
      partnerId: disqualifiedPartner.id,
      discount: 10,
    }),
    // A suppressed partner's member edge follows the member rule: out.
    await edge(f, suppressedPartner.subscriberId, await member(f)),
    // A suppressed partner's partner edge to a friend outside the set.
    await edge(f, suppressedPartner.subscriberId, departedFriend, {
      partnerId: suppressedPartner.id,
      discount: 15,
    }),
    // D-073 Q1: still attributed, though the referred person is verified.
    await edge(f, memberId, await member(f), { state: 'attributed' }),
  ];
  const departedPartnerFriend = (await f.owner.readOne<{ referred_id: string }>(
    {
      text: 'SELECT referred_id FROM referral_edge WHERE id = $1',
      values: [excludedEdges[3]],
    },
  ))!.referred_id;
  const disqualifiedFriend = (await f.owner.readOne<{ referred_id: string }>({
    text: 'SELECT referred_id FROM referral_edge WHERE id = $1',
    values: [excludedEdges[4]],
  }))!.referred_id;

  // D-058: the entitlement left by a partner's erasure.
  const retained = await friend();
  await f.owner.execute({
    text: `INSERT INTO retained_partner_entitlement (subscriber_id, welcome_discount_pct, wave_one)
      VALUES ($1, 15, true)`,
    values: [retained],
  });
  // A retained entitlement of someone outside the set is not exported.
  const retainedOutside = await member(f, { status: 'unsubscribed' });
  await f.owner.execute({
    text: `INSERT INTO retained_partner_entitlement (subscriber_id, welcome_discount_pct, wave_one)
      VALUES ($1, 10, true)`,
    values: [retainedOutside],
  });

  const heldCoupons = [
    await coupon(f, memberId, 1, 30),
    await coupon(f, memberId, 2, 5),
    await coupon(f, active.subscriberId, 1, 10),
  ];
  const excludedCoupons = [
    await coupon(f, memberId, 3, null),
    await coupon(f, unsubscribed, 1, 5),
  ];

  return {
    partners: {
      active: active.id,
      paused: paused.id,
      terminated: terminated.id,
      suppressed: suppressedPartner.id,
      excluded: [
        approved.id,
        rejected.id,
        disqualifiedPartner.id,
        departedPartner.id,
      ],
    },
    exportedEdges: {
      partnerLink,
      partnerCodeVoided,
      retroactive,
      ambassador,
      member: memberEdge,
      memberVoided,
      suppressedPartnerEdge,
    },
    excludedEdges,
    memberId,
    heldCoupons,
    excludedCoupons,
    welcomeDiscounts: {
      [departedPartnerFriend]: 20,
      [disqualifiedFriend]: 10,
      [retained]: 15,
    },
    outsideSet: [
      pending,
      unsubscribed,
      departedFriend,
      retainedOutside,
      disqualifiedPartner.subscriberId,
      departedPartner.subscriberId,
    ],
  };
}

// ---------------------------------------------------------------- running

async function exportInMemory(
  f: PartnerFixture,
): Promise<Map<AttributionExportFile, string>> {
  const files = new Map<AttributionExportFile, string>(
    attributionExportFiles.map((file) => [file, '']),
  );
  await exportAttribution(f.app, actor, async (file, chunk) => {
    files.set(file, files.get(file)! + chunk);
  });
  return files;
}

async function exportWithCommand(
  f: PartnerFixture,
  output: string,
): Promise<{ stdout: string }> {
  return run(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/export-attribution.ts',
      `--actor=${actor}`,
      `--output=${output}`,
    ],
    { env: { ...process.env, DATABASE_URL: f.appDatabaseUrl } },
  );
}

function parsed(files: Map<AttributionExportFile, string>): Json {
  return JSON.parse(files.get('attribution.json')!) as Json;
}

function records(document: Json, kind: AttributionRecordKind): Json[] {
  return document[attributionExportSections[kind].json] as Json[];
}

// ------------------------------------------------------- document parsing

interface SchemaField {
  readonly field: string;
  readonly type: string;
  readonly nullable: boolean;
}

function tableAfter(markdown: string, heading: string): string[][] {
  const start = markdown.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `${heading} is missing`);
  const rows: string[][] = [];
  let inTable = false;
  for (const line of markdown.slice(start + heading.length + 2).split('\n')) {
    if (line.startsWith('|')) {
      inTable = true;
      rows.push(
        line
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim()),
      );
    } else if (inTable || line.startsWith('#')) {
      break;
    }
  }
  // Drop the header and its separator.
  return rows.slice(2);
}

function unquote(cell: string): string {
  const match = /^`([^`]+)`$/u.exec(cell);
  assert.ok(match, `${cell} is not a backticked name`);
  return match[1]!;
}

async function schema(): Promise<Record<AttributionRecordKind, SchemaField[]>> {
  const markdown = await readFile('docs/data/attribution-export.md', 'utf8');
  return Object.fromEntries(
    kinds.map((kind) => [
      kind,
      tableAfter(markdown, `## \`${kind}\` records`).map(
        ([field, type, nullable]) => {
          assert.ok(['yes', 'no'].includes(nullable!));
          return {
            field: unquote(field!),
            type: unquote(type!),
            nullable: nullable === 'yes',
          };
        },
      ),
    ]),
  ) as Record<AttributionRecordKind, SchemaField[]>;
}

async function handOverFields(): Promise<
  Record<AttributionRecordKind, string[]>
> {
  const runbook = await readFile('docs/ops/launch-cutover.md', 'utf8');
  const start = runbook.indexOf('\n## The attribution hand-over (E11.7-14)\n');
  assert.notEqual(start, -1, 'the hand-over section is missing');
  const end = runbook.indexOf('\n## ', start + 1);
  const section = runbook.slice(start, end === -1 ? undefined : end);
  return Object.fromEntries(
    kinds.map((kind) => [
      kind,
      tableAfter(section, `#### \`${kind}\` records`).map(
        ([field, meaning]) => {
          assert.ok(
            meaning && meaning.length > 0,
            `${field} has no definition`,
          );
          return unquote(field!);
        },
      ),
    ]),
  ) as Record<AttributionRecordKind, string[]>;
}

function matchesType(type: string, value: unknown): boolean {
  const enumMatch = /^enum\((.+)\)$/u.exec(type);
  if (enumMatch) {
    const options = enumMatch[1]!.split(', ');
    return options.every((option) => /^\d+$/u.test(option))
      ? typeof value === 'number' && options.includes(String(value))
      : typeof value === 'string' && options.includes(value);
  }
  const text = typeof value === 'string' ? value : null;
  switch (type) {
    case 'uuid':
      return (
        text !== null &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
          text,
        )
      );
    case 'string':
      return text !== null && text.length > 0;
    case 'email':
      return text !== null && text.includes('@');
    case 'code':
      return text !== null && /^[A-Z0-9]{4,16}$/u.test(text);
    case 'country':
      return text !== null && /^[A-Z]{2}$/u.test(text);
    case 'date':
      return text !== null && /^\d{4}-\d{2}-\d{2}$/u.test(text);
    case 'timestamp':
      return (
        text !== null &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(text) &&
        new Date(text).toISOString() === text
      );
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'true':
      return value === true;
    default:
      throw new Error(`The schema uses an undocumented type ${type}.`);
  }
}

/** An RFC 4180 parser for the test's own reading of the CSV files. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else {
      cell += char;
    }
  }
  assert.equal(cell, '', 'the CSV must end with CRLF');
  assert.equal(row.length, 0, 'the CSV must end with CRLF');
  return rows;
}

function csvText(value: unknown): string {
  return value === null ? '' : String(value);
}

// ------------------------------------------------------------- unit tests

function referralRow(
  overrides: Partial<AttributionReferralRow> = {},
): AttributionReferralRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    referred_id: '00000000-0000-4000-8000-000000000002',
    referred_email: 'Friend@example.test',
    referred_email_normalised: 'friend@example.test',
    referrer_id: '00000000-0000-4000-8000-000000000003',
    referrer_email_normalised: 'partner@example.test',
    partner_id: '00000000-0000-4000-8000-000000000004',
    partner_code: 'MAYA',
    attribution_method: 'link',
    signup_at: new Date('2026-11-05T10:00:00.000Z'),
    confirmed_at: new Date('2026-11-05T10:01:00.000Z'),
    voided_at: null,
    void_reason: null,
    referred_access_window: 'wave-1',
    welcome_discount_pct: 15,
    ...overrides,
  };
}

test('a referral record carries the usable welcome discount only on a partner edge that is not voided', () => {
  const live = referralRecord(referralRow(), expiry);
  assert.equal(live.referrer_type, 'partner');
  assert.equal(live.welcome_discount_pct, 15);
  assert.equal(live.welcome_discount_expires_at, expiry);
  assert.equal(live.referred_early_access, true);

  const voided = referralRecord(
    referralRow({
      voided_at: new Date('2026-11-06T10:00:00.000Z'),
      void_reason: 'Duplicate',
    }),
    expiry,
  );
  assert.equal(voided.voided, true);
  assert.equal(voided.welcome_discount_pct, null);
  assert.equal(voided.welcome_discount_expires_at, null);
  assert.equal(voided.partner_id, live.partner_id);

  const memberEdge = referralRecord(
    referralRow({
      partner_id: null,
      partner_code: null,
      welcome_discount_pct: null,
      referred_access_window: 'wave-3',
    }),
    expiry,
  );
  assert.equal(memberEdge.referrer_type, 'member');
  assert.equal(memberEdge.welcome_discount_pct, null);
  assert.equal(memberEdge.referred_early_access, false);

  // A member edge with a discount, or a partner edge without a code, breaks
  // the schema: the export refuses rather than writes it.
  assert.throws(
    () =>
      referralRecord(
        referralRow({ partner_id: null, partner_code: null }),
        expiry,
      ),
    AttributionExportIntegrityError,
  );
  assert.throws(
    () => referralRecord(referralRow({ partner_code: null }), expiry),
    AttributionExportIntegrityError,
  );
  assert.throws(
    () => referralRecord(referralRow({ confirmed_at: null }), expiry),
    AttributionExportIntegrityError,
  );
  assert.throws(
    () => referralRecord(referralRow({ referred_access_window: null }), expiry),
    AttributionExportIntegrityError,
  );
});

test('records serialise with their keys in schema order, and CSV cells quote and encode null', () => {
  const record = referralRecord(referralRow(), expiry);
  assert.deepEqual(
    Object.keys(JSON.parse(jsonRecord('referral', record)) as Json),
    [...attributionExportFields.referral],
  );
  assert.equal(
    csvLine(['plain', 'a,b', 'say "hi"', 'two\nlines', null, true, 15]),
    'plain,"a,b","say ""hi""","two\nlines",,true,15\r\n',
  );
});

function fakeSnapshot(
  partnersTotal: number,
  pageSizes: number[],
): AttributionExportSnapshot & { limits: number[]; closed: boolean } {
  const limits: number[] = [];
  let call = 0;
  const snapshot = {
    limits,
    closed: false,
    counts: {
      partners: partnersTotal,
      referrals: 0,
      coupons: 0,
      welcome_discounts: 0,
    },
    async partners(_afterId: string | null, limit: number) {
      limits.push(limit);
      const size = pageSizes[call] ?? 0;
      call += 1;
      return Array.from({ length: size }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(call * 1000 + index).padStart(12, '0')}`,
        subscriber_id: '00000000-0000-4000-8000-000000000009',
        full_name: 'Maya Example',
        email: 'Maya@example.test',
        email_normalised: 'maya@example.test',
        country_of_residence: 'SE',
        partner_type: 'creator',
        status: 'active',
        partner_code: 'MAYA',
        member_code: 'ABCDEFGHJKMN',
        approved_at: new Date('2026-11-03T09:00:00.000Z'),
        contract_signed_at: '2026-11-04',
        contract_version: 'v1',
        display_name: null,
      }));
    },
    referrals: async () => [],
    coupons: async () => [],
    welcomeDiscounts: async () => [],
    async close() {
      snapshot.closed = true;
    },
  };
  return snapshot;
}

test('the export audits before its first byte, pages at most 500 rows, and refuses a short snapshot', async () => {
  const events: string[] = [];
  const snapshot = fakeSnapshot(1_001, [500, 500, 1]);
  const counts = await exportAttribution(
    {} as never,
    actor,
    async (file) => {
      events.push(`write:${file}`);
    },
    {
      snapshot: async () => snapshot,
      audit: {
        record: async (entry) => {
          events.push(`audit:${entry.action}:${entry.subjectType}`);
          assert.equal(entry.actor, actor);
          assert.equal(
            (entry.detail as { partner_count: number }).partner_count,
            1_001,
          );
        },
      },
    },
  );
  assert.equal(counts.partners, 1_001);
  assert.equal(events[0], 'audit:export.run:attribution_export');
  assert.ok(snapshot.limits.every((limit) => limit === 500));
  assert.equal(snapshot.limits.length, 3);
  assert.equal(snapshot.closed, true);

  // An audit failure writes nothing and releases the snapshot.
  const unaudited = fakeSnapshot(1, [1]);
  const writes: string[] = [];
  await assert.rejects(
    exportAttribution(
      {} as never,
      actor,
      async (file) => {
        writes.push(file);
      },
      {
        snapshot: async () => unaudited,
        audit: {
          record: async () => {
            throw new Error('audit unavailable');
          },
        },
      },
    ),
    /audit unavailable/u,
  );
  assert.deepEqual(writes, []);
  assert.equal(unaudited.closed, true);

  // Fewer rows than the snapshot counted is refused, never written short.
  const short = fakeSnapshot(3, [2]);
  await assert.rejects(
    exportAttribution({} as never, actor, async () => {}, {
      snapshot: async () => short,
      audit: { record: async () => {} },
    }),
    AttributionExportIntegrityError,
  );
  assert.equal(short.closed, true);

  await assert.rejects(
    exportAttribution({} as never, 'system:job', async () => {}),
    /human export actor/u,
  );
});

// ------------------------------------------------------ database tests

test('idempotency: two exports of an unchanged database are byte-identical, and a change shows', async (t) => {
  const f = await createPartnerFixture('e11-7-14-idempotency');
  t.after(() => f.dispose());
  const graph = await seedGraph(f);
  // More referrals than one page, so the paging order is part of the proof.
  await f.owner.execute({
    text: `INSERT INTO subscriber (id, email, email_normalised, email_domain, status,
        created_at, verified_at, access_window)
      SELECT gen_random_uuid(), 'bulk' || g || '@example.test', 'bulk' || g || '@example.test',
        'example.test', 'verified', '2026-11-09T10:00:00Z', '2026-11-09T10:00:00Z', 'wave-4'
      FROM generate_series(1, 620) g`,
  });
  await f.owner.execute({
    text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state, reward_state,
        created_at, confirmed_at)
      SELECT gen_random_uuid(), $1, id, 'confirmed', 'settled',
        '2026-11-09T10:00:00Z', '2026-11-09T10:01:00Z'
      FROM subscriber WHERE email_normalised LIKE 'bulk%@example.test'`,
    values: [graph.memberId],
  });

  const root = await mkdtemp(join(tmpdir(), 'attribution-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const printed = await exportWithCommand(f, first);
  await exportWithCommand(f, second);

  assert.deepEqual(JSON.parse(printed.stdout), {
    partners: 4,
    referrals: 627,
    coupons: 3,
    welcome_discounts: 3,
  });
  assert.deepEqual(
    (await readdir(first)).sort(),
    [...attributionExportFiles].sort(),
  );
  assert.equal((await stat(first)).mode & 0o777, 0o700);
  for (const file of attributionExportFiles) {
    assert.equal((await stat(join(first, file))).mode & 0o777, 0o600);
    const a = await readFile(join(first, file));
    const b = await readFile(join(second, file));
    assert.ok(a.length > 0, `${file} is empty`);
    assert.ok(a.equals(b), `${file} differs between two unchanged exports`);
  }
  const document = JSON.parse(
    await readFile(join(first, 'attribution.json'), 'utf8'),
  ) as Json;
  const ids = records(document, 'referral').map((row) => row.edge_id as string);
  assert.deepEqual(ids, [...ids].sort());
  // The separate welcome-discount records (D-058) are part of the proof.
  assert.equal(records(document, 'welcome_discount').length, 3);

  // An existing directory is refused and left untouched.
  await assert.rejects(exportWithCommand(f, first), /EEXIST/u);
  assert.ok(
    (await readFile(join(first, 'attribution.json'))).equals(
      await readFile(join(second, 'attribution.json')),
    ),
  );

  // Each run is audited with its actor and counts.
  const audits = await f.owner.list<{ actor: string; detail: Json }>(
    {
      text: `SELECT actor, detail FROM audit_log
        WHERE action = 'export.run' AND subject_type = 'attribution_export'`,
    },
    10,
  );
  assert.equal(audits.length, 2);
  for (const audit of audits) {
    assert.equal(audit.actor, actor);
    assert.equal(audit.detail.referral_count, 627);
    assert.equal(audit.detail.welcome_discount_count, 3);
    assert.equal(audit.detail.page_size, 500);
  }

  // One founder void changes the export.
  await f.owner.execute({
    text: `UPDATE referral_edge SET voided_at = '2026-11-10T10:00:00Z',
      void_reason = 'Test void', voided_by = 'admin.operator' WHERE id = $1`,
    values: [graph.exportedEdges.member],
  });
  const third = join(root, 'third');
  await exportWithCommand(f, third);
  assert.ok(
    !(await readFile(join(first, 'referrals.csv'))).equals(
      await readFile(join(third, 'referrals.csv')),
    ),
  );
});

test('schema validation: every record matches docs/data/attribution-export.md, and every field is present', async (t) => {
  const f = await createPartnerFixture('e11-7-14-schema');
  t.after(() => f.dispose());
  await seedGraph(f);
  const files = await exportInMemory(f);
  const document = parsed(files);
  const documented = await schema();
  const markdown = await readFile('docs/data/attribution-export.md', 'utf8');

  // The document's own keys, in their documented order.
  const topLevel = tableAfter(markdown, '## `attribution.json`').map(([key]) =>
    unquote(key!),
  );
  assert.deepEqual(Object.keys(document), topLevel);
  assert.equal(document.format, 'valstara-attribution-export');
  assert.equal(document.version, 1);
  assert.equal(document.public_launch_date, couponLadder.publicLaunchDate);

  for (const kind of kinds) {
    const fields = documented[kind];
    // The code's field list is exactly the documented one.
    assert.deepEqual(
      fields.map((field) => field.field),
      [...attributionExportFields[kind]],
      `${kind} fields differ from the schema`,
    );
    const rows = records(document, kind);
    assert.ok(rows.length > 0, `the fixture exports no ${kind} record`);
    assert.equal(
      (document.counts as Json)[attributionExportSections[kind].json],
      rows.length,
    );
    for (const row of rows) {
      assert.deepEqual(
        Object.keys(row),
        fields.map((field) => field.field),
      );
      for (const { field, type, nullable } of fields) {
        const value = row[field];
        if (value === null) {
          assert.ok(nullable, `${kind}.${field} is null but not nullable`);
        } else {
          assert.ok(
            matchesType(type, value),
            `${kind}.${field} = ${JSON.stringify(value)} is not ${type}`,
          );
        }
      }
    }
    // Every nullable field is exercised as both null and set.
    for (const { field } of fields.filter((item) => item.nullable)) {
      assert.ok(
        rows.some((row) => row[field] === null) &&
          rows.some((row) => row[field] !== null),
        `${kind}.${field} is never both null and set`,
      );
    }

    // The CSV holds the same records, cell for cell.
    const csv = parseCsv(files.get(attributionExportSections[kind].csv)!);
    assert.deepEqual(
      csv[0],
      fields.map((field) => field.field),
    );
    assert.equal(csv.length - 1, rows.length);
    rows.forEach((row, index) => {
      assert.deepEqual(
        csv[index + 1],
        fields.map(({ field }) => csvText(row[field])),
      );
    });
  }
});

test('graph completeness with voids: every confirmed partner and member edge in the set, voids flagged', async (t) => {
  const f = await createPartnerFixture('e11-7-14-graph');
  t.after(() => f.dispose());
  const graph = await seedGraph(f);
  const document = parsed(await exportInMemory(f));
  const partners = records(document, 'partner');
  const referrals = records(document, 'referral');

  assert.deepEqual(
    partners.map((row) => row.partner_id).sort(),
    [
      graph.partners.active,
      graph.partners.paused,
      graph.partners.terminated,
      graph.partners.suppressed,
    ].sort(),
  );
  assert.deepEqual(
    Object.fromEntries(partners.map((row) => [row.partner_id, row.status])),
    {
      [graph.partners.active]: 'active',
      [graph.partners.paused]: 'paused',
      [graph.partners.terminated]: 'terminated',
      [graph.partners.suppressed]: 'active',
    },
  );
  for (const excluded of graph.partners.excluded) {
    assert.equal(
      partners.some((row) => row.partner_id === excluded),
      false,
    );
  }
  for (const row of partners) {
    assert.equal(row.founding_partner, true);
    assert.equal(row.approved_at, '2026-11-03T09:00:00.000Z');
  }

  const byId = new Map(referrals.map((row) => [row.edge_id as string, row]));
  assert.deepEqual(
    [...byId.keys()].sort(),
    Object.values(graph.exportedEdges).sort(),
  );
  for (const excluded of graph.excludedEdges) {
    assert.equal(byId.has(excluded), false);
  }
  const outside = new Set(graph.outsideSet);
  for (const row of referrals) {
    assert.equal(outside.has(row.referred_subscriber_id as string), false);
    assert.equal(outside.has(row.referrer_subscriber_id as string), false);
  }

  // Voided edges are flagged with their reason, never dropped.
  for (const id of [
    graph.exportedEdges.partnerCodeVoided,
    graph.exportedEdges.memberVoided,
  ]) {
    const row = byId.get(id)!;
    assert.equal(row.voided, true);
    assert.equal(row.voided_at, '2026-11-06T10:00:00.000Z');
    assert.equal(row.void_reason, 'Duplicate household, "same" card');
  }
  for (const id of [
    graph.exportedEdges.partnerLink,
    graph.exportedEdges.retroactive,
    graph.exportedEdges.ambassador,
    graph.exportedEdges.member,
    graph.exportedEdges.suppressedPartnerEdge,
  ]) {
    assert.equal(byId.get(id)!.voided, false);
    assert.equal(byId.get(id)!.voided_at, null);
  }

  // Partner and member edges are told apart, and every partner edge names
  // an exported partner and its code.
  const exportedPartners = new Map(
    partners.map((row) => [row.partner_id as string, row]),
  );
  for (const row of referrals) {
    if (row.referrer_type === 'partner') {
      const owner = exportedPartners.get(row.partner_id as string);
      assert.ok(owner, 'a partner edge names a partner outside the export');
      assert.equal(row.partner_code, owner.partner_code);
      assert.equal(row.referrer_subscriber_id, owner.subscriber_id);
    } else {
      assert.equal(row.partner_id, null);
      assert.equal(row.partner_code, null);
    }
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(graph.exportedEdges).map(([name, id]) => [
        name,
        [byId.get(id)!.referrer_type, byId.get(id)!.attribution_method],
      ]),
    ),
    {
      partnerLink: ['partner', 'link'],
      partnerCodeVoided: ['partner', 'code'],
      retroactive: ['partner', 'retroactive'],
      ambassador: ['partner', 'link'],
      member: ['member', 'code'],
      memberVoided: ['member', 'link'],
      suppressedPartnerEdge: ['partner', 'link'],
    },
  );
  assert.equal(
    byId.get(graph.exportedEdges.partnerLink)!.referred_access_window,
    'wave-1',
  );
  assert.equal(
    byId.get(graph.exportedEdges.partnerLink)!.referred_early_access,
    true,
  );
  assert.equal(
    byId.get(graph.exportedEdges.member)!.referred_early_access,
    false,
  );
});

test('coupon and discount fields: held coupons with their expiry, welcome discounts only on partner edges', async (t) => {
  const f = await createPartnerFixture('e11-7-14-coupons');
  t.after(() => f.dispose());
  const graph = await seedGraph(f);
  const document = parsed(await exportInMemory(f));

  const coupons = records(document, 'coupon');
  assert.deepEqual(
    coupons.map((row) => row.coupon_id).sort(),
    [...graph.heldCoupons].sort(),
  );
  for (const id of graph.excludedCoupons) {
    assert.equal(
      coupons.some((row) => row.coupon_id === id),
      false,
    );
  }
  assert.equal(couponExpiresAt(couponLadder).toISOString(), expiry);
  for (const row of coupons) {
    assert.equal(row.state, 'held');
    assert.equal(row.expires_at, expiry);
  }
  assert.deepEqual(
    coupons
      .filter((row) => row.subscriber_id === graph.memberId)
      .map((row) => [row.coupon_number, row.percent])
      .sort(),
    [
      [1, 30],
      [2, 5],
    ],
  );

  const referrals = new Map(
    records(document, 'referral').map((row) => [row.edge_id as string, row]),
  );
  const discount = (id: string) => [
    referrals.get(id)!.welcome_discount_pct,
    referrals.get(id)!.welcome_discount_expires_at,
  ];
  assert.deepEqual(discount(graph.exportedEdges.partnerLink), [10, expiry]);
  assert.deepEqual(discount(graph.exportedEdges.retroactive), [20, expiry]);
  assert.deepEqual(discount(graph.exportedEdges.ambassador), [15, expiry]);
  // D-073 Q3: the suppressed partner's friend has the discount on the edge.
  assert.deepEqual(discount(graph.exportedEdges.suppressedPartnerEdge), [
    20,
    expiry,
  ]);
  // A voided partner edge grants nothing; a member edge never has one.
  assert.deepEqual(discount(graph.exportedEdges.partnerCodeVoided), [
    null,
    null,
  ]);
  for (const row of referrals.values()) {
    if (row.referrer_type === 'member') {
      assert.equal(row.welcome_discount_pct, null);
      assert.equal(row.welcome_discount_expires_at, null);
    }
  }

  // The separately carried discounts name no partner, code or edge, and a
  // friend's discount appears exactly once across both record kinds.
  const separate = records(document, 'welcome_discount');
  assert.deepEqual(
    Object.fromEntries(
      separate.map((row) => [row.subscriber_id, row.welcome_discount_pct]),
    ),
    graph.welcomeDiscounts,
  );
  for (const row of separate) {
    assert.deepEqual(Object.keys(row), [
      'subscriber_id',
      'email',
      'email_normalised',
      'welcome_discount_pct',
      'wave_one',
      'expires_at',
    ]);
    assert.equal(row.wave_one, true);
    assert.equal(row.expires_at, expiry);
  }
  const owners = [
    ...[...referrals.values()]
      .filter((row) => row.welcome_discount_pct !== null)
      .map((row) => row.referred_subscriber_id),
    ...separate.map((row) => row.subscriber_id),
  ];
  assert.equal(new Set(owners).size, owners.length);

  // The expiry follows the configured launch date, not the clock.
  const later = new Map<AttributionExportFile, string>(
    attributionExportFiles.map((file) => [file, '']),
  );
  await exportAttribution(
    f.app,
    actor,
    async (file, chunk) => {
      later.set(file, later.get(file)! + chunk);
    },
    { ladder: { ...couponLadder, publicLaunchDate: '2028-01-15' } },
  );
  const moved = parsed(later);
  assert.equal(moved.public_launch_date, '2028-01-15');
  for (const row of records(moved, 'coupon')) {
    assert.equal(row.expires_at, '2033-01-15T00:00:00.000Z');
  }
  for (const row of records(moved, 'welcome_discount')) {
    assert.equal(row.expires_at, '2033-01-15T00:00:00.000Z');
  }
});

test('the document–export reconciliation: every field the hand-over document defines exists in the export', async (t) => {
  const f = await createPartnerFixture('e11-7-14-hand-over');
  t.after(() => f.dispose());
  await seedGraph(f);
  const document = parsed(await exportInMemory(f));
  const defined = await handOverFields();
  for (const kind of kinds) {
    const exported = records(document, kind);
    assert.ok(exported.length > 0, `the fixture exports no ${kind} record`);
    for (const field of defined[kind]) {
      for (const row of exported) {
        assert.ok(
          Object.hasOwn(row, field),
          `${kind}.${field} is defined in the hand-over but not exported`,
        );
      }
    }
    // And the export holds no field the hand-over leaves undefined.
    assert.deepEqual(
      [...defined[kind]].sort(),
      Object.keys(exported[0]!).sort(),
      `${kind}: the hand-over and the export disagree`,
    );
  }
  // The hand-over's stated default expiry is the configured one.
  const runbook = await readFile('docs/ops/launch-cutover.md', 'utf8');
  assert.ok(
    runbook.includes(
      `default ${couponLadder.publicLaunchDate}, so ${couponExpiresAt(couponLadder).toISOString()}`,
    ),
  );
});
