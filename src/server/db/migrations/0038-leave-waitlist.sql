-- E6-06: explicit leave changes waitlist status with suppression and audit.
GRANT UPDATE (status, unsubscribed_at, updated_at)
  ON subscriber TO valstara_app;
