-- The weekly sender selects the snapshot actually held by the web cache.
CREATE TABLE leaderboard_served_snapshot (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  snapshot_id uuid REFERENCES leaderboard_snapshot(id) ON DELETE SET NULL
);
GRANT SELECT, INSERT, UPDATE (snapshot_id) ON leaderboard_served_snapshot TO valstara_app;
