-- E11.7-09: the current link and settings are subject-scoped through partner.
-- Tokens reuse verification_token's hash-only storage, purge and erasure.
ALTER TABLE verification_token DROP CONSTRAINT verification_token_purpose_check;
ALTER TABLE verification_token ADD CONSTRAINT verification_token_purpose_check
  CHECK (purpose IN (
    'verify', 'status', 'unsubscribe', 'dsr_export', 'dsr_delete',
    'partner_application', 'partner_dashboard', 'partner_dashboard_settings'
  ));
ALTER TABLE verification_token ADD CONSTRAINT partner_settings_token_consumption
  CHECK (purpose <> 'partner_dashboard_settings'
    OR (consumed_at IS NOT NULL AND consumed_at < expires_at));
GRANT INSERT (consumed_at) ON verification_token TO valstara_app;

ALTER TABLE partner
  ADD COLUMN dashboard_token_id uuid UNIQUE REFERENCES verification_token (id) ON DELETE SET NULL,
  ADD COLUMN display_name text,
  ADD COLUMN show_on_leaderboard boolean NOT NULL DEFAULT false,
  ADD COLUMN nonessential_email_enabled boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT partner_display_name CHECK (
    display_name IS NULL OR (btrim(display_name) <> '' AND char_length(display_name) <= 200)
  ),
  ADD CONSTRAINT partner_leaderboard_name CHECK (
    NOT show_on_leaderboard OR display_name IS NOT NULL
  ),
  ADD CONSTRAINT partner_dashboard_eligible CHECK (
    dashboard_token_id IS NULL OR (subscriber_id IS NOT NULL AND status IN ('active', 'paused'))
  ),
  ADD CONSTRAINT partner_dashboard_purged CHECK (
    personal_data_purged_at IS NULL OR (
      dashboard_token_id IS NULL AND display_name IS NULL
      AND NOT show_on_leaderboard AND NOT nonessential_email_enabled
    )
  );

CREATE FUNCTION guard_partner_dashboard_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.personal_data_purged_at IS NOT NULL THEN
    NEW.dashboard_token_id := NULL;
    NEW.display_name := NULL;
    NEW.show_on_leaderboard := false;
    NEW.nonessential_email_enabled := false;
  ELSIF NEW.status = 'terminated' THEN
    NEW.dashboard_token_id := NULL;
  END IF;
  IF NEW.dashboard_token_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM verification_token
    WHERE id = NEW.dashboard_token_id AND subscriber_id = NEW.subscriber_id
      AND purpose = 'partner_dashboard'
  ) THEN
    RAISE EXCEPTION 'the dashboard token must belong to this partner';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER partner_dashboard_link_guard
  BEFORE INSERT OR UPDATE OF dashboard_token_id, subscriber_id, status, personal_data_purged_at
  ON partner FOR EACH ROW EXECUTE FUNCTION guard_partner_dashboard_link();

GRANT UPDATE (dashboard_token_id, display_name, show_on_leaderboard, nonessential_email_enabled)
  ON partner TO valstara_app;
