-- E5-07: a current, actor-recorded review of every raw top-twenty entry
-- holder is the server-side prerequisite E7-05 consumes before publishing.

CREATE TABLE top_twenty_review_batch (
  id uuid PRIMARY KEY,
  membership_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  invalidated_at timestamptz
);

CREATE UNIQUE INDEX uq_top_twenty_review_batch_active
  ON top_twenty_review_batch ((TRUE))
  WHERE invalidated_at IS NULL;

CREATE TABLE top_twenty_review (
  batch_id uuid NOT NULL REFERENCES top_twenty_review_batch(id),
  subscriber_id uuid NOT NULL REFERENCES subscriber(id),
  outcome text NOT NULL CHECK (length(btrim(outcome)) BETWEEN 1 AND 128),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 128),
  reviewed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (batch_id, subscriber_id)
);

GRANT SELECT, INSERT, UPDATE (invalidated_at)
  ON TABLE top_twenty_review_batch TO valstara_app;
GRANT SELECT, INSERT ON TABLE top_twenty_review TO valstara_app;
