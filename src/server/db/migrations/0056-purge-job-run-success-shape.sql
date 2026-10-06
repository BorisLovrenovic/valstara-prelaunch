-- E10-05: a successful last run and its last-success stamp must agree.
ALTER TABLE purge_job_run ADD CONSTRAINT purge_run_success_shape CHECK (
  last_outcome <> 'succeeded' OR
  (last_succeeded_at = last_finished_at AND last_error_code IS NULL)
);
