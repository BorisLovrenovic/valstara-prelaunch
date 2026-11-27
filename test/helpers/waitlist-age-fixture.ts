// E11.8-06: a migrated scratch database and the member fixtures the 13+
// waitlist suites share. Exports only; running this file does nothing.
import { createHash, randomUUID } from 'node:crypto';

import { runMigrations } from '../../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../../src/server/db/pool.ts';
import { createFlagService } from '../../src/server/flags/service.ts';
import type { FlagService } from '../../src/server/flags/types.ts';
import type { CurrentGiveawayRules } from '../../src/server/giveaway/accrue.ts';
import type {
  AgePolicy,
  GiveawayOptInSource,
  WaitlistAgeSettings,
} from '../../src/server/giveaway/age-policy.ts';
import { deriveEmailToken } from '../../src/server/verification/token-derivation.ts';

const baseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

/** Rules that permit entry by verification alone: every published revision. */
export const legacyRules: CurrentGiveawayRules = {
  rulesVersion: 'VAL-GW-LAUNCH-20261126-r1',
  sha256: 'ab'.repeat(32),
};

/** A revision that makes the 18+ box the way to enter, as E11.8-07's will. */
export const boxRules: CurrentGiveawayRules = {
  rulesVersion: 'VAL-GW-LAUNCH-20270101-r1',
  sha256: 'cd'.repeat(32),
  entryRequiresGiveawayBox: true,
};

/** The shipped settings, except that tests may switch the flag on. */
export function testSettings(
  referralEntryWithoutGiveawayBox = false,
): WaitlistAgeSettings {
  return { reviewedWordingInPlace: true, referralEntryWithoutGiveawayBox };
}

/** Inside the entry period, which runs from 1 October 2026 to 1 September 2027. */
export const signupTime = new Date('2026-10-05T09:00:00.000Z');
export const verifyTime = new Date('2026-10-06T09:00:00.000Z');
export const laterTime = new Date('2026-10-20T09:00:00.000Z');
export const entriesClosed = new Date('2027-09-01T00:00:00.000Z');

export interface AgeFixture {
  readonly owner: DatabasePool;
  readonly app: DatabasePool;
  /** A flag service on the app role whose enable command is permitted. */
  flags(settings?: WaitlistAgeSettings): FlagService;
  dispose(): Promise<void>;
}

export async function ageFixture(label: string): Promise<AgeFixture> {
  const name = `valstara_age13_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword: appPassword,
    release: label,
  });
  const app = createPool(appUrl.toString());
  return {
    owner,
    app,
    flags: (settings = testSettings()) =>
      createFlagService(app, {
        emailQuota: {
          resend: { tier: 'paid', cap: 101 },
          brevo: { tier: 'paid', cap: 301 },
        },
        currentRules: async () => legacyRules,
        waitlistAgeSettings: settings,
      }),
    async dispose() {
      await app.close();
      await owner.close();
      await admin.list(
        {
          text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          values: [name],
        },
        10,
      );
      await admin.execute({ text: `DROP DATABASE "${name}"` });
      await admin.close();
    },
  };
}

export interface MemberInput {
  readonly status?: 'pending' | 'verified';
  readonly admission?: AgePolicy;
  readonly optIn?: GiveawayOptInSource;
  readonly optInAt?: Date;
  readonly createdAt?: Date;
  readonly verifiedAt?: Date;
}

/** Inserts a member directly, as the owner, with every age fact explicit. */
export async function insertMember(
  owner: DatabasePool,
  input: MemberInput = {},
): Promise<string> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  const status = input.status ?? 'verified';
  const createdAt = input.createdAt ?? signupTime;
  await owner.execute({
    text: `INSERT INTO subscriber
             (id, email, email_normalised, email_domain, status, verified_at,
              created_at, updated_at, admission_age_policy,
              giveaway_opt_in_at, giveaway_opt_in_source)
           VALUES ($1, $2, $2, 'example.test', $3, $4, $5, $5, $6, $7, $8)`,
    values: [
      id,
      email,
      status,
      status === 'verified' ? (input.verifiedAt ?? verifyTime) : null,
      createdAt,
      input.admission ?? '18_plus',
      input.optIn === undefined ? null : (input.optInAt ?? createdAt),
      input.optIn ?? null,
    ],
  });
  return id;
}

/** A signed `verify` or `status` token for the member, valid for a year. */
export async function insertToken(
  owner: DatabasePool,
  subscriberId: string,
  purpose: 'verify' | 'status' = 'verify',
): Promise<string> {
  const tokenId = randomUUID();
  const token = deriveEmailToken(tokenId, process.env.EMAIL_TOKEN_SECRET!);
  await owner.execute({
    text: `INSERT INTO verification_token
             (id, subscriber_id, token_hash, purpose, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
    values: [
      tokenId,
      subscriberId,
      createHash('sha256').update(token).digest(),
      purpose,
      new Date('2027-12-31T00:00:00.000Z'),
    ],
  });
  return token;
}

/** An attributed edge, confirmed when the referred member verifies. */
export async function insertEdge(
  owner: DatabasePool,
  referrerId: string,
  referredId: string,
  confirmedAt?: Date,
): Promise<string> {
  const id = randomUUID();
  await owner.execute({
    text: `INSERT INTO referral_edge
             (id, referrer_id, referred_id, state, reward_state, confirmed_at)
           VALUES ($1, $2, $3, $4, 'none', $5)`,
    values: [
      id,
      referrerId,
      referredId,
      confirmedAt === undefined ? 'attributed' : 'confirmed',
      confirmedAt ?? null,
    ],
  });
  await owner.execute({
    text: 'UPDATE subscriber SET referred_by_id = $2 WHERE id = $1',
    values: [referredId, referrerId],
  });
  return id;
}

export interface EntryRow {
  readonly method: 'base' | 'referral';
  readonly source_edge_id: string | null;
  readonly rules_version: string;
}

export async function entriesOf(
  owner: DatabasePool,
  subscriberId: string,
): Promise<readonly EntryRow[]> {
  return owner.list<EntryRow>(
    {
      text: `SELECT method, source_edge_id::text, rules_version
             FROM giveaway_entry
             WHERE subscriber_id = $1 AND voided_at IS NULL
             ORDER BY method, source_edge_id NULLS FIRST`,
      values: [subscriberId],
    },
    1_000,
  );
}
