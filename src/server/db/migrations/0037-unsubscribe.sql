-- E6-06: a signed, bound unsubscribe can write the global suppression row.
GRANT INSERT (email_normalised, reason, source, created_at)
  ON suppression TO valstara_app;
GRANT SELECT (email_normalised, reason, source, created_at)
  ON suppression TO valstara_app;
GRANT SELECT (email_normalised, status, marketing_consent_at)
  ON subscriber TO valstara_app;
GRANT UPDATE (marketing_consent_at, marketing_consent_version,
  marketing_consent_source, updated_at) ON subscriber TO valstara_app;
