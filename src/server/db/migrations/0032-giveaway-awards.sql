-- E7-06: one durable prize record, with a permanent claim for every candidate
-- considered so a reserve can never be assigned to two prizes.
CREATE TABLE giveaway_award (
  id uuid PRIMARY KEY,
  draw_id uuid NOT NULL REFERENCES giveaway_draw(id),
  prize_slot integer NOT NULL CHECK (prize_slot > 0),
  entry_snapshot_hash bytea NOT NULL CHECK (octet_length(entry_snapshot_hash) = 32),
  selection_position bigint NOT NULL,
  entry_id uuid NOT NULL,
  subscriber_id uuid NOT NULL REFERENCES subscriber(id),
  state text NOT NULL DEFAULT 'notified'
    CHECK (state IN ('notified', 'confirmed', 'delivered', 'exhausted')),
  notified_at timestamptz NOT NULL,
  response_deadline_at timestamptz NOT NULL,
  country_of_residence char(2) CHECK (country_of_residence ~ '^[A-Z]{2}$'),
  age_confirmed boolean,
  sanctions_passed boolean,
  skill_passed boolean,
  substitution_state text NOT NULL DEFAULT 'none'
    CHECK (substitution_state IN ('none', 'offered', 'replacement', 'cash')),
  substitution_offered_at timestamptz,
  substitution_deadline_at timestamptz,
  substitution jsonb,
  publicity_permission boolean NOT NULL DEFAULT false,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_giveaway_award_slot UNIQUE (draw_id, prize_slot),
  CONSTRAINT uq_giveaway_award_position UNIQUE (draw_id, selection_position),
  CONSTRAINT fk_giveaway_award_selection FOREIGN KEY (draw_id, selection_position)
    REFERENCES giveaway_draw_selection(draw_id, position),
  CONSTRAINT fk_giveaway_award_snapshot FOREIGN KEY (draw_id, entry_id)
    REFERENCES giveaway_draw_snapshot_row(draw_id, entry_id),
  CONSTRAINT giveaway_award_deadline_after_notice CHECK (response_deadline_at > notified_at),
  CONSTRAINT giveaway_award_confirmed_checks CHECK (
    state NOT IN ('confirmed', 'delivered') OR
    (country_of_residence IS NOT NULL AND age_confirmed IS TRUE
      AND sanctions_passed IS TRUE
      AND (country_of_residence <> 'CA' OR skill_passed IS TRUE))
  ),
  CONSTRAINT giveaway_award_delivery_state CHECK (
    (state = 'delivered') = (delivered_at IS NOT NULL)
  ),
  CONSTRAINT giveaway_award_substitution_state CHECK (
    (substitution_state = 'none' AND substitution_offered_at IS NULL
      AND substitution_deadline_at IS NULL AND substitution IS NULL)
    OR (substitution_state = 'offered' AND state = 'confirmed'
      AND substitution_offered_at IS NOT NULL
      AND substitution_deadline_at > substitution_offered_at
      AND substitution IS NULL)
    OR (substitution_state IN ('replacement', 'cash')
      AND state IN ('confirmed', 'delivered')
      AND substitution_offered_at IS NOT NULL
      AND substitution_deadline_at > substitution_offered_at
      AND substitution IS NOT NULL)
  )
);

CREATE TABLE giveaway_award_candidate (
  draw_id uuid NOT NULL,
  selection_position bigint NOT NULL,
  award_id uuid NOT NULL REFERENCES giveaway_award(id),
  subscriber_id uuid NOT NULL REFERENCES subscriber(id),
  outcome text NOT NULL DEFAULT 'awaiting'
    CHECK (outcome IN ('awaiting', 'confirmed', 'replaced')),
  reason text CHECK (reason IN ('age', 'sanctions', 'skill', 'deadline')),
  checked_at timestamptz,
  PRIMARY KEY (draw_id, selection_position),
  FOREIGN KEY (draw_id, selection_position)
    REFERENCES giveaway_draw_selection(draw_id, position),
  CONSTRAINT giveaway_candidate_outcome_complete CHECK (
    (outcome = 'awaiting' AND reason IS NULL AND checked_at IS NULL)
    OR (outcome = 'confirmed' AND reason IS NULL AND checked_at IS NOT NULL)
    OR (outcome = 'replaced' AND reason IS NOT NULL AND checked_at IS NOT NULL)
  )
);

CREATE INDEX idx_giveaway_award_deadline
  ON giveaway_award (response_deadline_at, id) WHERE state = 'notified';
CREATE INDEX idx_giveaway_substitution_deadline
  ON giveaway_award (substitution_deadline_at, id)
  WHERE substitution_state = 'offered';

CREATE FUNCTION protect_giveaway_award_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.draw_id IS DISTINCT FROM OLD.draw_id OR
    NEW.prize_slot IS DISTINCT FROM OLD.prize_slot OR
    NEW.entry_snapshot_hash IS DISTINCT FROM OLD.entry_snapshot_hash
  ) THEN
    RAISE EXCEPTION 'an award cannot change its draw or snapshot';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM giveaway_draw d
    JOIN giveaway_draw_selection s
      ON s.draw_id = NEW.draw_id AND s.position = NEW.selection_position
    WHERE d.id = NEW.draw_id AND d.state = 'published'
      AND d.entry_snapshot_hash = NEW.entry_snapshot_hash
      AND s.entry_id = NEW.entry_id AND s.subscriber_id = NEW.subscriber_id
  ) THEN
    RAISE EXCEPTION 'award candidate must belong to the published snapshot';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER giveaway_award_snapshot_guard
BEFORE INSERT OR UPDATE ON giveaway_award
FOR EACH ROW EXECUTE FUNCTION protect_giveaway_award_snapshot();

REVOKE ALL ON giveaway_award FROM PUBLIC;
REVOKE ALL ON giveaway_award_candidate FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE (
  selection_position, entry_id, subscriber_id, state, notified_at,
  response_deadline_at, country_of_residence, age_confirmed,
  sanctions_passed, skill_passed, substitution_state,
  substitution_offered_at, substitution_deadline_at,
  substitution, publicity_permission,
  delivered_at, updated_at
) ON giveaway_award TO valstara_app;
GRANT SELECT, INSERT, UPDATE (outcome, reason, checked_at)
  ON giveaway_award_candidate TO valstara_app;
