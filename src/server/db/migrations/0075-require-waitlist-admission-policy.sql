-- E11.8-06: a CHECK must evaluate to false for a live row with a NULL
-- admission policy. A comparison against the allowed values alone is unknown.
ALTER TABLE subscriber
  DROP CONSTRAINT subscriber_admission_age_policy_shape,
  ADD CONSTRAINT subscriber_admission_age_policy_shape CHECK (
    (status = 'erased' AND admission_age_policy IS NULL) OR
    (status <> 'erased' AND admission_age_policy IS NOT NULL
      AND admission_age_policy IN ('18_plus', '13_plus'))
  );
