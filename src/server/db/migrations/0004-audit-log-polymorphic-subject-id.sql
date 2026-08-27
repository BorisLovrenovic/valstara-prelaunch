ALTER TABLE audit_log
ALTER COLUMN subject_id TYPE text
USING subject_id::text;

GRANT SELECT, INSERT, UPDATE ON TABLE campaign_flag TO valstara_app;
