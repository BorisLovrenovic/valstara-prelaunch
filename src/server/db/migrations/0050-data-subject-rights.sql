-- E9-05: pending erasure stops processing; only the original subscriber row
-- supplies Brevo's identifier. No retry record contains an address.
ALTER TABLE subscriber DROP CONSTRAINT subscriber_status_check;
ALTER TABLE subscriber ADD CONSTRAINT subscriber_status_check CHECK
  (status IN ('pending','verified','expired','unsubscribed','bounced','disqualified','erasure_pending','erased'));
ALTER TABLE subscriber ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN email_normalised DROP NOT NULL, ALTER COLUMN email_domain DROP NOT NULL,
  ALTER COLUMN created_at DROP NOT NULL, ALTER COLUMN updated_at DROP NOT NULL;
ALTER TABLE subscriber ADD CONSTRAINT subscriber_erased_identity CHECK (
  (status = 'erased' AND email IS NULL AND email_normalised IS NULL AND email_domain IS NULL)
  OR (status <> 'erased' AND email IS NOT NULL AND email_normalised IS NOT NULL AND email_domain IS NOT NULL)
);
ALTER TABLE referral_edge ALTER COLUMN referrer_id DROP NOT NULL,
  ALTER COLUMN referred_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION prevent_subscriber_referred_by_reassignment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.referred_by_id IS NOT NULL AND NEW.referred_by_id IS DISTINCT FROM OLD.referred_by_id
    AND NOT (NEW.referred_by_id IS NULL AND (
      NEW.status = 'erased' OR EXISTS (SELECT 1 FROM subscriber
        WHERE id = OLD.referred_by_id AND status IN ('erasure_pending','erased')))) THEN
    RAISE EXCEPTION 'subscriber.referred_by_id is write-once';
  END IF;
  RETURN NEW;
END; $$;
CREATE TABLE dsr_erasure (
  subscriber_id uuid PRIMARY KEY REFERENCES subscriber(id),
  requested_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  escalated_at timestamptz,
  deadline_alerted_at timestamptz,
  completed_at timestamptz,
  CHECK (next_attempt_at >= requested_at),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
);
CREATE INDEX idx_dsr_erasure_due ON dsr_erasure(next_attempt_at, subscriber_id) WHERE completed_at IS NULL;
CREATE TABLE erasure_ledger (
  subscriber_id uuid PRIMARY KEY,
  erased_at timestamptz NOT NULL
);
CREATE TABLE giveaway_draw_void (
  draw_id uuid NOT NULL REFERENCES giveaway_draw(id),
  subscriber_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason = 'erasure'),
  voided_at timestamptz NOT NULL,
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  PRIMARY KEY (draw_id, subscriber_id)
);
CREATE FUNCTION reject_erasure_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'erasure evidence is append-only'; END; $$;
CREATE TRIGGER erasure_ledger_append_only BEFORE UPDATE OR DELETE ON erasure_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_erasure_evidence_mutation();
CREATE TRIGGER giveaway_draw_void_append_only BEFORE UPDATE OR DELETE ON giveaway_draw_void
  FOR EACH ROW EXECUTE FUNCTION reject_erasure_evidence_mutation();
CREATE FUNCTION validate_draw_void() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM giveaway_draw_snapshot_row s JOIN giveaway_draw d ON d.id=s.draw_id
    WHERE s.draw_id=NEW.draw_id AND s.subscriber_id=NEW.subscriber_id AND d.snapshot_committed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'void requires a committed subject snapshot';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER giveaway_draw_void_subject BEFORE INSERT ON giveaway_draw_void
  FOR EACH ROW EXECUTE FUNCTION validate_draw_void();
ALTER TABLE giveaway_award_candidate DROP CONSTRAINT giveaway_award_candidate_reason_check;
ALTER TABLE giveaway_award_candidate ADD CONSTRAINT giveaway_award_candidate_reason_check
  CHECK (reason IN ('age','sanctions','skill','deadline','erasure'));
ALTER TABLE verification_token DROP CONSTRAINT verification_token_purpose_check;
ALTER TABLE verification_token ADD CONSTRAINT verification_token_purpose_check
  CHECK (purpose IN ('verify','status','unsubscribe','dsr_export','dsr_delete'));
-- Once processing stops no old verification, fraud reversal or stale writer can
-- restore eligibility. Fulfilment is the only subsequent status transition.
CREATE FUNCTION protect_erasure_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('erasure_pending','erased') AND NEW.status IS DISTINCT FROM OLD.status
    AND NOT (OLD.status='erasure_pending' AND NEW.status='erased') THEN
    RAISE EXCEPTION 'erasure processing cannot be resumed';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER subscriber_erasure_status BEFORE UPDATE OF status ON subscriber
  FOR EACH ROW EXECUTE FUNCTION protect_erasure_status();
CREATE FUNCTION reject_erasure_mail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status text;
BEGIN
  SELECT status INTO current_status FROM subscriber WHERE id=NEW.subscriber_id FOR SHARE;
  IF current_status IN ('erasure_pending','erased') THEN
    RAISE EXCEPTION 'erasure subject cannot receive mail';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER email_erasure_guard BEFORE INSERT ON email_send
  FOR EACH ROW EXECUTE FUNCTION reject_erasure_mail();
REVOKE ALL ON dsr_erasure, erasure_ledger, giveaway_draw_void FROM PUBLIC;
GRANT SELECT, INSERT ON erasure_ledger, giveaway_draw_void TO valstara_app;
GRANT SELECT, INSERT, UPDATE(attempts,next_attempt_at,escalated_at,deadline_alerted_at,completed_at)
  ON dsr_erasure TO valstara_app;
