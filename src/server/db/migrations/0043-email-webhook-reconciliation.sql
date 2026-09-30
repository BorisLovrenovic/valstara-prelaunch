-- E8-06: opaque webhook idempotency and one alert per missing terminal event.
CREATE TABLE email_webhook_event (
  provider text NOT NULL CHECK (provider IN ('resend', 'brevo')),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 256),
  PRIMARY KEY (provider, event_key)
);

CREATE TABLE email_reconciliation_cursor (
  stream text PRIMARY KEY CHECK (stream IN ('brevo_hard_bounce', 'brevo_spam', 'brevo_blocklist')),
  window_start date NOT NULL,
  next_offset integer NOT NULL DEFAULT 0 CHECK (next_offset >= 0)
);

ALTER TABLE email_send ADD COLUMN gap_alerted_at timestamptz;
CREATE INDEX idx_email_send_resend_gap
  ON email_send (updated_at, id)
  WHERE provider = 'resend' AND state = 'sent' AND gap_alerted_at IS NULL;
CREATE INDEX idx_email_send_provider_message
  ON email_send (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

GRANT INSERT (provider, event_key) ON email_webhook_event TO valstara_app;
GRANT SELECT (provider, event_key) ON email_webhook_event TO valstara_app;
GRANT SELECT, INSERT, UPDATE ON email_reconciliation_cursor TO valstara_app;
GRANT INSERT (email_normalised, reason, source, created_at)
  ON suppression TO valstara_app;
GRANT UPDATE (state, updated_at, gap_alerted_at)
  ON email_send TO valstara_app;
GRANT SELECT (id, provider, provider_message_id, state, updated_at, gap_alerted_at)
  ON email_send TO valstara_app;
