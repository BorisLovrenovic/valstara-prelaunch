-- E7-05: serialize ledger inserts with the draw snapshot without granting
-- table-wide UPDATE or DELETE to the application role.
CREATE OR REPLACE FUNCTION reject_giveaway_entry_after_draw_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(705, 5);
  IF EXISTS (SELECT 1 FROM giveaway_draw WHERE state <> 'aborted') THEN
    RAISE EXCEPTION 'giveaway entries are closed after the draw snapshot is committed';
  END IF;
  RETURN NEW;
END;
$$;
