import type {
  HandoffCustomer,
  HandoffConfirmedReferral,
  HandoffDiscount,
  HandoffRecord,
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
  readonly createdDiscounts: number;
  readonly createdGroups: number;
  readonly createdReferrals: number;
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
    text: `CREATE TABLE rehearsal_discount (
    award_id uuid PRIMARY KEY,
    subscriber_id uuid NOT NULL,
    email_normalised text NOT NULL REFERENCES rehearsal_customer(email_normalised),
    qualification_deadline timestamptz NOT NULL,
    payload jsonb NOT NULL
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
    createdDiscounts: 0,
    createdReferrals: 0,
  };
}

async function importDiscount(
  connection: DatabaseConnection,
  record: HandoffDiscount,
): Promise<RehearsalCounts> {
  const payload = JSON.stringify(record);
  const createdDiscounts = await connection.execute({
    text: `INSERT INTO rehearsal_discount (award_id, subscriber_id, email_normalised, qualification_deadline, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (award_id) DO NOTHING`,
    values: [
      record.award_id,
      record.subscriber_id,
      record.email_normalised,
      record.qualification_deadline,
      payload,
    ],
  });
  const existing = await connection.readOne<{ matches: boolean }>({
    text: `SELECT payload = $2::jsonb AS matches FROM rehearsal_discount WHERE award_id = $1`,
    values: [record.award_id, payload],
  });
  if (!existing?.matches)
    throw new Error('Discount idempotency key has conflicting data.');
  return {
    createdCustomers: 0,
    createdGroups: 0,
    createdDiscounts,
    createdReferrals: 0,
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
    createdDiscounts: 0,
    createdReferrals,
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
      createdDiscounts: 0,
      createdReferrals: 0,
    };
    for (const record of records) {
      const result =
        record.type === 'customer'
          ? await importCustomer(connection, record)
          : record.type === 'held_discount'
            ? await importDiscount(connection, record)
            : await importReferral(connection, record);
      counts.createdCustomers += result.createdCustomers;
      counts.createdGroups += result.createdGroups;
      counts.createdDiscounts += result.createdDiscounts;
      counts.createdReferrals += result.createdReferrals;
    }
    return counts;
  });
}

export async function countRehearsalRows(database: DatabasePool): Promise<{
  customers: number;
  groups: number;
  discounts: number;
  referrals: number;
}> {
  const row = await database.readOne<{
    customers: number;
    groups: number;
    discounts: number;
    referrals: number;
  }>({
    text: `SELECT
      (SELECT count(*)::int FROM rehearsal_customer) AS customers,
      (SELECT count(*)::int FROM rehearsal_customer_group) AS groups,
      (SELECT count(*)::int FROM rehearsal_discount) AS discounts,
      (SELECT count(*)::int FROM rehearsal_confirmed_referral) AS referrals`,
  });
  if (!row) throw new Error('Rehearsal counts were unavailable.');
  return row;
}
