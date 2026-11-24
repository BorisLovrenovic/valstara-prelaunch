import type { AccessWindow } from '../referral/config.ts';
import type { DatabaseConnection } from './pool.ts';

interface DashboardOwner {
  readonly id: string;
  readonly subscriber_id: string;
}

export interface LeaderboardNameSettings {
  readonly display_name: string | null;
  readonly display_name_disclosure_version: number | null;
  readonly show_on_leaderboard: boolean;
}

export interface PartnerSettings {
  readonly displayName: string | null;
  readonly showOnLeaderboard: boolean;
  readonly nonessentialEmailEnabled: boolean;
  readonly displayNameDisclosureVersion: number | null;
}

interface CurrentLink extends DashboardOwner {
  readonly expires_at: Date;
  readonly link_id: string;
}

export interface PartnerDashboardRow
  extends CurrentLink, LeaderboardNameSettings {
  readonly status: 'active' | 'paused';
  readonly code: string;
  readonly partner_type: string;
  readonly contract_signed_at: string;
  readonly contract_version: string;
  readonly nonessential_email_enabled: boolean;
  readonly access_window: AccessWindow | null;
  readonly verification_order_window: AccessWindow | null;
  readonly partner_referral: boolean;
  readonly active_code: boolean;
  readonly confirmed: number;
  readonly pending: number;
  readonly voided: number;
  readonly weeks: readonly { week: string; count: number }[];
  readonly categories: Readonly<Record<string, number>>;
}

const eligible = `p.status IN ('active', 'paused')
  AND p.personal_data_purged_at IS NULL
  AND s.status NOT IN ('erasure_pending', 'erased')`;

const currentLink = `FROM partner p
    JOIN subscriber s ON s.id = p.subscriber_id
    JOIN verification_token t ON t.id = p.dashboard_token_id
      AND t.subscriber_id = s.id AND t.purpose = 'partner_dashboard'`;

export function createPartnerDashboardRepository(database: DatabaseConnection) {
  return {
    // Lock in subscriber -> partner order, as activation and erasure do.
    lockSubscriberForRecovery(address: string) {
      return database.readOne<{ id: string }>({
        text: `SELECT id FROM subscriber
          WHERE email_normalised = $1
            AND status NOT IN ('erasure_pending', 'erased') FOR UPDATE`,
        values: [address],
      });
    },

    lockEligibleOwner(subscriberId: string) {
      return database.readOne<DashboardOwner>({
        text: `SELECT p.id, p.subscriber_id FROM partner p
          JOIN subscriber s ON s.id = p.subscriber_id
          WHERE s.id = $1 AND ${eligible} FOR UPDATE OF p`,
        values: [subscriberId],
      });
    },

    setCurrentLink(partnerId: string, tokenId: string) {
      return database.execute({
        text: 'UPDATE partner SET dashboard_token_id = $2 WHERE id = $1',
        values: [partnerId, tokenId],
      });
    },

    read(tokenHash: Buffer, now: Date, surveyVersion: string) {
      return database.readOne<PartnerDashboardRow>({
        text: `
          WITH owner AS (
            SELECT p.id, p.subscriber_id, p.status, p.partner_type, c.code,
              p.contract_signed_at::text, p.contract_version,
              p.display_name, p.display_name_disclosure_version,
              p.show_on_leaderboard, p.nonessential_email_enabled,
              s.access_window, s.verification_order_window,
              (c.active AND s.status = 'verified') AS active_code,
              t.id AS link_id, t.expires_at,
              (EXISTS (
                SELECT 1 FROM referral_edge personal_edge
                WHERE personal_edge.referred_id = s.id
                  AND personal_edge.partner_id IS NOT NULL
                  AND personal_edge.state = 'confirmed' AND personal_edge.voided_at IS NULL
              ) OR EXISTS (
                SELECT 1 FROM retained_partner_entitlement r
                WHERE r.subscriber_id = s.id AND r.wave_one
              )) AS partner_referral
            ${currentLink}
            JOIN referral_code c ON c.owner_kind = 'partner' AND c.owner_id = p.id
            WHERE ${eligible} AND t.token_hash = $1 AND t.expires_at > $2
          ), owned AS (
            SELECT e.state, e.voided_at, e.created_at, e.referred_id
            FROM referral_edge e JOIN owner o ON o.subscriber_id = e.referrer_id
          ), confirmed AS (
            SELECT created_at, referred_id FROM owned
            WHERE state = 'confirmed' AND voided_at IS NULL
          ), weeks AS (
            SELECT date_trunc('week', created_at AT TIME ZONE 'UTC')::date::text AS week,
              count(*)::int AS count
            FROM confirmed GROUP BY week
          ), categories AS (
            SELECT category, count(DISTINCT c.referred_id)::int AS count
            FROM confirmed c JOIN survey_response r ON r.subscriber_id = c.referred_id
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(r.answers->'category_preference') = 'array'
                THEN r.answers->'category_preference' ELSE '[]' END
            ) a(category)
            WHERE r.version = $3
            GROUP BY category
          )
          SELECT o.*, (SELECT count(*)::int FROM confirmed) AS confirmed,
            (SELECT count(*)::int FROM owned e JOIN subscriber f ON f.id = e.referred_id
              WHERE e.state = 'attributed' AND e.voided_at IS NULL AND f.status = 'pending') AS pending,
            (SELECT count(*)::int FROM owned WHERE voided_at IS NOT NULL) AS voided,
            COALESCE((SELECT jsonb_agg(weeks ORDER BY week DESC) FROM weeks), '[]') AS weeks,
            COALESCE((SELECT jsonb_object_agg(category, count) FROM categories), '{}') AS categories
          FROM owner o
        `,
        values: [tokenHash, now, surveyVersion],
      });
    },

    lockLinkSubscriber(partnerId: string, linkId: string) {
      return database.readOne<{ id: string }>({
        text: `SELECT s.id ${currentLink}
          WHERE p.id = $1 AND t.id = $2 AND ${eligible} FOR UPDATE OF s`,
        values: [partnerId, linkId],
      });
    },

    lockCurrentLink(partnerId: string, linkId: string) {
      return database.readOne<CurrentLink & LeaderboardNameSettings>({
        text: `SELECT p.id, p.subscriber_id, t.id AS link_id, t.expires_at,
          p.display_name, p.display_name_disclosure_version, p.show_on_leaderboard
          ${currentLink}
          WHERE p.id = $1 AND t.id = $2 AND ${eligible}
          FOR UPDATE OF p`,
        values: [partnerId, linkId],
      });
    },

    consumeSettings(input: {
      readonly id: string;
      readonly subscriberId: string;
      readonly hash: Buffer;
      readonly expiresAt: Date;
      readonly now: Date;
    }) {
      return database.execute({
        text: `INSERT INTO verification_token
          (id, subscriber_id, token_hash, purpose, expires_at, consumed_at)
          VALUES ($1, $2, $3, 'partner_dashboard_settings', $4, $5)
          ON CONFLICT DO NOTHING`,
        values: [
          input.id,
          input.subscriberId,
          input.hash,
          input.expiresAt,
          input.now,
        ],
      });
    },

    saveSettings(partnerId: string, settings: PartnerSettings) {
      return database.execute({
        text: `UPDATE partner SET display_name = $2, show_on_leaderboard = $3,
          nonessential_email_enabled = $4, display_name_disclosure_version = $5
          WHERE id = $1`,
        values: [
          partnerId,
          settings.displayName,
          settings.showOnLeaderboard,
          settings.nonessentialEmailEnabled,
          settings.displayNameDisclosureVersion,
        ],
      });
    },
  };
}
