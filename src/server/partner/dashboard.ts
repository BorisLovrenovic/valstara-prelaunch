import { randomUUID, timingSafeEqual } from 'node:crypto';

import { redactAuditDetail } from '../audit/redact-detail.ts';
import {
  createPartnerDashboardRepository,
  type LeaderboardNameSettings,
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
  displayNameDisclosureVersion,
  partnerApplicationIpWindowMs,
  partnerConfirmationIpLimit,
} from './config.ts';
import { readPartnerLeaderboard } from './leaderboard.ts';

export const displayNameMaxLength = 200;

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const settingsShape = new RegExp(
  `^(${uuid})[.](${uuid})[.](${uuid})[.]${displayNameDisclosureVersion}[.]([01])[.]([A-Za-z0-9_-]{43})$`,
  'u',
);
const bearerShape = /^[A-Za-z0-9_-]{43}$/u;

function signaturesMatch(expected: string, supplied: string) {
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function signSettings(
  partnerId: string,
  linkId: string,
  needsNameConfirmation: boolean,
  secret: string,
) {
  const claims = `${partnerId}.${linkId}.${randomUUID()}.${displayNameDisclosureVersion}.${needsNameConfirmation ? '1' : '0'}`;
  return `${claims}.${deriveEmailToken(`partner_dashboard_settings:${claims}`, secret)}`;
}

function verifySettings(token: string, secret: string) {
  const match = settingsShape.exec(token);
  if (match === null) return null;
  const [, partnerId, linkId, nonce, confirmation, signature] =
    match as RegExpExecArray & [string, string, string, string, string, string];
  const expected = deriveEmailToken(
    `partner_dashboard_settings:${partnerId}.${linkId}.${nonce}.${displayNameDisclosureVersion}.${confirmation}`,
    secret,
  );
  return signaturesMatch(expected, signature)
    ? { partnerId, linkId, nonce, needsNameConfirmation: confirmation === '1' }
    : null;
}

export function readPartnerSettings(form: FormData) {
  const names = form.getAll('display_name');
  const raw = names[0];
  const show = form.getAll('show_on_leaderboard');
  const confirm = form.getAll('confirm_leaderboard_name');
  const nonessential = form.getAll('nonessential_email_enabled');
  if (
    names.length !== 1 ||
    typeof raw !== 'string' ||
    show.length > 1 ||
    (show.length === 1 && show[0] !== 'yes') ||
    confirm.length > 1 ||
    (confirm.length === 1 && confirm[0] !== 'yes') ||
    nonessential.length > 1 ||
    (nonessential.length === 1 && nonessential[0] !== 'yes')
  ) {
    return null;
  }
  const name = raw.trim();
  if (
    name.length > displayNameMaxLength ||
    /[\p{Cc}\p{Bidi_Control}]/u.test(name) ||
    redactAuditDetail({ value: name }).value !== name
  ) {
    return null;
  }
  return {
    displayName: name || null,
    showOnLeaderboard: name !== '' && show.length === 1,
    confirmLeaderboardName: confirm.length === 1,
    nonessentialEmailEnabled: nonessential.length === 1,
  };
}

function needsLeaderboardNameConfirmation(settings: LeaderboardNameSettings) {
  return (
    settings.display_name !== null &&
    settings.display_name_disclosure_version !== displayNameDisclosureVersion
  );
}

function qualifyName(
  {
    confirmLeaderboardName,
    ...settings
  }: NonNullable<ReturnType<typeof readPartnerSettings>>,
  stored: LeaderboardNameSettings,
  issuedWithConfirmation: boolean,
): PartnerSettings {
  const needsConfirmation =
    issuedWithConfirmation || needsLeaderboardNameConfirmation(stored);
  if (
    settings.displayName === null ||
    !needsConfirmation ||
    confirmLeaderboardName
  ) {
    return {
      ...settings,
      displayNameDisclosureVersion:
        settings.displayName === null ? null : displayNameDisclosureVersion,
    };
  }
  // An open form that asked for confirmation cannot publish a name after
  // another form clears it. An email-only save preserves current name consent.
  const unchanged = settings.displayName === stored.display_name;
  return {
    ...settings,
    showOnLeaderboard: unchanged && stored.show_on_leaderboard,
    displayNameDisclosureVersion: unchanged
      ? stored.display_name_disclosure_version
      : null,
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
  readonly kind: 'rate_limited' | 'paused';

  constructor(kind: 'rate_limited' | 'paused') {
    super(kind);
    this.kind = kind;
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
      const needsNameConfirmation = needsLeaderboardNameConfirmation(row);
      return {
        kind: 'authenticated',
        row,
        settingsToken: signSettings(
          row.id,
          row.link_id,
          needsNameConfirmation,
          tokenSecret,
        ),
        needsNameConfirmation,
        leaderboard: await readPartnerLeaderboard(database, row.id),
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
          if (!consumed || link === null || claims === null)
            return { kind: 'invalid' };

          const bearer = deriveEmailToken(link.link_id, tokenSecret);
          const settings = readPartnerSettings(form);
          if (settings === null) return { kind: 'invalid_input', bearer };
          if (
            (await repository.saveSettings(
              link.id,
              qualifyName(settings, link, claims.needsNameConfirmation),
            )) !== 1
          ) {
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
