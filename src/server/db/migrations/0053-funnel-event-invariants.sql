-- E10-03: enforce first answered survey state and durable signed ref presence.
ALTER TABLE survey_response ADD CONSTRAINT survey_answer_requires_completion_marker
  CHECK (
    first_answered_at IS NOT NULL OR
    (COALESCE(answers->'category_preference', 'null'::jsonb) = 'null'::jsonb
     AND COALESCE(answers->'shopping_frequency', 'null'::jsonb) = 'null'::jsonb)
  );

CREATE FUNCTION preserve_survey_first_answered_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_answered_at IS NOT NULL
     AND NEW.first_answered_at IS DISTINCT FROM OLD.first_answered_at THEN
    RAISE EXCEPTION 'survey first answer is write-once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER survey_first_answer_write_once
BEFORE UPDATE ON survey_response
FOR EACH ROW EXECUTE FUNCTION preserve_survey_first_answered_at();


-- Verification derives anonymous buckets from the original, signed capture,
-- including a valid ref when attribution is temporarily disabled.
ALTER TABLE subscriber ADD COLUMN signup_had_ref boolean DEFAULT false;
UPDATE subscriber SET signup_had_ref = true WHERE referred_by_id IS NOT NULL;
UPDATE subscriber SET signup_had_ref = NULL WHERE status = 'erased';
ALTER TABLE subscriber ADD CONSTRAINT signup_had_ref_erasure_shape CHECK (
  (status = 'erased' AND signup_had_ref IS NULL) OR
  (status <> 'erased' AND signup_had_ref IS NOT NULL)
);
CREATE FUNCTION preserve_signup_had_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'erased' THEN
    NEW.signup_had_ref := NULL;
  ELSIF NEW.signup_had_ref IS DISTINCT FROM OLD.signup_had_ref THEN
    RAISE EXCEPTION 'signup ref-presence is write-once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER signup_had_ref_write_once
BEFORE UPDATE ON subscriber
FOR EACH ROW EXECUTE FUNCTION preserve_signup_had_ref();
GRANT INSERT (signup_had_ref) ON TABLE subscriber TO valstara_app;
GRANT SELECT (utm, signup_had_ref) ON TABLE subscriber TO valstara_app;
