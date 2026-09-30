-- E8-06: retain only the opaque idempotency key after the initial migration.
ALTER TABLE email_webhook_event DROP CONSTRAINT email_webhook_event_pkey;
ALTER TABLE email_webhook_event ADD CONSTRAINT email_webhook_event_pkey PRIMARY KEY (event_key);
ALTER TABLE email_webhook_event DROP COLUMN provider;

GRANT INSERT (event_key) ON email_webhook_event TO valstara_app;
GRANT SELECT (event_key) ON email_webhook_event TO valstara_app;
