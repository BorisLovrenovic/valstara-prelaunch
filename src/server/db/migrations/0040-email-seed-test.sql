-- One bounded, non-personal placement record per provider and UTC week.
CREATE TABLE email_seed_test (
  week_start date NOT NULL,
  provider text NOT NULL CHECK (provider IN ('gmail', 'outlook', 'gmx', 'web_de')),
  marker uuid NOT NULL,
  placement text NOT NULL DEFAULT 'pending'
    CHECK (placement IN ('pending', 'inbox', 'spam', 'missing')),
  sent_at timestamptz,
  checked_at timestamptz,
  alerted_at timestamptz,
  PRIMARY KEY (week_start, provider),
  UNIQUE (marker),
  CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  CHECK (placement = 'pending' OR sent_at IS NOT NULL),
  CHECK (alerted_at IS NULL OR placement IN ('spam', 'missing'))
);

GRANT SELECT, INSERT ON email_seed_test TO valstara_app;
GRANT UPDATE (sent_at, placement, checked_at, alerted_at)
  ON email_seed_test TO valstara_app;
