-- E8-07: permit the maintenance role to see an expired weekly outbox row.
GRANT SELECT (last_error) ON email_send TO valstara_app;
