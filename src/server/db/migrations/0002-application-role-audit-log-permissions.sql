DO $$
DECLARE
  application_role_password text := current_setting('valstara.application_role_password', true);
BEGIN
  IF application_role_password IS NULL OR application_role_password = '' THEN
    RAISE EXCEPTION 'valstara.application_role_password must be set before applying this migration';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'valstara_app') THEN
    CREATE ROLE valstara_app;
  END IF;

  EXECUTE format(
    'ALTER ROLE valstara_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
    application_role_password
  );
END;
$$;

GRANT USAGE ON SCHEMA public TO valstara_app;
REVOKE ALL PRIVILEGES ON TABLE audit_log FROM valstara_app;
GRANT SELECT, INSERT ON TABLE audit_log TO valstara_app;
