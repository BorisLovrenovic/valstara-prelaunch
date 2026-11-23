// E11.7-06: a migrated scratch database and partner rows in any lifecycle
// status, shared by the partner review, export and command-line tests. This
// module only exports helpers; run on its own it does nothing.
import { randomUUID } from 'node:crypto';

import { runMigrations } from '../../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../../src/server/db/pool.ts';
import type { PartnerStatus } from '../../src/server/db/partner-review.ts';
import { createDsrService } from '../../src/server/dsr/http.ts';
import { createErasureService } from '../../src/server/dsr/service.ts';
import { createVerificationService } from '../../src/server/verification/service.ts';

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
export const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

export interface PartnerFixture {
  readonly owner: DatabasePool;
  readonly app: DatabasePool;
  readonly appDatabaseUrl: string;
  dispose(): Promise<void>;
}

export function partnerErasure(
  fixture: PartnerFixture,
  deleteContact: (email: string) => Promise<void>,
) {
  const clock = () => new Date('2026-11-22T12:00:00.000Z');
  const alerts = { send: async () => assertUnexpected('erasure alert') };
  const erasure = createErasureService(fixture.app, {
    clock,
    deleteContact,
    alerts,
  });
  const execute = createDsrService(fixture.app, {
    clock,
    erasure,
    alerts,
    challenge: async () => assertUnexpected('Turnstile on a signed request'),
  });
  return {
    async signedConfirmation(id: string) {
      const { token } = await createVerificationService(fixture.app, {
        clock,
      }).issue(id, 'dsr_delete');
      const form = new FormData();
      form.set('token', token);
      return () => execute('delete', form, `test-${id}`);
    },
    fulfil: erasure.run,
  };
}

function assertUnexpected(operation: string): never {
  throw new Error(`Unexpected ${operation}.`);
}

