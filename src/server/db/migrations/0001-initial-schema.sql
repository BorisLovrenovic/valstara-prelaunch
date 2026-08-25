CREATE TABLE IF NOT EXISTS migration_ledger (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL,
  checksum text NOT NULL,
  applied_by_release text NOT NULL
);

CREATE TABLE subscriber (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  email_normalised text NOT NULL,
  email_domain text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'verified', 'expired', 'unsubscribed', 'bounced', 'disqualified')),
  country char(2),
  country_detected char(2),
  region text,
  category_preference text[],
  source text,
  utm jsonb,
  referral_code text,
  referred_by_id uuid REFERENCES subscriber(id),
  referral_tier integer NOT NULL DEFAULT 0 CHECK (referral_tier >= 0),
  confirmed_referrals integer NOT NULL DEFAULT 0 CHECK (confirmed_referrals >= 0),
  access_window text CHECK (access_window IN ('wave-1', 'wave-2', 'wave-3', 'wave-4')),
  subslush_customer boolean NOT NULL DEFAULT false,
  giveaway_eligible boolean,
  signup_ip_prefix_hash bytea,
  verified_at timestamptz,
  unsubscribed_at timestamptz,
  expired_at timestamptz,
  disqualified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_subscriber_email_normalised UNIQUE (email_normalised),
  CONSTRAINT uq_subscriber_referral_code UNIQUE (referral_code)
);

CREATE INDEX idx_subscriber_referred_by_id ON subscriber (referred_by_id);
CREATE INDEX idx_subscriber_status_created_at ON subscriber (status, created_at);
CREATE INDEX idx_subscriber_status_confirmed_referrals ON subscriber (status, confirmed_referrals DESC);
CREATE INDEX idx_subscriber_signup_ip_prefix_hash ON subscriber (signup_ip_prefix_hash) WHERE signup_ip_prefix_hash IS NOT NULL;

CREATE FUNCTION prevent_subscriber_referred_by_reassignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.referred_by_id IS NOT NULL AND NEW.referred_by_id IS DISTINCT FROM OLD.referred_by_id THEN
    RAISE EXCEPTION 'subscriber.referred_by_id is write-once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subscriber_referred_by_id_write_once
BEFORE UPDATE OF referred_by_id ON subscriber
FOR EACH ROW
EXECUTE FUNCTION prevent_subscriber_referred_by_reassignment();

CREATE TABLE verification_token (
  id uuid PRIMARY KEY,
  subscriber_id uuid NOT NULL REFERENCES subscriber(id),
  token_hash bytea NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'status', 'unsubscribe')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_verification_token_hash UNIQUE (token_hash)
);

CREATE TABLE referral_edge (
  id uuid PRIMARY KEY,
  referrer_id uuid NOT NULL REFERENCES subscriber(id),
  referred_id uuid NOT NULL REFERENCES subscriber(id),
  state text NOT NULL CHECK (state IN ('attributed', 'confirmed', 'rejected')),
  reward_state text NOT NULL CHECK (reward_state IN ('none', 'settled', 'held', 'void')),
  rejected_reason text CHECK (rejected_reason IN ('self_referral', 'duplicate_identity', 'referrer_disqualified', 'manual')),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_referral_edge_referred_id UNIQUE (referred_id)
);

CREATE TABLE milestone_award (
  id uuid PRIMARY KEY,
  subscriber_id uuid NOT NULL REFERENCES subscriber(id),
  tier integer NOT NULL CHECK (tier >= 0),
  reward_kind text NOT NULL CHECK (reward_kind IN ('entries', 'discount', 'wave_upgrade', 'merch')),
  state text NOT NULL CHECK (state IN ('settled', 'held', 'void')),
  awarded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_milestone_award_subscriber_tier UNIQUE (subscriber_id, tier)
);

CREATE TABLE survey_response (
  id uuid PRIMARY KEY,
  subscriber_id uuid NOT NULL UNIQUE REFERENCES subscriber(id),
  answers jsonb NOT NULL,
  version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE giveaway_entry (
  id uuid PRIMARY KEY,
  subscriber_id uuid NOT NULL REFERENCES subscriber(id),
  method text NOT NULL CHECK (method IN ('base', 'referral', 'amoe')),
  entries integer NOT NULL CHECK (entries > 0),
  jurisdiction char(2) NOT NULL,
  rules_version text NOT NULL,
  source_edge_id uuid REFERENCES referral_edge(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_giveaway_entry_subscriber_method_source_edge UNIQUE NULLS NOT DISTINCT (subscriber_id, method, source_edge_id)
);

CREATE TABLE giveaway_draw (
  id uuid PRIMARY KEY,
  executed_at timestamptz NOT NULL,
  seed text NOT NULL,
  entry_snapshot_hash bytea NOT NULL,
  winners jsonb NOT NULL,
  executed_by text NOT NULL,
  reproduced_at timestamptz
);

CREATE TABLE fraud_flag (
  id uuid PRIMARY KEY,
  subscriber_id uuid NOT NULL REFERENCES subscriber(id),
  kind text NOT NULL CHECK (kind IN ('disposable_domain', 'no_mx', 'self_referral', 'duplicate_identity', 'ip_velocity', 'manual')),
  detail jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'dismissed', 'upheld')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE email_send (
  id uuid PRIMARY KEY,
  subscriber_id uuid NOT NULL REFERENCES subscriber(id),
  template text NOT NULL,
  provider text NOT NULL,
  business_key text NOT NULL,
  provider_message_id text,
  state text NOT NULL CHECK (state IN ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_email_send_business_key UNIQUE (business_key)
);

CREATE TABLE suppression (
  email_normalised text PRIMARY KEY,
  reason text NOT NULL CHECK (reason IN ('unsubscribe', 'bounce_hard', 'complaint', 'manual')),
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE campaign_flag (
  key text PRIMARY KEY,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by text NOT NULL
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor text NOT NULL,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  detail jsonb NOT NULL,
  request_id text
);

CREATE TABLE rate_limit_bucket (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0)
);
