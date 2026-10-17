import { accessWindows, milestoneTiers } from '../referral/config.ts';
import type { DatabasePool } from '../db/pool.ts';
import {
  importRehearsalBatch,
  rehearsalBatchSize,
  type RehearsalCounts,
} from '../db/handoff-rehearsal.ts';
import type {
  HandoffCustomer,
  HandoffDiscount,
  HandoffRecord,
  HandoffUnsubscribeToken,
} from './handoff.ts';

const customerKeys = [
  'type',
  'email',
  'email_normalised',
  'referral_tier',
  'referral_code',
  'confirmed_referrals',
  'category_preference',
  'source',
  'marketing_consent_at',
  'marketing_consent_version',
  'marketing_consent_source',
  'access_window',
  'subslush_customer',
  'groups',
] as const;
const discountKeys = [
  'type',
  'award_id',
  'subscriber_id',
  'email_normalised',
  'tier',
  'discount_percent',
  'state',
  'outcome',
  'qualification_deadline',
] as const;
const referralKeys = [
  'type',
  'referrer_email_normalised',
  'referred_email_normalised',
] as const;
const unsubscribeTokenKeys = [
  'type',
  'token_sha256',
  'email_normalised',
  'origin_kind',
  'expires_at',
] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const utcInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    utcInstant.test(value) &&
    Number.isFinite(new Date(value).getTime()) &&
    new Date(value).toISOString() === value
  );
}

export function parseHandoffRecord(value: unknown): HandoffRecord {
  if (!object(value)) throw new TypeError('Handoff record must be an object.');
  if (value.type === 'customer') {
    if (
      !exactKeys(value, customerKeys) ||
      typeof value.email !== 'string' ||
      value.email.length === 0 ||
      typeof value.email_normalised !== 'string' ||
      value.email_normalised.length === 0 ||
      !nonNegativeInteger(value.referral_tier) ||
      !nonNegativeInteger(value.confirmed_referrals) ||
      !nullableString(value.referral_code) ||
      !nullableString(value.source) ||
      !nullableString(value.marketing_consent_at) ||
      !nullableString(value.marketing_consent_version) ||
      !nullableString(value.marketing_consent_source) ||
      (value.marketing_consent_at !== null &&
        !validInstant(value.marketing_consent_at)) ||
      (value.category_preference !== null &&
        (!Array.isArray(value.category_preference) ||
          !value.category_preference.every(
            (item: unknown) => typeof item === 'string',
          ))) ||
      !accessWindows.includes(
        value.access_window as (typeof accessWindows)[number],
      ) ||
      typeof value.subslush_customer !== 'boolean' ||
      !Array.isArray(value.groups)
    ) {
      throw new TypeError(
        'Handoff customer does not match its field contract.',
      );
    }
    const expectedGroups = value.subslush_customer
      ? [value.access_window, 'subslush-legacy']
      : [value.access_window];
    if (
      JSON.stringify(value.groups) !== JSON.stringify(expectedGroups) ||
      ([
        value.marketing_consent_at,
        value.marketing_consent_version,
        value.marketing_consent_source,
      ].some((item) => item === null) &&
        [
          value.marketing_consent_at,
          value.marketing_consent_version,
          value.marketing_consent_source,
        ].some((item) => item !== null))
    ) {
      throw new TypeError(
        'Handoff customer groups or marketing consent are inconsistent.',
      );
    }
    return value as unknown as HandoffCustomer;
  }
  if (value.type === 'held_discount') {
    if (
      !exactKeys(value, discountKeys) ||
      typeof value.award_id !== 'string' ||
      !uuid.test(value.award_id) ||
      typeof value.subscriber_id !== 'string' ||
      !uuid.test(value.subscriber_id) ||
      typeof value.email_normalised !== 'string' ||
      value.email_normalised.length === 0 ||
      !nonNegativeInteger(value.tier) ||
      value.tier < 1 ||
      !nonNegativeInteger(value.discount_percent) ||
      value.state !== 'held' ||
      value.outcome !== 'carried_to_storefront' ||
      !validInstant(value.qualification_deadline) ||
      milestoneTiers.find((tier) => tier.number === value.tier)
        ?.discountPercent !== value.discount_percent
    ) {
      throw new TypeError('Held discount does not match its field contract.');
    }
    return value as unknown as HandoffDiscount;
  }
  if (value.type === 'confirmed_referral') {
    if (
      !exactKeys(value, referralKeys) ||
      typeof value.referrer_email_normalised !== 'string' ||
      value.referrer_email_normalised.length === 0 ||
      typeof value.referred_email_normalised !== 'string' ||
      value.referred_email_normalised.length === 0 ||
      value.referrer_email_normalised === value.referred_email_normalised
    ) {
      throw new TypeError(
        'Confirmed referral does not match its field contract.',
      );
    }
    return value as unknown as HandoffRecord;
  }
  if (value.type === 'unsubscribe_token') {
    if (
      !exactKeys(value, unsubscribeTokenKeys) ||
      typeof value.token_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.token_sha256) ||
      typeof value.email_normalised !== 'string' ||
      value.email_normalised.length === 0 ||
      (value.origin_kind !== 'marketing' &&
        value.origin_kind !== 'transactional') ||
      !validInstant(value.expires_at)
    )
      throw new TypeError(
        'Unsubscribe token does not match its field contract.',
      );
    return value as unknown as HandoffUnsubscribeToken;
  }
  throw new TypeError('Unrecognised handoff record type.');
}

export async function importRehearsal(
  database: DatabasePool,
  lines: AsyncIterable<string>,
): Promise<RehearsalCounts> {
  const totals = {
    createdCustomers: 0,
    createdDiscounts: 0,
    createdGroups: 0,
    createdReferrals: 0,
    createdTokens: 0,
  };
  let batch: HandoffRecord[] = [];
  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const result = await importRehearsalBatch(database, batch);
    totals.createdCustomers += result.createdCustomers;
    totals.createdDiscounts += result.createdDiscounts;
    totals.createdGroups += result.createdGroups;
    totals.createdReferrals += result.createdReferrals;
    totals.createdTokens += result.createdTokens;
    batch = [];
  }
  for await (const line of lines) {
    if (line.trim() === '') continue;
    batch.push(parseHandoffRecord(JSON.parse(line) as unknown));
    if (batch.length === rehearsalBatchSize) await flush();
  }
  await flush();
  return totals;
}
