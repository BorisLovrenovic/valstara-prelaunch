CREATE TABLE email_broadcast_seed_test (
  week_start date NOT NULL,
  provider text NOT NULL CHECK (provider IN ('gmail', 'outlook', 'gmx', 'web_de')),
  marker uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'passed', 'missing_plain_part',
      'tracking_pixel', 'rewritten_link', 'missing')),
  sent_at timestamptz,
  checked_at timestamptz,
  alerted_at timestamptz,
  PRIMARY KEY (week_start, provider),
  CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  CHECK (state = 'pending' OR sent_at IS NOT NULL),
  CHECK (alerted_at IS NULL OR state NOT IN ('pending', 'passed'))
);

GRANT SELECT, INSERT ON email_broadcast_seed_test TO valstara_app;
GRANT UPDATE (state, sent_at, checked_at, alerted_at)
  ON email_broadcast_seed_test TO valstara_app;
