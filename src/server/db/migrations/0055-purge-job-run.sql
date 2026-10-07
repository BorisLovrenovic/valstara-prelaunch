-- E10-05: last-run evidence for the four existing daily purge jobs.
CREATE TABLE purge_job_run (
  job_key text PRIMARY KEY CHECK (job_key IN (
    'ip_prefix_retention',
    'rate_limit_retention',
    'verification_token_retention',
    'leaderboard_snapshot_purge'
  )),
  last_started_at timestamptz NOT NULL,
  last_finished_at timestamptz,
  last_succeeded_at timestamptz,
  last_outcome text CHECK (last_outcome IN ('succeeded', 'failed')),
  rows_purged integer NOT NULL DEFAULT 0 CHECK (rows_purged >= 0),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  CONSTRAINT purge_run_completion_shape CHECK (
    (last_finished_at IS NULL AND last_outcome IS NULL AND last_error_code IS NULL)
    OR
    (last_finished_at IS NOT NULL AND last_outcome IS NOT NULL)
  ),
  CONSTRAINT purge_run_error_shape CHECK (
    last_error_code IS NULL OR last_outcome = 'failed'
  ),
  CONSTRAINT purge_run_success_order CHECK (
    last_succeeded_at IS NULL OR
    (last_finished_at IS NOT NULL AND last_succeeded_at <= last_finished_at)
  )
);

REVOKE ALL ON purge_job_run FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON purge_job_run TO valstara_app;
