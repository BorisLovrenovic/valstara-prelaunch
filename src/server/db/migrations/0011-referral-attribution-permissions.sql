-- E4-03 creates attributed referral edges and stamps the referrer once. The
-- application role receives only the columns required for that operation.
GRANT SELECT (referred_by_id) ON TABLE subscriber TO valstara_app;
GRANT UPDATE (referred_by_id, updated_at) ON TABLE subscriber TO valstara_app;
GRANT INSERT (id, referrer_id, referred_id, state, reward_state)
  ON TABLE referral_edge TO valstara_app;
