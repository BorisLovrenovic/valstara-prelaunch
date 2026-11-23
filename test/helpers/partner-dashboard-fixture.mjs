import { randomUUID } from 'node:crypto';
import {
  deriveEmailToken,
  hashEmailToken,
} from '../../src/server/verification/token-derivation.ts';

// Attach a separately authenticated partner surface to an existing verified
// subscriber in the accessibility and rendered-privacy fixtures.
export async function seedPartnerDashboard(database, subscriberId, secret) {
  const partnerId = randomUUID();
  const linkId = randomUUID();
  const token = deriveEmailToken(linkId, secret);
  await database.query(
    `INSERT INTO partner (id, subscriber_id, status, status_changed_at,
      submitted_at, applied_at, full_name, country_of_residence, partner_type,
      channels, handles, audience_size, promotion_plan, requested_code,
      age_confirmed, programme_terms_agreed, contract_sent_at, contract_signed_at,
      contract_version)
    VALUES ($1, $2, 'active', '2026-11-02Z', '2026-11-02Z', '2026-11-02Z',
      'Dashboard Fixture', 'SE', 'creator', ARRAY['tiktok'], ARRAY['@fixture'],
      'under_1k', 'A video', 'DASHBOARD2345', true, true, '2026-11-02Z',
      '2026-11-02', 'fixture-v1')`,
    [partnerId, subscriberId],
  );
  await database.query(
    "INSERT INTO referral_code (code, owner_kind, owner_id) VALUES ('DASHBOARD2345', 'partner', $1)",
    [partnerId],
  );
  await database.query('SELECT set_partner_code_active($1, true)', [partnerId]);
  await database.query(
    `INSERT INTO verification_token (id, subscriber_id, token_hash, purpose, expires_at)
      VALUES ($1, $2, $3, 'partner_dashboard', '2099-01-01Z')`,
    [linkId, subscriberId, hashEmailToken(token)],
  );
  await database.query(
    'UPDATE partner SET dashboard_token_id = $2 WHERE id = $1',
    [partnerId, linkId],
  );
  return { partnerId, token };
}
