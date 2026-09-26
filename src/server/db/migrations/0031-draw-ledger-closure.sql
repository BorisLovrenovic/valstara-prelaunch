-- E7-05: aborting a commitment to choose a later round never reopens entries.
CREATE OR REPLACE FUNCTION reject_giveaway_entry_after_draw_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(705, 5);
  IF EXISTS (SELECT 1 FROM giveaway_draw
             WHERE snapshot_committed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'giveaway entries are closed after the draw snapshot is committed';
  END IF;
  RETURN NEW;
END;
$$;