export async function createPartnerFixture(
  release: string,
): Promise<PartnerFixture> {
  const name = `valstara_e1176_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = applicationRolePassword;
  const admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const owner = createPool(ownerUrl.toString());
  await runMigrations(owner, { applicationRolePassword, release });
  const app = createPool(appUrl.toString());
  return {
    owner,
    app,
    appDatabaseUrl: appUrl.toString(),
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

export async function insertMember(
  fixture: PartnerFixture,
  options: {
    readonly email?: string;
    readonly status?: string;
    readonly at?: Date;
    readonly marketing?: boolean;
  } = {},
): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = options.email ?? `member-${id.slice(0, 8)}@example.test`;
  const status = options.status ?? 'verified';
  const at = options.at ?? new Date('2026-11-01T10:00:00.000Z');
  await fixture.owner.execute({
    text: `INSERT INTO subscriber (id, email, email_normalised, email_domain,
        status, created_at, verified_at, referral_code, marketing_consent_at,
        marketing_consent_version, marketing_consent_source)
      VALUES ($1, $2, lower($2), 'example.test', $3, $4,
        CASE WHEN $3 = 'verified' THEN $4::timestamptz END,
        CASE WHEN $3 = 'verified' THEN $5 END,
        CASE WHEN $6::boolean THEN $4::timestamptz END,
        CASE WHEN $6::boolean THEN 'v1' END,
        CASE WHEN $6::boolean THEN 'signup' END)`,
    values: [
      id,
      email,
      status,
      at,
      `V${randomUUID().replaceAll('-', '').slice(0, 11).toUpperCase()}`,
      options.marketing === true,
    ],
  });
  return { id, email };
}

export interface InsertedPartner {
  readonly id: string;
  readonly subscriberId: string;
  readonly email: string;
  readonly code: string | null;
}

/**
 * Inserts a partner directly in `status`, with the contract record that status
 * carries, as the owner role (the lifecycle guard allows an insert past
 * `unconfirmed` for a verified member). A partner past `applied` gets a
 * registered code, as `approve` would have given it.
 */
export async function insertPartner(
  fixture: PartnerFixture,
  options: {
    readonly status?: PartnerStatus;
    readonly at?: Date;
    readonly appliedAt?: Date;
    readonly requestedCode?: string;
    readonly code?: string | null;
    readonly partnerType?: string;
    readonly university?: string | null;
    readonly fullName?: string;
    readonly email?: string;
    readonly marketing?: boolean;
    readonly subscriberId?: string;
  } = {},
): Promise<InsertedPartner> {
  const status = options.status ?? 'applied';
  const at = options.at ?? new Date('2026-11-02T10:00:00.000Z');
  const member =
    options.subscriberId === undefined
      ? await insertMember(fixture, {
          ...(options.email === undefined ? {} : { email: options.email }),
          ...(options.marketing === undefined
            ? {}
            : { marketing: options.marketing }),
        })
      : { id: options.subscriberId, email: options.email ?? '' };
  const id = randomUUID();
  const suffix = id.replaceAll('-', '').slice(0, 8).toUpperCase();
  const requestedCode = options.requestedCode ?? `REQ${suffix}`;
  const sent = ['contract_sent', 'active', 'paused', 'terminated'].includes(
    status,
  );
  const signed = ['active', 'paused', 'terminated'].includes(status);
  const partnerType = options.partnerType ?? 'creator';
  const university =
    options.university !== undefined
      ? options.university
      : partnerType === 'student_ambassador'
        ? 'University of Example'
        : null;
  await fixture.owner.execute({
    text: `INSERT INTO partner (id, subscriber_id, status, status_changed_at,
        submitted_at, applied_at, full_name, country_of_residence,
        partner_type, channels, handles, audience_size, promotion_plan,
        requested_code, university, age_confirmed, programme_terms_agreed,
        contract_sent_at, contract_signed_at, contract_version)
      VALUES ($1, $2, $3, $4, $4,
        CASE WHEN $3 = 'unconfirmed' THEN NULL ELSE $5::timestamptz END,
        $6, 'SE', $7, ARRAY['tiktok'], ARRAY['@handle'], '1k_10k',
        'Short videos.', $8, $9, true, true,
        CASE WHEN $10::boolean THEN $4::timestamptz END,
        CASE WHEN $11::boolean THEN ($4 AT TIME ZONE 'UTC')::date END,
        CASE WHEN $11::boolean THEN 'v1' END)`,
    values: [
      id,
      member.id,
      status,
      at,
      options.appliedAt ?? at,
      options.fullName ?? `Partner ${suffix}`,
      partnerType,
      requestedCode,
      university,
      sent,
      signed,
    ],
  });
  let code: string | null = null;
  const registered =
    options.code !== undefined
      ? options.code
      : [
            'approved',
            'contract_sent',
            'active',
            'paused',
            'terminated',
          ].includes(status)
        ? `P${suffix}`
        : null;
  if (registered !== null) {
    await fixture.owner.execute({
      text: `INSERT INTO referral_code (code, owner_kind, owner_id)
        VALUES ($1, 'partner', $2)`,
      values: [registered, id],
    });
    code = registered;
  }
  return { id, subscriberId: member.id, email: member.email, code };
}

/** A referred member with an edge from `referrerId`. */
export async function insertReferral(
  fixture: PartnerFixture,
  referrerId: string,
  options: {
    readonly state?: 'attributed' | 'confirmed';
    readonly voided?: boolean;
    readonly createdAt?: Date;
    readonly confirmedAt?: Date | null;
    readonly email?: string;
  } = {},
): Promise<{ referredId: string; email: string; edgeId: string }> {
  const state = options.state ?? 'confirmed';
  const member = await insertMember(fixture, {
    ...(options.email === undefined ? {} : { email: options.email }),
    status: state === 'attributed' ? 'pending' : 'verified',
  });
  const edgeId = randomUUID();
  const createdAt = options.createdAt ?? new Date('2026-11-05T10:00:00.000Z');
  const confirmedAt =
    options.confirmedAt !== undefined
      ? options.confirmedAt
      : state === 'confirmed'
        ? new Date(createdAt.getTime() + 60_000)
        : null;
  await fixture.owner.execute({
    text: `INSERT INTO referral_edge (id, referrer_id, referred_id, state,
        reward_state, created_at, confirmed_at, voided_at, void_reason, voided_by)
      VALUES ($1, $2, $3, $4,
        CASE WHEN $4 = 'confirmed' THEN 'settled' ELSE 'none' END,
        $5, $6,
        CASE WHEN $7::boolean THEN $5::timestamptz END,
        CASE WHEN $7::boolean THEN 'Test void' END,
        CASE WHEN $7::boolean THEN 'admin.operator' END)`,
    values: [
      edgeId,
      referrerId,
      member.id,
      state,
      createdAt,
      confirmedAt,
      options.voided === true,
    ],
  });
  return { referredId: member.id, email: member.email, edgeId };
}
