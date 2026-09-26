-- E7-05: keep the commitment and verified-beacon evidence internally coherent.
ALTER TABLE giveaway_draw
  ADD CONSTRAINT giveaway_draw_future_target CHECK (
    snapshot_committed_at IS NULL OR
    target_round_at >= snapshot_committed_at + interval '5 minutes'
  ),
  ADD CONSTRAINT giveaway_draw_seed_after_commit CHECK (
    seed IS NULL OR
    (snapshot_committed_at IS NOT NULL
      AND seed_generated_at IS NOT NULL
      AND seed_generated_at > snapshot_committed_at
      AND beacon_round = target_round
      AND beacon_randomness IS NOT NULL
      AND beacon_signature IS NOT NULL
      AND beacon_relay_used IS NOT NULL)
  ),
  ADD CONSTRAINT giveaway_draw_aborted_unseeded CHECK (
    state <> 'aborted' OR seed IS NULL
  );
