-- E8-03a: allow only the two new typed reference fields used by producers.
ALTER TABLE email_send DROP CONSTRAINT email_send_payload_references_only;
ALTER TABLE email_send ADD CONSTRAINT email_send_payload_references_only CHECK (
  jsonb_typeof(payload) = 'object'
  AND payload - 'token_id' - 'award_id' - 'tier' - 'status_token_id' - 'rules_version' = '{}'::jsonb
  AND (NOT payload ? 'token_id' OR
    (jsonb_typeof(payload->'token_id') = 'string' AND
     payload->>'token_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'award_id' OR
    (jsonb_typeof(payload->'award_id') = 'string' AND
     payload->>'award_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'status_token_id' OR
    (jsonb_typeof(payload->'status_token_id') = 'string' AND
     payload->>'status_token_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'rules_version' OR
    (jsonb_typeof(payload->'rules_version') = 'string' AND
     payload->>'rules_version' ~ '^VAL-GW-[A-Z0-9]+-[0-9]{8}-r[1-9][0-9]*$'))
  AND (NOT payload ? 'tier' OR
    (jsonb_typeof(payload->'tier') = 'number' AND
     (payload->>'tier') ~ '^[0-9]+$'))
);
