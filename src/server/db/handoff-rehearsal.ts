import type {
  HandoffCoupon,
  HandoffCustomer,
  HandoffConfirmedReferral,
  HandoffRecord,
  HandoffUnsubscribeToken,
} from '../subscriber/handoff.ts';
import type { DatabaseConnection, DatabasePool } from './pool.ts';
import { withTransaction } from './transaction.ts';

export const rehearsalBatchSize = 500;
export const rehearsalGroups = [
  'wave-1',
  'wave-2',
  'wave-3',
  'wave-4',
  'subslush-legacy',
] as const;

export interface RehearsalCounts {
  readonly createdCustomers: number;
  readonly createdCoupons: number;
  readonly createdGroups: number;
  readonly createdReferrals: number;
  readonly createdTokens: number;
}

export async function createRehearsalTables(
  database: DatabasePool,
): Promise<void> {
  await database.execute({
    text: `CREATE TABLE rehearsal_customer (
    email_normalised text PRIMARY KEY,
    payload jsonb NOT NULL
  )`,
  });
  await database.execute({
    text: `CREATE TABLE rehearsal_customer_group (
    email_normalised text NOT NULL REFERENCES rehearsal_customer(email_normalised),
    group_name text NOT NULL CHECK (group_name IN ('wave-1','wave-2','wave-3','wave-4','subslush-legacy')),
    PRIMARY KEY (email_normalised, group_name)
  )`,
  });
  await database.execute({
    text: `CREATE TABLE rehearsal_coupon (
    coupon_id uuid PRIMARY KEY,
    subscriber_id uuid NOT NULL,
    email_normalised text NOT NULL REFERENCES rehearsal_customer(email_normalised),
    coupon_number integer NOT NULL CHECK (coupon_number >= 1),
    percent integer NOT NULL CHECK (percent BETWEEN 1 AND 100),
    expires_at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    UNIQUE (email_normalised, coupon_number)
  )`,
  });
  await database.execute({
    text: `CREATE TABLE rehearsal_confirmed_referral (
    referrer_email_normalised text NOT NULL REFERENCES rehearsal_customer(email_normalised),
    referred_email_normalised text NOT NULL REFERENCES rehearsal_customer(email_normalised),
    payload jsonb NOT NULL,
    PRIMARY KEY (referrer_email_normalised, referred_email_normalised),
    UNIQUE (referred_email_normalised)
  )`,
  });
  await database.execute({
    text: `CREATE TABLE rehearsal_unsubscribe_token (
      token_sha256 text PRIMARY KEY CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
      email_normalised text NOT NULL,
      origin_kind text NOT NULL CHECK (origin_kind IN ('marketing','transactional')),
      expires_at timestamptz NOT NULL,
      payload jsonb NOT NULL
    )`,
  });
}