GRANT SELECT ON subscriber, verification_token, referral_edge, milestone_award,
  survey_response, giveaway_entry, fraud_flag, email_send, top_twenty_review,
  brevo_contact_sync TO valstara_app;
GRANT UPDATE(referrer_id,referred_id) ON referral_edge TO valstara_app;
GRANT UPDATE(detail) ON fraud_flag TO valstara_app;
GRANT DELETE ON email_send, survey_response, brevo_contact_sync, suppression TO valstara_app;
GRANT DELETE ON milestone_award TO valstara_app;
-- A stale maintenance computation must not reintroduce a pending subject into
-- either the site or a queued weekly message's historical snapshot.
CREATE FUNCTION redact_erasure_leaderboard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('valstara:leaderboard-publication'));
  SELECT COALESCE(jsonb_agg(item || jsonb_build_object('rank',rank) ORDER BY rank),'[]'::jsonb)
    INTO NEW.entries FROM (
      SELECT item, row_number() OVER (ORDER BY ordinal) AS rank
      FROM jsonb_array_elements(NEW.entries) WITH ORDINALITY e(item,ordinal)
      WHERE NOT EXISTS (SELECT 1 FROM dsr_erasure d WHERE item->>'display_handle' =
        substr(translate(encode(sha256(convert_to(d.subscriber_id::text,'UTF8')),'base64'),'+/','-_'),1,12))
    ) filtered;
  RETURN NEW;
END; $$;
CREATE TRIGGER leaderboard_erasure BEFORE INSERT OR UPDATE OF entries ON leaderboard_snapshot
  FOR EACH ROW EXECUTE FUNCTION redact_erasure_leaderboard();
GRANT UPDATE(entries) ON leaderboard_snapshot TO valstara_app;
GRANT UPDATE(outcome) ON top_twenty_review TO valstara_app;
CREATE FUNCTION require_erasure_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM subscriber WHERE id=NEW.id AND status='erasure_pending') AND NOT EXISTS
    (SELECT 1 FROM dsr_erasure WHERE subscriber_id=NEW.id AND completed_at IS NULL) THEN
    RAISE EXCEPTION 'pending erasure requires a durable request';
  END IF;
  IF EXISTS (SELECT 1 FROM subscriber WHERE id=NEW.id AND status='erased') AND NOT EXISTS
    (SELECT 1 FROM erasure_ledger WHERE subscriber_id=NEW.id) THEN
    RAISE EXCEPTION 'erased subject requires erasure ledger evidence';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER subscriber_erasure_evidence
AFTER INSERT OR UPDATE OF status ON subscriber DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_erasure_evidence();
ALTER TABLE subscriber ADD CONSTRAINT subscriber_erased_fields CHECK (
  status <> 'erased' OR (
    category_preference IS NULL AND source IS NULL AND utm IS NULL
    AND referral_code IS NULL AND referred_by_id IS NULL AND access_window IS NULL
    AND NOT subslush_customer AND signup_ip_prefix_hash IS NULL
    AND marketing_consent_at IS NULL AND marketing_consent_version IS NULL
    AND marketing_consent_source IS NULL AND NOT marketing_opt_in_pending
    AND marketing_opt_in_pending_version IS NULL AND verified_at IS NULL
    AND unsubscribed_at IS NULL AND expired_at IS NULL AND disqualified_at IS NULL
    AND disqualification_previous_status IS NULL AND disqualified_by_flag_id IS NULL
    AND confirmed_referrals=0 AND referral_tier=0 AND created_at IS NULL AND updated_at IS NULL
  )
);
CREATE FUNCTION protect_erasure_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.subscriber_id IS DISTINCT FROM OLD.subscriber_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.attempts < OLD.attempts
    OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'erasure request identity and completion are immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER dsr_erasure_transition BEFORE UPDATE ON dsr_erasure
  FOR EACH ROW EXECUTE FUNCTION protect_erasure_request();
-- Keep ordinary application writers unable to replace an email address.
-- This narrowly scoped function can only null the identity of a pending subject.
CREATE FUNCTION erase_subscriber_identity(subject_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.subscriber s JOIN public.dsr_erasure d
    ON d.subscriber_id=s.id WHERE s.id=subject_id AND s.status='erasure_pending'
    AND d.completed_at IS NULL) THEN
    RAISE EXCEPTION 'identity erasure requires a pending request';
  END IF;
  UPDATE public.subscriber SET status='erased', email=NULL,email_normalised=NULL,email_domain=NULL,
    category_preference=NULL,source=NULL,utm=NULL,referral_code=NULL,referred_by_id=NULL,
    access_window=NULL,subslush_customer=false,signup_ip_prefix_hash=NULL,
    marketing_consent_at=NULL,marketing_consent_version=NULL,marketing_consent_source=NULL,
    marketing_opt_in_pending=false,marketing_opt_in_pending_version=NULL,
    verified_at=NULL,unsubscribed_at=NULL,expired_at=NULL,disqualified_at=NULL,
    disqualification_previous_status=NULL,disqualified_by_flag_id=NULL,
    confirmed_referrals=0,referral_tier=0,created_at=NULL,updated_at=NULL WHERE id=subject_id;
END; $$;
REVOKE ALL ON FUNCTION erase_subscriber_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_subscriber_identity(uuid) TO valstara_app;
