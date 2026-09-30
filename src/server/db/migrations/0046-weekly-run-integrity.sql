-- E8-07: a run's chosen snapshot cannot be changed by the application.
ALTER TABLE weekly_campaign_run ADD CONSTRAINT weekly_started_has_snapshot
  CHECK (state <> 'started' OR snapshot_id IS NOT NULL);
REVOKE UPDATE ON weekly_campaign_run FROM valstara_app;
GRANT UPDATE (state, recorded_at, alerted_at) ON weekly_campaign_run TO valstara_app;
