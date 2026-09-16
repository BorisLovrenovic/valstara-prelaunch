-- E5-05: a disqualification is reversible without guessing the subscriber or
-- referral state that the human decision replaced. The application role gets
-- only the columns used by the transactional review transition.

ALTER TABLE subscriber
  ADD COLUMN disqualification_previous_status text
    CHECK (disqualification_previous_status IN ('pending', 'verified', 'expired', 'unsubscribed', 'bounced')),
  ADD COLUMN disqualified_by_flag_id uuid REFERENCES fraud_flag(id);

ALTER TABLE referral_edge
  ADD COLUMN state_before_rejection text
    CHECK (state_before_rejection IN ('attributed', 'confirmed'));

ALTER TABLE giveaway_entry
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by_disqualification_flag_id uuid REFERENCES fraud_flag(id);

GRANT SELECT (status, disqualification_previous_status, disqualified_by_flag_id)
  ON TABLE subscriber TO valstara_app;
GRANT UPDATE (
  status,
  disqualified_at,
  disqualification_previous_status,
  disqualified_by_flag_id,
  updated_at
) ON TABLE subscriber TO valstara_app;

GRANT SELECT (id, referrer_id, state, rejected_reason, state_before_rejection)
  ON TABLE referral_edge TO valstara_app;
GRANT UPDATE (state, rejected_reason, state_before_rejection)
  ON TABLE referral_edge TO valstara_app;

GRANT SELECT (id, subscriber_id, method, voided_at, voided_by_disqualification_flag_id)
  ON TABLE giveaway_entry TO valstara_app;
GRANT UPDATE (voided_at, voided_by_disqualification_flag_id)
  ON TABLE giveaway_entry TO valstara_app;
