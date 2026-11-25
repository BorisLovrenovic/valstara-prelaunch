import { createAuditService, type AuditService } from '../audit/service.ts';
import {
  attributionExportBatchSize,
  openAttributionExportSnapshot,
  type AttributionCouponRow,
  type AttributionExportCounts,
  type AttributionExportSnapshot,
  type AttributionPartnerRow,
  type AttributionReferralRow,
  type AttributionWelcomeDiscountRow,
} from '../db/attribution-export.ts';
import type { DatabasePool } from '../db/pool.ts';
import {
  accessWindows,
  couponExpiresAt,
  couponLadder,
  type AccessWindow,
  type CouponLadder,
} from '../referral/config.ts';
import { partnerTypes, type PartnerType } from './config.ts';

// E11.7-14: `npm run export:attribution`, the attribution graph the main
// platform imports at launch. The schema is `docs/data/attribution-export.md`;
// the hand-over contract is `docs/ops/launch-cutover.md`. The output holds no
// clock reading and no generated value, so two runs against an unchanged
// database write byte-identical files.

export const attributionExportFormat = 'valstara-attribution-export';
export const attributionExportVersion = 1;

/** The record fields, in the schema's order: the JSON key order and the CSV columns. */
export const attributionExportFields = {
  partner: [
    'partner_id',
    'subscriber_id',
    'legal_name',
    'email',
    'email_normalised',
    'country',
    'partner_type',
    'status',
    'partner_code',
    'member_code',
    'approved_at',
    'contract_signed_at',
    'contract_version',
    'founding_partner',
    'display_name',
  ],
  referral: [
    'edge_id',
    'referred_subscriber_id',
    'referred_email',
    'referred_email_normalised',
    'referrer_subscriber_id',
    'referrer_email_normalised',
    'referrer_type',
    'partner_id',
    'partner_code',
    'attribution_method',
    'signup_at',
    'confirmed_at',
    'voided',
    'voided_at',
    'void_reason',
    'referred_access_window',
    'referred_early_access',
    'welcome_discount_pct',
    'welcome_discount_expires_at',
  ],
  coupon: [
    'coupon_id',
    'subscriber_id',
    'email_normalised',
    'coupon_number',
    'percent',
    'state',
    'expires_at',
  ],
  welcome_discount: [
    'subscriber_id',
    'email',
    'email_normalised',
    'welcome_discount_pct',
    'wave_one',
    'expires_at',
  ],
} as const;

export type AttributionRecordKind = keyof typeof attributionExportFields;

/** The JSON section and the CSV file each record kind is written to. */
export const attributionExportSections = {
  partner: { json: 'partners', csv: 'partners.csv' },
  referral: { json: 'referrals', csv: 'referrals.csv' },
  coupon: { json: 'coupons', csv: 'coupons.csv' },
  welcome_discount: { json: 'welcome_discounts', csv: 'welcome_discounts.csv' },
} as const satisfies Record<
  AttributionRecordKind,
  { readonly json: keyof AttributionExportCounts; readonly csv: string }
>;

export const attributionExportJsonFile = 'attribution.json';

export type AttributionExportFile =
  | typeof attributionExportJsonFile
  | (typeof attributionExportSections)[AttributionRecordKind]['csv'];

export const attributionExportFiles: readonly AttributionExportFile[] = [
  attributionExportJsonFile,
  ...Object.values(attributionExportSections).map((section) => section.csv),
];

type PartnerStatus = 'active' | 'paused' | 'terminated';
type AttributionMethod = 'link' | 'code' | 'retroactive';
type WelcomeDiscount = 10 | 15 | 20;

export interface AttributionPartner {
  readonly partner_id: string;
  readonly subscriber_id: string;
  readonly legal_name: string;
  readonly email: string;
  readonly email_normalised: string;
  readonly country: string;
  readonly partner_type: PartnerType;
  readonly status: PartnerStatus;
  readonly partner_code: string;
  readonly member_code: string;
  readonly approved_at: string;
  readonly contract_signed_at: string;
  readonly contract_version: string;
  readonly founding_partner: true;
  readonly display_name: string | null;
}

export interface AttributionReferral {
  readonly edge_id: string;
  readonly referred_subscriber_id: string;
  readonly referred_email: string;
  readonly referred_email_normalised: string;
  readonly referrer_subscriber_id: string;
  readonly referrer_email_normalised: string;
  readonly referrer_type: 'member' | 'partner';
  readonly partner_id: string | null;
  readonly partner_code: string | null;
  readonly attribution_method: AttributionMethod;
  readonly signup_at: string;
  readonly confirmed_at: string;
  readonly voided: boolean;
  readonly voided_at: string | null;
  readonly void_reason: string | null;
  readonly referred_access_window: AccessWindow;
  readonly referred_early_access: boolean;
  readonly welcome_discount_pct: WelcomeDiscount | null;
  readonly welcome_discount_expires_at: string | null;
}

export interface AttributionCoupon {
  readonly coupon_id: string;
  readonly subscriber_id: string;
  readonly email_normalised: string;
  readonly coupon_number: number;
  readonly percent: number;
  readonly state: 'held';
  readonly expires_at: string;
}

