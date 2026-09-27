-- E7-06: freeze the terms offered to a confirmed winner, and enforce the
-- candidate and queue permissions before the award flow is released.
ALTER TABLE giveaway_award ADD COLUMN substitution_offer jsonb;

ALTER TABLE giveaway_award
  DROP CONSTRAINT giveaway_award_substitution_state;
ALTER TABLE giveaway_award
  ADD CONSTRAINT giveaway_award_substitution_state CHECK (
    (substitution_state = 'none' AND substitution_offered_at IS NULL
      AND substitution_deadline_at IS NULL AND substitution_offer IS NULL
      AND substitution IS NULL)
    OR (substitution_state = 'offered' AND state = 'confirmed'
      AND substitution_offered_at IS NOT NULL
      AND substitution_deadline_at > substitution_offered_at
      AND substitution_offer IS NOT NULL
      AND substitution IS NULL)
    OR (substitution_state IN ('replacement', 'cash')
      AND state IN ('confirmed', 'delivered')
      AND substitution_offered_at IS NOT NULL
      AND substitution_deadline_at > substitution_offered_at
      AND substitution_offer IS NOT NULL
      AND substitution IS NOT NULL)
  );

CREATE FUNCTION protect_giveaway_award_offer()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.substitution_offered_at IS NOT NULL AND (
    NEW.substitution_offered_at IS DISTINCT FROM OLD.substitution_offered_at OR
    NEW.substitution_deadline_at IS DISTINCT FROM OLD.substitution_deadline_at OR
    NEW.substitution_offer IS DISTINCT FROM OLD.substitution_offer
  ) THEN
    RAISE EXCEPTION 'a recorded substitution offer is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER giveaway_award_offer_guard
BEFORE UPDATE ON giveaway_award
FOR EACH ROW EXECUTE FUNCTION protect_giveaway_award_offer();

CREATE FUNCTION protect_giveaway_award_candidate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM giveaway_award a
    JOIN giveaway_draw_selection s
      ON s.draw_id = NEW.draw_id AND s.position = NEW.selection_position
    WHERE a.id = NEW.award_id AND a.draw_id = NEW.draw_id
      AND s.subscriber_id = NEW.subscriber_id
  ) THEN
    RAISE EXCEPTION 'award candidate must match the draw selection';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER giveaway_award_candidate_guard
BEFORE INSERT OR UPDATE ON giveaway_award_candidate
FOR EACH ROW EXECUTE FUNCTION protect_giveaway_award_candidate();

GRANT UPDATE (substitution_offer) ON giveaway_award TO valstara_app;
GRANT INSERT (created_at, updated_at) ON email_send TO valstara_app;
