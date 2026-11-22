-- The label grammar already excludes IPv6. Refuse IPv4 within the label
-- as well as a bare address, using the same octet bounds as audit redaction.
ALTER TABLE partner ADD CONSTRAINT partner_contract_version_no_ip CHECK (
  contract_version !~ '(^|[^0-9])(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])([.](25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}($|[^0-9])'
);

-- Track dispatch order separately from the last successful projection.
ALTER TABLE brevo_partner_sync
  ADD COLUMN last_attempt bigint CHECK (last_attempt > 0),
  ADD COLUMN last_attempt_at timestamptz,
  ADD CONSTRAINT brevo_partner_sync_attempt_pair CHECK (
    (last_attempt IS NULL) = (last_attempt_at IS NULL)
  );
CREATE SEQUENCE brevo_partner_sync_attempt_seq OWNED BY brevo_partner_sync.last_attempt;
ALTER TABLE brevo_partner_sync ALTER COLUMN last_attempt
  SET DEFAULT nextval('brevo_partner_sync_attempt_seq');
GRANT USAGE ON SEQUENCE brevo_partner_sync_attempt_seq TO valstara_app;
GRANT UPDATE (last_attempt, last_attempt_at) ON brevo_partner_sync TO valstara_app;

-- Keep the final outcome independently of completion-audit availability.
-- id matches request_id on the corresponding operator audit records.
CREATE TABLE brevo_partner_sync_result (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('completed', 'disabled', 'unavailable')),
  selected integer NOT NULL CHECK (selected BETWEEN 0 AND 500),
  upserted integer NOT NULL CHECK (upserted BETWEEN 0 AND selected),
  removed integer NOT NULL CHECK (removed BETWEEN 0 AND selected),
  failed integer NOT NULL CHECK (failed BETWEEN 0 AND selected),
  CHECK (upserted + removed + failed <= selected),
  CHECK (state <> 'disabled' OR selected = 0),
  CHECK (state = 'unavailable' OR failed = 0)
);

REVOKE ALL ON brevo_partner_sync_result FROM PUBLIC;
GRANT SELECT, INSERT ON brevo_partner_sync_result TO valstara_app;
