-- E8-01: legacy queued rows contain no reconstructible content. There is no
-- production data; never pretend these rows can be retried.
UPDATE email_send
SET state = 'failed', last_error = 'legacy_unrecoverable',
    updated_at = CURRENT_TIMESTAMP
WHERE state = 'queued';

ALTER TABLE email_send
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN unsubscribe_token_id uuid,
  ADD COLUMN unsubscribe_token_purpose text
    GENERATED ALWAYS AS ('unsubscribe'::text) STORED,
  ADD COLUMN next_attempt_at timestamptz;

-- Only typed references may enter the durable outbox. A UUID cannot be an
-- email address, a token or copy; tier is a nonnegative integer.
ALTER TABLE email_send ADD CONSTRAINT email_send_payload_references_only CHECK (
  jsonb_typeof(payload) = 'object'
  AND payload - 'token_id' - 'award_id' - 'tier' = '{}'::jsonb
  AND (NOT payload ? 'token_id' OR
    (jsonb_typeof(payload->'token_id') = 'string' AND
     payload->>'token_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'award_id' OR
    (jsonb_typeof(payload->'award_id') = 'string' AND
     payload->>'award_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'tier' OR
    (jsonb_typeof(payload->'tier') = 'number' AND
     (payload->>'tier') ~ '^[0-9]+$'))
);

ALTER TABLE email_send ADD CONSTRAINT email_send_queued_has_content CHECK (
  state <> 'queued' OR
  (payload <> '{}'::jsonb AND unsubscribe_token_id IS NOT NULL)
);

ALTER TABLE verification_token
  ADD CONSTRAINT uq_verification_token_id_subject_purpose
  UNIQUE (id, subscriber_id, purpose);

ALTER TABLE email_send ADD CONSTRAINT fk_email_send_unsubscribe_token
  FOREIGN KEY (unsubscribe_token_id, subscriber_id, unsubscribe_token_purpose)
  REFERENCES verification_token (id, subscriber_id, purpose);
ALTER TABLE email_send ADD CONSTRAINT uq_email_send_unsubscribe_token_id
  UNIQUE (unsubscribe_token_id);

CREATE INDEX idx_email_send_dispatch_due
  ON email_send (next_attempt_at, created_at, id)
  WHERE state = 'queued';

GRANT SELECT (id, subscriber_id, template, provider, business_key, payload,
  unsubscribe_token_id, state, attempts, next_attempt_at, created_at)
  ON email_send TO valstara_app;
GRANT INSERT (payload, unsubscribe_token_id, next_attempt_at)
  ON email_send TO valstara_app;
GRANT UPDATE (state, attempts, last_error, next_attempt_at,
  provider_message_id, updated_at) ON email_send TO valstara_app;
GRANT SELECT (email, email_normalised, marketing_consent_at, status)
  ON subscriber TO valstara_app;
