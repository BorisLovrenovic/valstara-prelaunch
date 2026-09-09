GRANT SELECT (id, status, created_at) ON TABLE subscriber TO valstara_app;
GRANT UPDATE (status, expired_at, updated_at) ON TABLE subscriber TO valstara_app;
GRANT SELECT (id, business_key) ON TABLE email_send TO valstara_app;
GRANT INSERT (id, subscriber_id, template, provider, business_key, state)
  ON TABLE email_send TO valstara_app;
