-- E11.7-16: partner announcements. The payload of `partner_announcement` is
-- the announcement's id (its content file's name without `.md`) and a
-- status-token reference. The id is a reference, never copy: the subject and
-- text are read from the content file at dispatch. Additive: every payload the
-- previous check accepted is still accepted.
ALTER TABLE email_send DROP CONSTRAINT email_send_payload_references_only;
ALTER TABLE email_send ADD CONSTRAINT email_send_payload_references_only CHECK (
  jsonb_typeof(payload) = 'object'
  AND payload - 'token_id' - 'award_id' - 'tier' - 'status_token_id' - 'rules_version' - 'snapshot_id' - 'period' - 'announcement_id' = '{}'::jsonb
  AND (NOT payload ? 'token_id' OR (jsonb_typeof(payload->'token_id') = 'string' AND payload->>'token_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'award_id' OR (jsonb_typeof(payload->'award_id') = 'string' AND payload->>'award_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'status_token_id' OR (jsonb_typeof(payload->'status_token_id') = 'string' AND payload->>'status_token_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'snapshot_id' OR (jsonb_typeof(payload->'snapshot_id') = 'string' AND payload->>'snapshot_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'rules_version' OR (jsonb_typeof(payload->'rules_version') = 'string' AND payload->>'rules_version' ~ '^VAL-GW-[A-Z0-9]+-[0-9]{8}-r[1-9][0-9]*$'))
  AND (NOT payload ? 'tier' OR (jsonb_typeof(payload->'tier') = 'number' AND (payload->>'tier') ~ '^[0-9]+$'))
  AND (NOT payload ? 'period' OR (jsonb_typeof(payload->'period') = 'string' AND (
    payload->>'period' ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR payload->>'period' ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$')))
  AND (NOT payload ? 'announcement_id' OR (jsonb_typeof(payload->'announcement_id') = 'string'
    AND length(payload->>'announcement_id') <= 80
    AND payload->>'announcement_id' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'))
);
