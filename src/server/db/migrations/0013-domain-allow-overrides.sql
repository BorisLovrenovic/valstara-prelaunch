-- E5-01: operator-approved exceptions to the versioned disposable-domain
-- dataset. The application may create and read overrides; removal is a
-- deliberate owner-run data change rather than an unaudited application path.

CREATE TABLE domain_allow (
  domain text PRIMARY KEY,
  allowed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_allow_domain_normalised CHECK (
    domain = lower(domain)
    AND domain = btrim(domain)
    AND domain ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
    AND position('.' IN domain) > 0
  ),
  CONSTRAINT domain_allow_actor_present CHECK (btrim(allowed_by) <> '')
);

GRANT SELECT, INSERT ON TABLE domain_allow TO valstara_app;
