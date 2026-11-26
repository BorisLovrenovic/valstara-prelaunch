-- E11.8-03: the founder note in the weekly update. A run records, when its
-- queueing starts, the SHA-256 of the note deployed for its week, and dispatch
-- renders only a deployed note with that hash. The application inserts the
-- hash with the run and can never change it, so one run never carries two
-- notes. `note_left_out_at` records, once, that a deploy changed or removed
-- the note during the send window: the note is then left out of the rest of
-- the run. Additive: existing runs have no note.
ALTER TABLE weekly_campaign_run
  ADD COLUMN note_hash text CHECK (note_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN note_left_out_at timestamptz,
  ADD CONSTRAINT weekly_note_left_out_has_note
    CHECK (note_left_out_at IS NULL OR note_hash IS NOT NULL);
GRANT UPDATE (note_left_out_at) ON weekly_campaign_run TO valstara_app;