export interface AttributionWelcomeDiscount {
  readonly subscriber_id: string;
  readonly email: string;
  readonly email_normalised: string;
  readonly welcome_discount_pct: WelcomeDiscount;
  readonly wave_one: true;
  readonly expires_at: string;
}

type AttributionRecord =
  | AttributionPartner
  | AttributionReferral
  | AttributionCoupon
  | AttributionWelcomeDiscount;

/** The export refuses rather than write a record that breaks its schema. */
export class AttributionExportIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributionExportIntegrityError';
  }
}

function required<T>(value: T | null, what: string): T {
  if (value === null) {
    throw new AttributionExportIntegrityError(`${what} is missing.`);
  }
  return value;
}

function oneOf<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new AttributionExportIntegrityError(`${what} is not recognised.`);
  }
  return value as T;
}

function welcomeDiscount(value: unknown, what: string): WelcomeDiscount {
  return oneOf<WelcomeDiscount>(value, [10, 15, 20], what);
}

export function partnerRecord(row: AttributionPartnerRow): AttributionPartner {
  return {
    partner_id: row.id,
    subscriber_id: row.subscriber_id,
    legal_name: required(row.full_name, 'A partner name'),
    email: row.email,
    email_normalised: row.email_normalised,
    country: required(row.country_of_residence, 'A partner country'),
    partner_type: oneOf(row.partner_type, partnerTypes, 'A partner type'),
    status: oneOf<PartnerStatus>(
      row.status,
      ['active', 'paused', 'terminated'],
      'A partner status',
    ),
    partner_code: required(row.partner_code, 'A partner code'),
    member_code: required(row.member_code, 'A partner member code'),
    approved_at: required(
      row.approved_at,
      'A partner approval record',
    ).toISOString(),
    contract_signed_at: required(
      row.contract_signed_at,
      'A partner contract date',
    ),
    contract_version: required(row.contract_version, 'A contract version'),
    founding_partner: true,
    display_name: row.display_name,
  };
}

/**
 * A partner edge carries its partner and code; a member edge carries
 * neither. The welcome discount is the one the referred person can use: the
 * fixed percentage of a partner edge that is not voided, and null on a member
 * edge or a voided edge, which grants nothing.
 */
export function referralRecord(
  row: AttributionReferralRow,
  expiresAt: string,
): AttributionReferral {
  const partnerEdge = row.partner_id !== null;
  if (partnerEdge !== (row.welcome_discount_pct !== null)) {
    throw new AttributionExportIntegrityError(
      'A partner edge and its welcome discount must appear together.',
    );
  }
  if (partnerEdge && row.partner_code === null) {
    throw new AttributionExportIntegrityError(
      'A partner edge has no partner code.',
    );
  }
  const voided = row.voided_at !== null;
  const usable =
    partnerEdge && !voided
      ? welcomeDiscount(row.welcome_discount_pct, 'A welcome discount')
      : null;
  const accessWindow = oneOf(
    row.referred_access_window,
    accessWindows,
    'A referred access window',
  );
  return {
    edge_id: row.id,
    referred_subscriber_id: row.referred_id,
    referred_email: row.referred_email,
    referred_email_normalised: row.referred_email_normalised,
    referrer_subscriber_id: row.referrer_id,
    referrer_email_normalised: row.referrer_email_normalised,
    referrer_type: partnerEdge ? 'partner' : 'member',
    partner_id: row.partner_id,
    partner_code: partnerEdge ? row.partner_code : null,
    attribution_method: oneOf<AttributionMethod>(
      row.attribution_method,
      ['link', 'code', 'retroactive'],
      'An attribution method',
    ),
    signup_at: row.signup_at.toISOString(),
    confirmed_at: required(
      row.confirmed_at,
      'A confirmation time',
    ).toISOString(),
    voided,
    voided_at: row.voided_at?.toISOString() ?? null,
    void_reason: row.void_reason,
    referred_access_window: accessWindow,
    referred_early_access: accessWindow === 'wave-1',
    welcome_discount_pct: usable,
    welcome_discount_expires_at: usable === null ? null : expiresAt,
  };
}

export function couponRecord(
  row: AttributionCouponRow,
  expiresAt: string,
): AttributionCoupon {
  return {
    coupon_id: row.id,
    subscriber_id: row.subscriber_id,
    email_normalised: row.email_normalised,
    coupon_number: row.coupon_number,
    percent: row.percent,
    state: 'held',
    expires_at: expiresAt,
  };
}

export function welcomeDiscountRecord(
  row: AttributionWelcomeDiscountRow,
  expiresAt: string,
): AttributionWelcomeDiscount {
  return {
    subscriber_id: row.id,
    email: row.email,
    email_normalised: row.email_normalised,
    welcome_discount_pct: welcomeDiscount(
      row.welcome_discount_pct,
      'A welcome discount',
    ),
    wave_one: true,
    expires_at: expiresAt,
  };
}

/** One RFC 4180 cell: null is empty, booleans are lowercase, CRLF rows. */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(values: readonly (string | number | boolean | null)[]) {
  return `${values.map(csvCell).join(',')}\r\n`;
}

