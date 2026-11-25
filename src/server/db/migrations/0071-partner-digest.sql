-- E11.7-13: the partner digest. A durable record per reported period makes a
-- skipped period (a missed window or an empty founder note) visible across
-- restarts, and the schedule row records when the configured cadence and send
-- time took effect, so a cadence change never reports earlier windows of the
-- new cadence as missed. Neither table holds personal data.
CREATE TABLE partner_digest_run (
  period text PRIMARY KEY CHECK (
    period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR period ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'
  ),
  cadence text NOT NULL CHECK (cadence IN ('monthly', 'weekly')),
  window_starts_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('started', 'skipped', 'completed')),
  skip_reason text CHECK (skip_reason IN ('missed_window', 'note_missing')),
  recorded_at timestamptz NOT NULL,
  alerted_at timestamptz,
  CONSTRAINT partner_digest_run_period_cadence CHECK (
    (cadence = 'monthly') = (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
  ),
  CONSTRAINT partner_digest_run_skip_reason CHECK (
    (state = 'skipped') = (skip_reason IS NOT NULL)
  ),
  CONSTRAINT partner_digest_run_alert CHECK (
    alerted_at IS NULL OR state = 'skipped'
  )
);
GRANT SELECT, INSERT ON partner_digest_run TO valstara_app;
GRANT UPDATE (state, skip_reason, recorded_at, alerted_at)
  ON partner_digest_run TO valstara_app;

CREATE TABLE partner_digest_schedule (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cadence text NOT NULL CHECK (cadence IN ('monthly', 'weekly')),
  send_time text NOT NULL CHECK (send_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  since timestamptz NOT NULL
);
GRANT SELECT, INSERT ON partner_digest_schedule TO valstara_app;
GRANT UPDATE (cadence, send_time, since) ON partner_digest_schedule TO valstara_app;

-- The digest's payload is the reported period and a status-token reference.
ALTER TABLE email_send DROP CONSTRAINT email_send_payload_references_only;
ALTER TABLE email_send ADD CONSTRAINT email_send_payload_references_only CHECK (
  jsonb_typeof(payload) = 'object'
  AND payload - 'token_id' - 'award_id' - 'tier' - 'status_token_id' - 'rules_version' - 'snapshot_id' - 'period' = '{}'::jsonb
  AND (NOT payload ? 'token_id' OR (jsonb_typeof(payload->'token_id') = 'string' AND payload->>'token_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'award_id' OR (jsonb_typeof(payload->'award_id') = 'string' AND payload->>'award_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'status_token_id' OR (jsonb_typeof(payload->'status_token_id') = 'string' AND payload->>'status_token_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'snapshot_id' OR (jsonb_typeof(payload->'snapshot_id') = 'string' AND payload->>'snapshot_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  AND (NOT payload ? 'rules_version' OR (jsonb_typeof(payload->'rules_version') = 'string' AND payload->>'rules_version' ~ '^VAL-GW-[A-Z0-9]+-[0-9]{8}-r[1-9][0-9]*$'))
  AND (NOT payload ? 'tier' OR (jsonb_typeof(payload->'tier') = 'number' AND (payload->>'tier') ~ '^[0-9]+$'))
  AND (NOT payload ? 'period' OR (jsonb_typeof(payload->'period') = 'string' AND (
    payload->>'period' ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR payload->>'period' ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$')))
);
