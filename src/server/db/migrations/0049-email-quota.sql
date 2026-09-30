-- E8-09: preserve provider acceptance time separately from webhook updates.
ALTER TABLE email_send ADD COLUMN accepted_at timestamptz;
ALTER TABLE email_send ADD CONSTRAINT email_send_acceptance_has_provider_id
  CHECK (accepted_at IS NULL OR provider_message_id IS NOT NULL);
CREATE FUNCTION prevent_email_acceptance_reassignment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    RAISE EXCEPTION 'email_send.accepted_at is write-once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER email_send_acceptance_write_once
BEFORE UPDATE OF accepted_at ON email_send
FOR EACH ROW EXECUTE FUNCTION prevent_email_acceptance_reassignment();
CREATE INDEX idx_email_send_quota_accepted
  ON email_send (provider, accepted_at) WHERE accepted_at IS NOT NULL;

CREATE TABLE email_quota_alert (
  provider text NOT NULL CHECK (provider IN ('resend', 'brevo')),
  day date NOT NULL,
  severity text NOT NULL CHECK (severity IN ('P1', 'P2')),
  alerted_at timestamptz NOT NULL,
  PRIMARY KEY (provider, day, severity)
);

GRANT SELECT (provider, accepted_at) ON email_send TO valstara_app;
GRANT UPDATE (accepted_at) ON email_send TO valstara_app;
GRANT SELECT (sent_at) ON email_seed_test TO valstara_app;
GRANT SELECT (sent_at) ON email_broadcast_seed_test TO valstara_app;
GRANT SELECT (status, marketing_consent_at, email_normalised)
  ON subscriber TO valstara_app;
GRANT SELECT (email_normalised) ON suppression TO valstara_app;
GRANT SELECT, INSERT ON email_quota_alert TO valstara_app;
