-- E8-07: one durable, anonymised leaderboard source for the site and email.
CREATE FUNCTION valid_leaderboard_entries(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 10
    THEN false ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(value) WITH ORDINALITY AS item(entry, position)
      WHERE jsonb_typeof(entry) <> 'object'
        OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(entry) AS key)
          IS DISTINCT FROM ARRAY['confirmed_referrals', 'display_handle', 'rank']::text[]
        OR jsonb_typeof(entry->'rank') <> 'number'
        OR (entry->>'rank') !~ '^[1-9][0-9]*$'
        OR (entry->>'rank')::integer <> position
        OR jsonb_typeof(entry->'confirmed_referrals') <> 'number'
        OR (entry->>'confirmed_referrals') !~ '^[0-9]+$'
        OR jsonb_typeof(entry->'display_handle') <> 'string'
        OR (entry->>'display_handle') !~ '^[A-Za-z0-9_-]{12}$'
    ) END;
$$;

CREATE TABLE leaderboard_snapshot (
  id uuid PRIMARY KEY,
  as_of timestamptz NOT NULL,
  entries jsonb NOT NULL CHECK (valid_leaderboard_entries(entries))
);
CREATE INDEX idx_leaderboard_snapshot_latest ON leaderboard_snapshot (as_of DESC, id DESC);
GRANT SELECT, INSERT, DELETE ON leaderboard_snapshot TO valstara_app;

-- A durable skip marker makes a missed weekly window visible across restarts.
CREATE TABLE weekly_campaign_run (
  iso_week text PRIMARY KEY CHECK (iso_week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'),
  state text NOT NULL CHECK (state IN ('started', 'skipped', 'completed')),
  snapshot_id uuid REFERENCES leaderboard_snapshot(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL,
  alerted_at timestamptz
);
GRANT SELECT, INSERT, UPDATE ON weekly_campaign_run TO valstara_app;

ALTER TABLE email_send ADD COLUMN expires_at timestamptz;
GRANT SELECT (expires_at) ON email_send TO valstara_app;
GRANT INSERT (expires_at) ON email_send TO valstara_app;

ALTER TABLE email_send DROP CONSTRAINT email_send_payload_references_only;
ALTER TABLE email_send ADD CONSTRAINT email_send_payload_references_only CHECK (
  jsonb_typeof(payload) = 'object'
  AND payload - 'token_id' - 'award_id' - 'tier' - 'status_token_id' - 'rules_version' - 'snapshot_id' = '{}'::jsonb
  AND (NOT payload ? 'token_id' OR (jsonb_typeof(payload->'token_id') = 'string' AND payload->>'token_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'award_id' OR (jsonb_typeof(payload->'award_id') = 'string' AND payload->>'award_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'status_token_id' OR (jsonb_typeof(payload->'status_token_id') = 'string' AND payload->>'status_token_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'snapshot_id' OR (jsonb_typeof(payload->'snapshot_id') = 'string' AND payload->>'snapshot_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'rules_version' OR (jsonb_typeof(payload->'rules_version') = 'string' AND payload->>'rules_version' ~ '^VAL-GW-[A-Z0-9]+-[0-9]{8}-r[1-9][0-9]*$'))
  AND (NOT payload ? 'tier' OR (jsonb_typeof(payload->'tier') = 'number' AND (payload->>'tier') ~ '^[0-9]+$'))
);
