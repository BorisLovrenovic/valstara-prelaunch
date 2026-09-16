-- E5-04: least-privilege access for the batch-capped fraud review queue and
-- its audited state transition. Disqualification remains outside this grant;
-- E5-05 owns that later transition and its related subscriber/referral writes.

GRANT SELECT (
  id,
  subscriber_id,
  kind,
  detail,
  state,
  reviewed_by,
  reviewed_at,
  created_at
) ON TABLE fraud_flag TO valstara_app;

GRANT UPDATE (state, reviewed_by, reviewed_at)
  ON TABLE fraud_flag TO valstara_app;

GRANT SELECT (country) ON TABLE subscriber TO valstara_app;
