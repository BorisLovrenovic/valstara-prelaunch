-- Complete the least-privilege application-role grants for every runtime query
-- delivered through E3. Migrations continue to run as the owner role.

GRANT SELECT (
  id,
  status,
  email_normalised,
  created_at,
  email_domain,
  verified_at,
  referral_code,
  confirmed_referrals,
  referral_tier,
  access_window
) ON TABLE subscriber TO valstara_app;
GRANT INSERT (
  id,
  email,
  email_normalised,
  email_domain,
  country,
  region,
  status
) ON TABLE subscriber TO valstara_app;
GRANT UPDATE (
  status,
  verified_at,
  expired_at,
  updated_at,
  referral_code,
  confirmed_referrals,
  referral_tier,
  access_window
) ON TABLE subscriber TO valstara_app;

GRANT SELECT (id, subscriber_id, token_hash, purpose, expires_at, consumed_at)
  ON TABLE verification_token TO valstara_app;
GRANT INSERT (id, subscriber_id, token_hash, purpose, expires_at)
  ON TABLE verification_token TO valstara_app;
GRANT UPDATE (consumed_at) ON TABLE verification_token TO valstara_app;
GRANT DELETE ON TABLE verification_token TO valstara_app;

GRANT SELECT (id, referrer_id, referred_id, state)
  ON TABLE referral_edge TO valstara_app;
GRANT UPDATE (state, reward_state, confirmed_at)
  ON TABLE referral_edge TO valstara_app;

GRANT INSERT (id, subscriber_id, tier, reward_kind, state, awarded_at)
  ON TABLE milestone_award TO valstara_app;

GRANT SELECT (id, business_key) ON TABLE email_send TO valstara_app;
GRANT INSERT (id, subscriber_id, template, provider, business_key, state)
  ON TABLE email_send TO valstara_app;

GRANT SELECT (subscriber_id, kind, state) ON TABLE fraud_flag TO valstara_app;
GRANT INSERT (id, subscriber_id, kind, detail, state)
  ON TABLE fraud_flag TO valstara_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rate_limit_bucket TO valstara_app;