function fieldValues(
  kind: AttributionRecordKind,
  record: AttributionRecord,
): (string | number | boolean | null)[] {
  const values = record as unknown as Record<
    string,
    string | number | boolean | null
  >;
  return attributionExportFields[kind].map((field) => {
    if (!(field in values)) {
      throw new AttributionExportIntegrityError(
        `The ${kind} field ${field} is missing.`,
      );
    }
    return values[field] ?? null;
  });
}

/** One JSON object with its keys in the schema's order. */
export function jsonRecord(
  kind: AttributionRecordKind,
  record: AttributionRecord,
): string {
  const values = fieldValues(kind, record);
  return `{${attributionExportFields[kind]
    .map(
      (field, index) =>
        `${JSON.stringify(field)}:${JSON.stringify(values[index])}`,
    )
    .join(',')}}`;
}

export interface AttributionExportOptions {
  readonly ladder?: CouponLadder;
  readonly snapshot?: (
    database: DatabasePool,
  ) => Promise<AttributionExportSnapshot>;
  readonly audit?: Pick<AuditService, 'record'>;
}

/**
 * Writes the whole export through `write`, one page of at most 500 rows at a
 * time from one database snapshot. `export.run` is recorded with the actor
 * and the snapshot's counts before the first byte, so an export that cannot
 * be audited writes nothing.
 */
export async function exportAttribution(
  database: DatabasePool,
  actor: string,
  write: (file: AttributionExportFile, chunk: string) => Promise<void>,
  options: AttributionExportOptions = {},
): Promise<AttributionExportCounts> {
  const trimmed = actor.trim();
  if (trimmed === '' || trimmed.startsWith('system:')) {
    throw new Error('A human export actor is required.');
  }
  const ladder = options.ladder ?? couponLadder;
  // Coupons and welcome discounts expire five years after the configured
  // public-launch date; the founder sets the real date before export.
  const expiresAt = couponExpiresAt(ladder).toISOString();
  const snapshot = await (options.snapshot ?? openAttributionExportSnapshot)(
    database,
  );
  try {
    const { counts } = snapshot;
    await (options.audit ?? createAuditService(database)).record({
      action: 'export.run',
      actor: trimmed,
      subjectType: 'attribution_export',
      subjectId: null,
      detail: {
        format_version: attributionExportVersion,
        partner_count: counts.partners,
        referral_count: counts.referrals,
        coupon_count: counts.coupons,
        welcome_discount_count: counts.welcome_discounts,
        expires_at: expiresAt,
        page_size: attributionExportBatchSize,
      },
    });

    for (const kind of Object.keys(
      attributionExportSections,
    ) as AttributionRecordKind[]) {
      await write(
        attributionExportSections[kind].csv,
        csvLine(attributionExportFields[kind]),
      );
    }
    await write(
      attributionExportJsonFile,
      `{"format":${JSON.stringify(attributionExportFormat)},"version":${attributionExportVersion},` +
        `"public_launch_date":${JSON.stringify(ladder.publicLaunchDate)},` +
        `"counts":${JSON.stringify(counts)}`,
    );

    async function section<Row extends { readonly id: string }>(
      kind: AttributionRecordKind,
      total: number,
      read: (afterId: string | null, limit: number) => Promise<readonly Row[]>,
      build: (row: Row) => AttributionRecord,
    ): Promise<void> {
      const { json, csv } = attributionExportSections[kind];
      await write(attributionExportJsonFile, `,\n${JSON.stringify(json)}:[`);
      let written = 0;
      let afterId: string | null = null;
      while (written < total) {
        const page = await read(afterId, attributionExportBatchSize);
        if (
          page.length === 0 ||
          page.length > attributionExportBatchSize ||
          written + page.length > total
        ) {
          throw new AttributionExportIntegrityError(
            `The ${kind} pages did not match the snapshot count.`,
          );
        }
        let jsonChunk = '';
        let csvChunk = '';
        for (const row of page) {
          const record = build(row);
          jsonChunk += `${written === 0 ? '' : ','}\n${jsonRecord(kind, record)}`;
          csvChunk += csvLine(fieldValues(kind, record));
          written += 1;
        }
        await write(attributionExportJsonFile, jsonChunk);
        await write(csv, csvChunk);
        afterId = page.at(-1)!.id;
      }
      await write(attributionExportJsonFile, total === 0 ? ']' : '\n]');
    }

    await section('partner', counts.partners, snapshot.partners, partnerRecord);
    await section('referral', counts.referrals, snapshot.referrals, (row) =>
      referralRecord(row, expiresAt),
    );
    await section('coupon', counts.coupons, snapshot.coupons, (row) =>
      couponRecord(row, expiresAt),
    );
    await section(
      'welcome_discount',
      counts.welcome_discounts,
      snapshot.welcomeDiscounts,
      (row) => welcomeDiscountRecord(row, expiresAt),
    );
    await write(attributionExportJsonFile, '}\n');
    return counts;
  } finally {
    await snapshot.close();
  }
}
