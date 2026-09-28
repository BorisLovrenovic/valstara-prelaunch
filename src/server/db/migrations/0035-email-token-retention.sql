-- E8-01 follow-on: let verification-token retention purge old unsubscribe
-- links while preserving the email history and queued-send invariant.
ALTER TABLE email_send DROP CONSTRAINT fk_email_send_unsubscribe_token;
ALTER TABLE verification_token ADD CONSTRAINT uq_verification_token_id_subject
  UNIQUE (id, subscriber_id);
ALTER TABLE email_send ADD CONSTRAINT fk_email_send_unsubscribe_token
  FOREIGN KEY (unsubscribe_token_id, subscriber_id)
  REFERENCES verification_token (id, subscriber_id)
  ON DELETE SET NULL (unsubscribe_token_id);

CREATE FUNCTION require_unsubscribe_token_purpose()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unsubscribe_token_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM verification_token
    WHERE id = NEW.unsubscribe_token_id AND subscriber_id = NEW.subscriber_id
      AND purpose = 'unsubscribe'
  ) THEN
    RAISE EXCEPTION 'email_send requires an unsubscribe-purpose token';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_unsubscribe_token_purpose
BEFORE INSERT OR UPDATE OF unsubscribe_token_id ON email_send
FOR EACH ROW EXECUTE FUNCTION require_unsubscribe_token_purpose();

CREATE FUNCTION fail_email_on_unsubscribe_token_purge()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE email_send SET state = 'failed',
    last_error = 'unsubscribe_token_expired',
    next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE unsubscribe_token_id = OLD.id AND state = 'queued';
  RETURN OLD;
END;
$$;

CREATE TRIGGER email_unsubscribe_token_purge
BEFORE DELETE ON verification_token
FOR EACH ROW EXECUTE FUNCTION fail_email_on_unsubscribe_token_purge();
