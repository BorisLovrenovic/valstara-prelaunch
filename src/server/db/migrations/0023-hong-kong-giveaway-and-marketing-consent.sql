-- S-01: the giveaway has no location-based entry decision. A populated entry
-- ledger would need a separately authorised migration of historical entries.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM giveaway_entry LIMIT 1) THEN
    RAISE EXCEPTION 'S-01 requires an empty giveaway_entry ledger';
  END IF;
END;
$$;

ALTER TABLE subscriber
  ADD COLUMN marketing_consent_at timestamptz,
  ADD COLUMN marketing_consent_version text,
  ADD COLUMN marketing_consent_source text,
  ADD COLUMN marketing_opt_in_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN marketing_opt_in_pending_version text,
  ADD CONSTRAINT subscriber_marketing_consent_complete CHECK (
    (marketing_consent_at IS NULL AND marketing_consent_version IS NULL AND marketing_consent_source IS NULL)
    OR
    (marketing_consent_at IS NOT NULL AND marketing_consent_version IS NOT NULL AND marketing_consent_source IS NOT NULL)
  ),
  ADD CONSTRAINT subscriber_marketing_consent_source CHECK (
    marketing_consent_source IN ('signup', 'member_status')
  ),
  ADD CONSTRAINT subscriber_marketing_pending_version CHECK (
    marketing_opt_in_pending = (marketing_opt_in_pending_version IS NOT NULL)
  );

REVOKE INSERT (country, region) ON TABLE subscriber FROM valstara_app;
REVOKE SELECT (country, giveaway_eligible) ON TABLE subscriber FROM valstara_app;

ALTER TABLE subscriber
  DROP COLUMN country,
  DROP COLUMN country_detected,
  DROP COLUMN region,
  DROP COLUMN giveaway_eligible;

ALTER TABLE giveaway_entry
  DROP COLUMN jurisdiction,
  DROP CONSTRAINT giveaway_entry_method_check,
  ADD CONSTRAINT giveaway_entry_method_check CHECK (method IN ('base', 'referral'));

GRANT INSERT (marketing_opt_in_pending, marketing_opt_in_pending_version)
  ON TABLE subscriber TO valstara_app;
GRANT SELECT (marketing_consent_at, marketing_consent_version,
              marketing_consent_source, marketing_opt_in_pending,
              marketing_opt_in_pending_version)
  ON TABLE subscriber TO valstara_app;
GRANT UPDATE (marketing_consent_at, marketing_consent_version,
              marketing_consent_source, marketing_opt_in_pending,
              marketing_opt_in_pending_version)
  ON TABLE subscriber TO valstara_app;
