-- E7-05: one committed entry snapshot, followed by a future drand round.
ALTER TABLE giveaway_draw
  ALTER COLUMN executed_at DROP NOT NULL,
  ALTER COLUMN seed DROP NOT NULL,
  ALTER COLUMN entry_snapshot_hash DROP NOT NULL,
  ALTER COLUMN winners DROP NOT NULL,
  ADD COLUMN state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'published', 'aborted')),
  ADD COLUMN snapshot_committed_at timestamptz,
  ADD COLUMN snapshot_count bigint NOT NULL DEFAULT 0 CHECK (snapshot_count >= 0),
  ADD COLUMN prize_count integer CHECK (prize_count > 0),
  ADD COLUMN rules_version text,
  ADD COLUMN rules_sha256 bytea CHECK (octet_length(rules_sha256) = 32),
  ADD COLUMN drand_chain_hash bytea CHECK (octet_length(drand_chain_hash) = 32),
  ADD COLUMN drand_chain_info jsonb,
  ADD COLUMN target_round bigint CHECK (target_round > 0),
  ADD COLUMN target_round_at timestamptz,
  ADD COLUMN beacon_round bigint CHECK (beacon_round > 0),
  ADD COLUMN beacon_randomness bytea CHECK (octet_length(beacon_randomness) = 32),
  ADD COLUMN beacon_signature bytea,
  ADD COLUMN beacon_previous_signature bytea,
  ADD COLUMN beacon_relay_used text,
  ADD COLUMN beacon_verified_relays jsonb,
  ADD COLUMN seed_generated_at timestamptz,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_alert_at timestamptz,
  ADD CONSTRAINT giveaway_draw_commit_complete CHECK (
    (snapshot_committed_at IS NULL AND entry_snapshot_hash IS NULL AND target_round IS NULL)
    OR
    (snapshot_committed_at IS NOT NULL AND entry_snapshot_hash IS NOT NULL
      AND target_round IS NOT NULL AND target_round_at IS NOT NULL
      AND drand_chain_hash IS NOT NULL AND drand_chain_info IS NOT NULL
      AND prize_count IS NOT NULL AND rules_version IS NOT NULL
      AND rules_sha256 IS NOT NULL)
  ),
  ADD CONSTRAINT giveaway_draw_publication_complete CHECK (
    state <> 'published' OR
    (seed IS NOT NULL AND beacon_round = target_round
      AND beacon_randomness IS NOT NULL AND beacon_signature IS NOT NULL
      AND beacon_relay_used IS NOT NULL AND reproduced_at IS NOT NULL
      AND published_at IS NOT NULL AND winners IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_giveaway_draw_active
  ON giveaway_draw ((TRUE)) WHERE state <> 'aborted';

CREATE TABLE giveaway_draw_snapshot_row (
  draw_id uuid NOT NULL REFERENCES giveaway_draw(id),
  entry_id uuid NOT NULL,
  subscriber_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('base', 'referral')),
  source_edge_id uuid,
  rules_version text NOT NULL,
  rules_sha256 bytea NOT NULL CHECK (octet_length(rules_sha256) = 32),
  selection_score double precision
    CHECK (selection_score >= 0 AND selection_score < 'Infinity'::double precision),
  PRIMARY KEY (draw_id, entry_id)
);

CREATE INDEX idx_giveaway_draw_snapshot_score
  ON giveaway_draw_snapshot_row (draw_id, selection_score, entry_id);

CREATE TABLE giveaway_draw_selection (
  draw_id uuid NOT NULL REFERENCES giveaway_draw(id),
  position bigint NOT NULL CHECK (position > 0),
  subscriber_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  is_winner boolean NOT NULL,
  PRIMARY KEY (draw_id, position),
  UNIQUE (draw_id, subscriber_id),
  FOREIGN KEY (draw_id, entry_id)
    REFERENCES giveaway_draw_snapshot_row(draw_id, entry_id)
);

CREATE INDEX idx_giveaway_draw_selection_reserves
  ON giveaway_draw_selection (draw_id, position) WHERE is_winner = false;

CREATE FUNCTION reject_giveaway_entry_after_draw_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM giveaway_draw WHERE state <> 'aborted') THEN
    RAISE EXCEPTION 'giveaway entries are closed after the draw snapshot is committed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER giveaway_entry_closed_after_draw
BEFORE INSERT ON giveaway_entry
FOR EACH ROW EXECUTE FUNCTION reject_giveaway_entry_after_draw_commit();

CREATE FUNCTION reject_snapshot_row_after_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM giveaway_draw
             WHERE id = NEW.draw_id AND snapshot_committed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a committed giveaway snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER giveaway_snapshot_row_write_once
BEFORE INSERT ON giveaway_draw_snapshot_row
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_after_commit();

GRANT SELECT, INSERT, UPDATE (
  state, snapshot_committed_at, snapshot_count, entry_snapshot_hash,
  prize_count, rules_version, rules_sha256,
  drand_chain_hash, drand_chain_info, target_round, target_round_at,
  beacon_round, beacon_randomness, beacon_signature,
  beacon_previous_signature, beacon_relay_used, beacon_verified_relays,
  seed, seed_generated_at, executed_at, winners, reproduced_at,
  published_at, attempt_count, next_attempt_at, last_alert_at
) ON TABLE giveaway_draw TO valstara_app;

GRANT SELECT, INSERT, UPDATE (selection_score)
  ON TABLE giveaway_draw_snapshot_row TO valstara_app;
GRANT SELECT, INSERT, UPDATE (is_winner)
  ON TABLE giveaway_draw_selection TO valstara_app;
