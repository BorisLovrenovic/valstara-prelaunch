-- E7-05: the published evidence and the scored snapshot cannot be rewritten.
REVOKE INSERT ON TABLE giveaway_draw FROM valstara_app;
GRANT INSERT (id, executed_by) ON TABLE giveaway_draw TO valstara_app;

ALTER TABLE giveaway_draw
  ADD CONSTRAINT giveaway_draw_seed_format CHECK (
    seed IS NULL OR seed ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT giveaway_draw_published_winner_count CHECK (
    state <> 'published' OR jsonb_array_length(winners) = prize_count
  ),
  ADD CONSTRAINT giveaway_draw_relay_count CHECK (
    seed IS NULL OR
    (jsonb_typeof(beacon_verified_relays) = 'array'
      AND jsonb_array_length(beacon_verified_relays) >= 2)
  );

CREATE FUNCTION protect_giveaway_draw_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.seed IS NOT NULL
       OR NEW.snapshot_committed_at IS NOT NULL OR NEW.winners IS NOT NULL THEN
      RAISE EXCEPTION 'a giveaway draw must begin pending and uncommitted';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'published' OR OLD.state = 'aborted' THEN
    RAISE EXCEPTION 'a completed giveaway draw is immutable';
  END IF;
  IF OLD.snapshot_committed_at IS NOT NULL AND (
    NEW.snapshot_committed_at IS DISTINCT FROM OLD.snapshot_committed_at OR
    NEW.entry_snapshot_hash IS DISTINCT FROM OLD.entry_snapshot_hash OR
    NEW.snapshot_count IS DISTINCT FROM OLD.snapshot_count OR
    NEW.prize_count IS DISTINCT FROM OLD.prize_count OR
    NEW.rules_version IS DISTINCT FROM OLD.rules_version OR
    NEW.rules_sha256 IS DISTINCT FROM OLD.rules_sha256 OR
    NEW.drand_chain_hash IS DISTINCT FROM OLD.drand_chain_hash OR
    NEW.drand_chain_info IS DISTINCT FROM OLD.drand_chain_info OR
    NEW.target_round IS DISTINCT FROM OLD.target_round OR
    NEW.target_round_at IS DISTINCT FROM OLD.target_round_at
  ) THEN
    RAISE EXCEPTION 'a committed giveaway draw snapshot is immutable';
  END IF;
  IF OLD.seed IS NOT NULL AND (
    NEW.seed IS DISTINCT FROM OLD.seed OR
    NEW.seed_generated_at IS DISTINCT FROM OLD.seed_generated_at OR
    NEW.beacon_round IS DISTINCT FROM OLD.beacon_round OR
    NEW.beacon_randomness IS DISTINCT FROM OLD.beacon_randomness OR
    NEW.beacon_signature IS DISTINCT FROM OLD.beacon_signature OR
    NEW.beacon_previous_signature IS DISTINCT FROM OLD.beacon_previous_signature OR
    NEW.beacon_relay_used IS DISTINCT FROM OLD.beacon_relay_used OR
    NEW.beacon_verified_relays IS DISTINCT FROM OLD.beacon_verified_relays OR
    NEW.winners IS DISTINCT FROM OLD.winners
  ) THEN
    RAISE EXCEPTION 'verified giveaway draw evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER giveaway_draw_evidence_write_once
BEFORE INSERT OR UPDATE ON giveaway_draw
FOR EACH ROW EXECUTE FUNCTION protect_giveaway_draw_evidence();

CREATE FUNCTION protect_giveaway_draw_snapshot_row()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.selection_score IS NOT NULL THEN
      RAISE EXCEPTION 'a snapshot row cannot be pre-scored';
    END IF;
  ELSIF OLD.selection_score IS NOT NULL THEN
    RAISE EXCEPTION 'a scored snapshot row is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER giveaway_draw_snapshot_score_write_once
BEFORE INSERT OR UPDATE ON giveaway_draw_snapshot_row
FOR EACH ROW EXECUTE FUNCTION protect_giveaway_draw_snapshot_row();

CREATE FUNCTION protect_giveaway_draw_selection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM giveaway_draw WHERE id = NEW.draw_id AND seed IS NOT NULL) THEN
    RAISE EXCEPTION 'a seeded giveaway selection is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER giveaway_draw_selection_write_once
BEFORE INSERT OR UPDATE ON giveaway_draw_selection
FOR EACH ROW EXECUTE FUNCTION protect_giveaway_draw_selection();
