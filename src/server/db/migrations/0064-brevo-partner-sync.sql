-- A row with no fingerprint tracks an attempted first upsert whose outcome
-- is unsettled. Only a successful provider call records an applied payload.
CREATE TABLE brevo_partner_sync (
  subscriber_id uuid NOT NULL REFERENCES subscriber(id),
  list_id bigint NOT NULL CHECK (list_id > 0),
  fingerprint bytea CHECK (octet_length(fingerprint) = 32),
  synced_at timestamptz,
  PRIMARY KEY (subscriber_id, list_id),
  CHECK ((fingerprint IS NULL) = (synced_at IS NULL))
);

REVOKE ALL ON brevo_partner_sync FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON brevo_partner_sync TO valstara_app;
GRANT UPDATE (fingerprint, synced_at) ON brevo_partner_sync TO valstara_app;
