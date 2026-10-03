-- E9-05: forward-only constraints and eligibility guards.
CREATE OR REPLACE FUNCTION validate_draw_void() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dsr_erasure e WHERE e.subscriber_id=NEW.subscriber_id) THEN
    RAISE EXCEPTION 'void requires a recorded erasure request';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM giveaway_draw_snapshot_row s JOIN giveaway_draw d ON d.id=s.draw_id
    WHERE s.draw_id=NEW.draw_id AND s.subscriber_id=NEW.subscriber_id AND d.snapshot_committed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'void requires a committed subject snapshot';
  END IF;
  RETURN NEW;
END; $$;
ALTER TABLE subscriber DROP CONSTRAINT subscriber_erased_fields;
ALTER TABLE subscriber ADD CONSTRAINT subscriber_erased_fields CHECK (
  status <> 'erased' OR (
    category_preference IS NULL AND source IS NULL AND utm IS NULL
    AND giveaway_rules_version IS NULL AND referral_code IS NULL AND referred_by_id IS NULL AND access_window IS NULL
    AND NOT subslush_customer AND signup_ip_prefix_hash IS NULL
    AND marketing_consent_at IS NULL AND marketing_consent_version IS NULL
    AND marketing_consent_source IS NULL AND NOT marketing_opt_in_pending
    AND marketing_opt_in_pending_version IS NULL AND verified_at IS NULL
    AND unsubscribed_at IS NULL AND expired_at IS NULL AND disqualified_at IS NULL
    AND disqualification_previous_status IS NULL AND disqualified_by_flag_id IS NULL
    AND confirmed_referrals=0 AND referral_tier=0 AND created_at IS NULL AND updated_at IS NULL
  )
);
-- Draw entries retain their own stamped revision; the subscriber cache can be
-- cleared during erasure without weakening the normal write-once rule.
CREATE OR REPLACE FUNCTION prevent_subscriber_giveaway_rules_version_reassignment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.giveaway_rules_version IS NOT NULL
    AND NEW.giveaway_rules_version IS DISTINCT FROM OLD.giveaway_rules_version
    AND NOT (NEW.status='erased' AND NEW.giveaway_rules_version IS NULL) THEN
    RAISE EXCEPTION 'subscriber.giveaway_rules_version is write-once';
  END IF;
  RETURN NEW;
END; $$;
-- Keep ordinary application writers unable to replace an email address.
-- This narrowly scoped function can only null the identity of a pending subject.
CREATE OR REPLACE FUNCTION erase_subscriber_identity(subject_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.subscriber s JOIN public.dsr_erasure d
    ON d.subscriber_id=s.id WHERE s.id=subject_id AND s.status='erasure_pending'
    AND d.completed_at IS NULL) THEN
    RAISE EXCEPTION 'identity erasure requires a pending request';
  END IF;
  UPDATE public.subscriber SET status='erased', email=NULL,email_normalised=NULL,email_domain=NULL,
    category_preference=NULL,source=NULL,utm=NULL,giveaway_rules_version=NULL,
    referral_code=NULL,referred_by_id=NULL,
    access_window=NULL,subslush_customer=false,signup_ip_prefix_hash=NULL,
    marketing_consent_at=NULL,marketing_consent_version=NULL,marketing_consent_source=NULL,
    marketing_opt_in_pending=false,marketing_opt_in_pending_version=NULL,
    verified_at=NULL,unsubscribed_at=NULL,expired_at=NULL,disqualified_at=NULL,
    disqualification_previous_status=NULL,disqualified_by_flag_id=NULL,
    confirmed_referrals=0,referral_tier=0,created_at=NULL,updated_at=NULL WHERE id=subject_id;
END; $$;
CREATE FUNCTION require_erasure_request_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM dsr_erasure d JOIN subscriber s ON s.id=d.subscriber_id
    WHERE d.subscriber_id=NEW.subscriber_id AND
      (s.status NOT IN ('erasure_pending','erased') OR
       (d.completed_at IS NOT NULL AND s.status <> 'erased'))) THEN
    RAISE EXCEPTION 'erasure request and subscriber state disagree';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dsr_erasure_state
AFTER INSERT OR UPDATE ON dsr_erasure DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_erasure_request_state();
CREATE FUNCTION require_erasure_ledger_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM subscriber s WHERE s.id=NEW.subscriber_id AND s.status <> 'erased') THEN
    RAISE EXCEPTION 'erasure ledger requires an erased subscriber';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER erasure_ledger_state
AFTER INSERT ON erasure_ledger DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_erasure_ledger_state();
CREATE FUNCTION reject_erasure_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status text;
BEGIN
  SELECT status INTO current_status FROM subscriber WHERE id=NEW.subscriber_id FOR SHARE;
  IF current_status IN ('erasure_pending','erased') THEN
    RAISE EXCEPTION 'erasure subject cannot accrue entries';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER giveaway_entry_erasure_guard BEFORE INSERT ON giveaway_entry
  FOR EACH ROW EXECUTE FUNCTION reject_erasure_entry();
