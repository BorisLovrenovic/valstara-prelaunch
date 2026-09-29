-- The cache records only successful applications of PostgreSQL's desired
-- marketing-list state. A failed provider call leaves its row eligible to retry.
CREATE TABLE brevo_contact_sync (
  email_normalised text PRIMARY KEY REFERENCES subscriber(email_normalised),
  email text NOT NULL,
  listed boolean NOT NULL,
  synced_at timestamptz NOT NULL
);

GRANT SELECT, INSERT ON brevo_contact_sync TO valstara_app;
GRANT UPDATE (email, listed, synced_at) ON brevo_contact_sync TO valstara_app;
