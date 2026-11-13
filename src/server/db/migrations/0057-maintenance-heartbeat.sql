-- QA gate 7 (G7-1-I2), founder decision 2026-11-13 on E10-05: one heartbeat
-- row per maintenance-worker loop. The worker upserts its row after each
-- completed pass; the app's watchdog reads it, stamps stale_alerted_at when it
-- sends the one P1 for a stale episode, and a fresh beat clears the stamp.
-- last_beat_at is NULL only on a row the watchdog created for a loop that has
-- never beaten. No personal data.
CREATE TABLE maintenance_heartbeat (
  loop_key text PRIMARY KEY CHECK (loop_key IN (
    'scheduler_cycle',
    'email_dispatch'
  )),
  last_beat_at timestamptz,
  stale_alerted_at timestamptz
);

REVOKE ALL ON maintenance_heartbeat FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON maintenance_heartbeat TO valstara_app;
