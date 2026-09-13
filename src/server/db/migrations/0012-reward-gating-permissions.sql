-- E4-06: the application role needs only the columns used by the bounded
-- campaign-close reconciliation. The table owner continues to run migrations.

GRANT SELECT (id, subscriber_id, tier, reward_kind, awarded_at, state)
  ON TABLE milestone_award TO valstara_app;
GRANT UPDATE (state) ON TABLE milestone_award TO valstara_app;

GRANT SELECT (id, referrer_id, referred_id, state, reward_state, confirmed_at, created_at)
  ON TABLE referral_edge TO valstara_app;
