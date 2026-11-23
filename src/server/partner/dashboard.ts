import { randomUUID, timingSafeEqual } from 'node:crypto';

import { redactAuditDetail } from '../audit/redact-detail.ts';
import {
  createPartnerDashboardRepository,
  type PartnerSettings,
} from '../db/partner-dashboard.ts';
import type { DatabasePool } from '../db/pool.ts';
import { createRateLimitBucketRepository } from '../db/rate-limit-bucket.ts';
import { withTransaction } from '../db/transaction.ts';
import { currentSurveyVersion } from '../survey/questions.ts';
import {
  deriveEmailToken,
  hashEmailToken,
} from '../verification/token-derivation.ts';

import {
  partnerApplicationIpWindowMs,
  partnerConfirmationIpLimit,
} from './config.ts';

export const dashboardPath = '/partners/dashboard';
export const dashboardRecoveryPath =
  '/partners/apply?operation=dashboard-recovery';
export const displayNameMaxLength = 200;

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const settingsShape = new RegExp(
  `^(${uuid})[.](${uuid})[.](${uuid})[.]([A-Za-z0-9_-]{43})$`,
  'u',
);
const bearerShape = /^[A-Za-z0-9_-]{43}$/u;

function signaturesMatch(expected: string, supplied: string) {
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function signSettings(partnerId: string, linkId: string, secret: string) {
  const claims = `${partnerId}.${linkId}.${randomUUID()}`;
  return `${claims}.${deriveEmailToken(`partner_dashboard_settings:${claims}`, secret)}`;
}

function verifySettings(token: string, secret: string) {
  const match = settingsShape.exec(token);
  if (match === null) return null;
  const [, partnerId, linkId, nonce, signature] = match as RegExpExecArray &
    [string, string, string, string, string];
  const expected = deriveEmailToken(
    `partner_dashboard_settings:${partnerId}.${linkId}.${nonce}`,
    secret,
  );
  return signaturesMatch(expected, signature)
    ? { partnerId, linkId, nonce }
    : null;
}

export function readPartnerSettings(form: FormData): PartnerSettings | null {
  const names = form.getAll('display_name');
  const raw = names[0];
  const show = form.getAll('show_on_leaderboard');
  const nonessential = form.getAll('nonessential_email_enabled');
  if (
    names.length !== 1 ||
    typeof raw !== 'string' ||
    show.length > 1 ||
    (show.length === 1 && show[0] !== 'yes') ||
    nonessential.length > 1 ||
    (nonessential.length === 1 && nonessential[0] !== 'yes')
  ) {
    return null;
  }
  const name = raw.trim();
  const showOnLeaderboard = show.length === 1;
  if (
    name.length > displayNameMaxLength ||
    /[\p{Cc}\p{Bidi_Control}]/u.test(name) ||
    redactAuditDetail({ value: name }).value !== name ||
    (showOnLeaderboard && name === '')
  ) {
    return null;
  }
  return {
    displayName: name || null,
    showOnLeaderboard,
    nonessentialEmailEnabled: nonessential.length === 1,
  };
}

export type DashboardSettingsOutcome =
  | { readonly kind: 'invalid' | 'rate_limited' | 'paused' | 'unavailable' }
  | { readonly kind: 'invalid_input' | 'saved'; readonly bearer: string };

interface DashboardDependencies {
  readonly clock?: () => Date;
  readonly isEnabled: () => Promise<boolean>;
  readonly tokenSecret: string;
}

class Rollback extends Error {
  constructor(readonly kind: 'rate_limited' | 'paused') {
    super(kind);
  }
}

export function createPartnerDashboardService(
  database: DatabasePool,
  dependencies: DashboardDependencies,
) {
  const { isEnabled, tokenSecret } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async read(bearer: string) {
      if (!(await isEnabled())) return { kind: 'paused' } as const;
      if (!bearerShape.test(bearer)) return { kind: 'invalid' } as const;

      const row = await createPartnerDashboardRepository(database).read(
        hashEmailToken(bearer),
        clock(),
        currentSurveyVersion,
      );
      if (
        row === null ||
        !signaturesMatch(deriveEmailToken(row.link_id, tokenSecret), bearer)
      ) {
        return { kind: 'invalid' } as const;
      }
      return {
        kind: 'authenticated',
        row,
        settingsToken: signSettings(row.id, row.link_id, tokenSecret),
      } as const;
    },

    async save(
      form: FormData,
      hashedPrefix: string | null,
    ): Promise<DashboardSettingsOutcome> {
      const token = form.get('settings_token');
      const claims =
        typeof token === 'string' && form.getAll('settings_token').length === 1
          ? verifySettings(token, tokenSecret)
          : null;

      try {
        return await withTransaction(database, async (connection) => {
          const repository = createPartnerDashboardRepository(connection);
          const link =
            claims !== null &&
            (await repository.lockLinkSubscriber(
              claims.partnerId,
              claims.linkId,
            )) !== null
              ? await repository.lockCurrentLink(
                  claims.partnerId,
                  claims.linkId,
                )
              : null;
          const now = clock();
          // Claim the nonce first. A replaced link or a competing submit cannot
          // insert a usable claim. A failed write rolls its claim back.
          const consumed =
            claims !== null &&
            link !== null &&
            typeof token === 'string' &&
            link.expires_at > now &&
            (await repository.consumeSettings({
              id: claims.nonce,
              subscriberId: link.subscriber_id,
              expiresAt: link.expires_at,
              hash: hashEmailToken(token),
              now,
            })) === 1;

          if (
            hashedPrefix === null ||
            (await createRateLimitBucketRepository(connection).consume(
              `partner-dashboard:settings:ip:${hashedPrefix}`,
              now,
              new Date(now.getTime() - partnerApplicationIpWindowMs),
            )) > partnerConfirmationIpLimit
          ) {
            throw new Rollback('rate_limited');
          }
          if (!(await isEnabled())) throw new Rollback('paused');
          if (!consumed || link === null) return { kind: 'invalid' };

          const bearer = deriveEmailToken(link.link_id, tokenSecret);
          const settings = readPartnerSettings(form);
          if (settings === null) return { kind: 'invalid_input', bearer };
          if ((await repository.saveSettings(link.id, settings)) !== 1) {
            throw new Error('The partner settings could not be updated.');
          }
          return { kind: 'saved', bearer };
        });
      } catch (error) {
        if (error instanceof Rollback) return { kind: error.kind };
        return { kind: 'unavailable' };
      }
    },
  };
}