async function importCustomer(
  connection: DatabaseConnection,
  record: HandoffCustomer,
): Promise<RehearsalCounts> {
  const payload = JSON.stringify(record);
  const createdCustomers = await connection.execute({
    text: `INSERT INTO rehearsal_customer (email_normalised, payload)
      VALUES ($1, $2::jsonb) ON CONFLICT (email_normalised) DO NOTHING`,
    values: [record.email_normalised, payload],
  });
  const existing = await connection.readOne<{ matches: boolean }>({
    text: `SELECT payload = $2::jsonb AS matches FROM rehearsal_customer WHERE email_normalised = $1`,
    values: [record.email_normalised, payload],
  });
  if (!existing?.matches)
    throw new Error('Customer idempotency key has conflicting data.');
  let createdGroups = 0;
  for (const group of record.groups) {
    createdGroups += await connection.execute({
      text: `INSERT INTO rehearsal_customer_group (email_normalised, group_name)
        VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      values: [record.email_normalised, group],
    });
  }
  return {
    createdCustomers,
    createdGroups,
    createdCoupons: 0,
    createdReferrals: 0,
    createdTokens: 0,
  };
}

async function importCoupon(
  connection: DatabaseConnection,
  record: HandoffCoupon,
): Promise<RehearsalCounts> {
  const payload = JSON.stringify(record);
  const createdCoupons = await connection.execute({
    text: `INSERT INTO rehearsal_coupon (coupon_id, subscriber_id, email_normalised, coupon_number, percent, expires_at, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (coupon_id) DO NOTHING`,
    values: [
      record.coupon_id,
      record.subscriber_id,
      record.email_normalised,
      record.coupon_number,
      record.percent,
      record.expires_at,
      payload,
    ],
  });
  const existing = await connection.readOne<{ matches: boolean }>({
    text: `SELECT payload = $2::jsonb AS matches FROM rehearsal_coupon WHERE coupon_id = $1`,
    values: [record.coupon_id, payload],
  });
  if (!existing?.matches)
    throw new Error('Coupon idempotency key has conflicting data.');
  return {
    createdCustomers: 0,
    createdGroups: 0,
    createdCoupons,
    createdReferrals: 0,
    createdTokens: 0,
  };
}

async function importReferral(
  connection: DatabaseConnection,
  record: HandoffConfirmedReferral,
): Promise<RehearsalCounts> {
  const payload = JSON.stringify(record);
  const createdReferrals = await connection.execute({
    text: `INSERT INTO rehearsal_confirmed_referral
      (referrer_email_normalised, referred_email_normalised, payload)
      VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING`,
    values: [
      record.referrer_email_normalised,
      record.referred_email_normalised,
      payload,
    ],
  });
  const existing = await connection.readOne<{ matches: boolean }>({
    text: `SELECT payload = $3::jsonb AS matches FROM rehearsal_confirmed_referral
      WHERE referrer_email_normalised = $1 AND referred_email_normalised = $2`,
    values: [
      record.referrer_email_normalised,
      record.referred_email_normalised,
      payload,
    ],
  });
  if (!existing?.matches)
    throw new Error('Referral idempotency key has conflicting data.');
  return {
    createdCustomers: 0,
    createdGroups: 0,
    createdCoupons: 0,
    createdReferrals,
    createdTokens: 0,
  };
}

async function importUnsubscribeToken(
  connection: DatabaseConnection,
  record: HandoffUnsubscribeToken,
): Promise<RehearsalCounts> {
  const payload = JSON.stringify(record);
  const createdTokens = await connection.execute({
    text: `INSERT INTO rehearsal_unsubscribe_token
      (token_sha256, email_normalised, origin_kind, expires_at, payload)
      VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (token_sha256) DO NOTHING`,
    values: [
      record.token_sha256,
      record.email_normalised,
      record.origin_kind,
      record.expires_at,
      payload,
    ],
  });
  const existing = await connection.readOne<{ matches: boolean }>({
    text: `SELECT payload=$2::jsonb AS matches FROM rehearsal_unsubscribe_token
      WHERE token_sha256=$1`,
    values: [record.token_sha256, payload],
  });
  if (!existing?.matches)
    throw new Error('Unsubscribe token hash has conflicting data.');
  return {
    createdCustomers: 0,
    createdCoupons: 0,
    createdGroups: 0,
    createdReferrals: 0,
    createdTokens,
  };
}

export async function importRehearsalBatch(
  database: DatabasePool,
  records: readonly HandoffRecord[],
): Promise<RehearsalCounts> {
  if (records.length < 1 || records.length > rehearsalBatchSize)
    throw new RangeError('Rehearsal import batch is outside its cap.');
  return withTransaction(database, async (connection) => {
    const counts = {
      createdCustomers: 0,
      createdGroups: 0,
      createdCoupons: 0,
      createdReferrals: 0,
      createdTokens: 0,
    };
    for (const record of records) {
      const result =
        record.type === 'customer'
          ? await importCustomer(connection, record)
          : record.type === 'held_coupon'
            ? await importCoupon(connection, record)
            : record.type === 'confirmed_referral'
              ? await importReferral(connection, record)
              : await importUnsubscribeToken(connection, record);
      counts.createdCustomers += result.createdCustomers;
      counts.createdGroups += result.createdGroups;
      counts.createdCoupons += result.createdCoupons;
      counts.createdReferrals += result.createdReferrals;
      counts.createdTokens += result.createdTokens;
    }
    return counts;
  });
}

export async function countRehearsalRows(database: DatabasePool): Promise<{
  customers: number;
  groups: number;
  coupons: number;
  referrals: number;
  tokens: number;
}> {
  const row = await database.readOne<{
    customers: number;
    groups: number;
    coupons: number;
    referrals: number;
    tokens: number;
  }>({
    text: `SELECT
      (SELECT count(*)::int FROM rehearsal_customer) AS customers,
      (SELECT count(*)::int FROM rehearsal_customer_group) AS groups,
      (SELECT count(*)::int FROM rehearsal_coupon) AS coupons,
      (SELECT count(*)::int FROM rehearsal_confirmed_referral) AS referrals,
      (SELECT count(*)::int FROM rehearsal_unsubscribe_token) AS tokens`,
  });
  if (!row) throw new Error('Rehearsal counts were unavailable.');
  return row;
}
