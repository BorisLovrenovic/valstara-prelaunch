-- E10-05: bound the rolling signup-cohort aggregate by creation time.
CREATE INDEX idx_subscriber_created_at_attribution_health
  ON subscriber (created_at);
