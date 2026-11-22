-- E11.7-05: the partner application (docs/features/partner-programme.md,
-- founder decisions D-050, 2026-11-22).
--
-- One row per submitted application. A submission creates the row
-- `unconfirmed`, bound to the `partner_application` token its confirmation
-- link carries; confirming that link moves it to `applied`. The rest of the
-- lifecycle (approved, contract_sent, active, paused, terminated, rejected) is
-- set by the founder's commands from E11.7-06, which also adds the full
-- transition matrix. The partner's email is the linked subscriber's: it is not
-- copied here. The requested code is checked by the E11.7-01 rules on submit
-- and is not reserved in the referral_code registry (D-050 Q3).

-- A partner application token, issued and consumed through the existing
-- verification_token table (D-050 Q1).
ALTER TABLE verification_token DROP CONSTRAINT verification_token_purpose_check;
ALTER TABLE verification_token ADD CONSTRAINT verification_token_purpose_check
  CHECK (purpose IN (
    'verify', 'status', 'unsubscribe', 'dsr_export', 'dsr_delete',
    'partner_application'
  ));

-- The retention purge records its runs with the other purge jobs.
ALTER TABLE purge_job_run DROP CONSTRAINT purge_job_run_job_key_check;
ALTER TABLE purge_job_run ADD CONSTRAINT purge_job_run_job_key_check
  CHECK (job_key IN (
    'ip_prefix_retention',
    'rate_limit_retention',
    'verification_token_retention',
    'leaderboard_snapshot_purge',
    'partner_application_purge'
  ));

CREATE TABLE partner (
  id uuid PRIMARY KEY,
  -- The member record for the applicant's email. Cleared, with every other
  -- personal field, by the retention purge and by erasure.
  subscriber_id uuid REFERENCES subscriber (id),
  status text NOT NULL DEFAULT 'unconfirmed',
  status_changed_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL,
  applied_at timestamptz,
  -- True when this application created its pending subscriber, which is then
  -- left out of the waitlist verification reminders (D-050 Q1).
  created_subscriber boolean NOT NULL DEFAULT false,
  -- The confirmation link's token. Set null when the token is purged.
  confirmation_token_id uuid REFERENCES verification_token (id) ON DELETE SET NULL,
  -- The brief's section 3.2 fields, and nothing else.
  full_name text,
  country_of_residence text,
  partner_type text NOT NULL,
  channels text[],
  handles text[],
  audience_size text,
  promotion_plan text,
  requested_code text,
  university text,
  student_email text,
  company_name text,
  age_confirmed boolean,
  programme_terms_agreed boolean,
  personal_data_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT partner_status CHECK (status IN (
    'unconfirmed', 'applied', 'approved', 'contract_sent', 'active',
    'paused', 'terminated', 'rejected'
  )),
  CONSTRAINT partner_type_value CHECK (
    partner_type IN ('standard', 'student_ambassador', 'creator')
  ),
  -- Only a confirmed application reaches applied, so every status after
  -- unconfirmed has its confirmation time.
  CONSTRAINT partner_applied_at CHECK (
    (status = 'unconfirmed') = (applied_at IS NULL)
  ),
  CONSTRAINT partner_applied_after_submission CHECK (
    applied_at IS NULL OR applied_at >= submitted_at
  ),
  CONSTRAINT partner_status_changed_after_submission CHECK (
    status_changed_at >= submitted_at
  ),
  -- Until the personal fields are purged, the application holds every
  -- required field, and its member link.
  CONSTRAINT partner_required_fields CHECK (
    personal_data_purged_at IS NOT NULL OR (
      subscriber_id IS NOT NULL
      AND full_name IS NOT NULL
      AND country_of_residence IS NOT NULL
      AND channels IS NOT NULL
      AND handles IS NOT NULL
      AND audience_size IS NOT NULL
      AND promotion_plan IS NOT NULL
      AND requested_code IS NOT NULL
      AND age_confirmed
      AND programme_terms_agreed
    )
  ),
  -- A purge clears every personal field and the member link together.
  CONSTRAINT partner_purged_fields CHECK (
    personal_data_purged_at IS NULL OR (
      subscriber_id IS NULL
      AND full_name IS NULL
      AND country_of_residence IS NULL
      AND channels IS NULL
      AND handles IS NULL
      AND audience_size IS NULL
      AND promotion_plan IS NULL
      AND requested_code IS NULL
      AND university IS NULL
      AND student_email IS NULL
      AND company_name IS NULL
      AND age_confirmed IS NULL
      AND programme_terms_agreed IS NULL
      AND confirmation_token_id IS NULL
    )
  ),
  -- A student ambassador names a university or college; a business name and
  -- a student email are optional.
  CONSTRAINT partner_ambassador_university CHECK (
    personal_data_purged_at IS NOT NULL
    OR partner_type <> 'student_ambassador'
    OR university IS NOT NULL
  ),
  CONSTRAINT partner_full_name CHECK (
    full_name IS NULL OR (btrim(full_name) <> '' AND char_length(full_name) <= 200)
  ),
  -- An ISO 3166-1 alpha-2 code from the application's country list.
  CONSTRAINT partner_country CHECK (
    country_of_residence IS NULL OR country_of_residence ~ '^[A-Z]{2}$'
  ),
  CONSTRAINT partner_channels CHECK (
    channels IS NULL OR (
      cardinality(channels) BETWEEN 1 AND 9
      AND channels <@ ARRAY[
        'tiktok', 'youtube', 'instagram', 'x', 'discord', 'telegram_whatsapp',
        'newsletter_blog', 'campus_offline', 'other'
      ]::text[]
    )
  ),
  CONSTRAINT partner_handles CHECK (
    handles IS NULL OR cardinality(handles) BETWEEN 1 AND 10
  ),
  CONSTRAINT partner_audience_size CHECK (
    audience_size IS NULL OR audience_size IN (
      'under_1k', '1k_10k', '10k_50k', '50k_150k', '150k_plus'
    )
  ),
  CONSTRAINT partner_promotion_plan CHECK (
    promotion_plan IS NULL
    OR (btrim(promotion_plan) <> '' AND char_length(promotion_plan) <= 500)
  ),
  -- The E11.7-01 format, stored upper case. Not unique: the registry decides
  -- at approval (E11.7-06).
  CONSTRAINT partner_requested_code CHECK (
    requested_code IS NULL OR requested_code ~ '^[A-Z0-9]{4,16}$'
  ),
  CONSTRAINT partner_university CHECK (
    university IS NULL OR (btrim(university) <> '' AND char_length(university) <= 200)
  ),
  CONSTRAINT partner_student_email CHECK (
    student_email IS NULL OR (student_email LIKE '%_@_%' AND char_length(student_email) <= 254)
  ),
  CONSTRAINT partner_company_name CHECK (
    company_name IS NULL OR (btrim(company_name) <> '' AND char_length(company_name) <= 200)
  )
);

-- One live application or partnership per member. Unconfirmed and rejected
-- applications do not count, so a rejected applicant may apply again.
CREATE UNIQUE INDEX uq_partner_live_subscriber ON partner (subscriber_id)
  WHERE subscriber_id IS NOT NULL AND status NOT IN ('unconfirmed', 'rejected');
-- Confirmation resolves the application from its token.
CREATE UNIQUE INDEX uq_partner_confirmation_token ON partner (confirmation_token_id)
  WHERE confirmation_token_id IS NOT NULL;
-- DSR export and erasure, and the reminder exclusion, find a member's rows.
CREATE INDEX idx_partner_subscriber ON partner (subscriber_id)
  WHERE subscriber_id IS NOT NULL;
-- The retention purge scans the unpurged unconfirmed and rejected rows.
CREATE INDEX idx_partner_retention ON partner (status_changed_at, id)
  WHERE personal_data_purged_at IS NULL AND status IN ('unconfirmed', 'rejected');

-- An application leaves `unconfirmed` only for a verified member, and never
-- returns to it; the submission time, type and creation facts never change.
CREATE FUNCTION guard_partner_application() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
      OR NEW.created_subscriber IS DISTINCT FROM OLD.created_subscriber
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'partner id, submission and creation facts are immutable';
    END IF;
    IF NEW.subscriber_id IS DISTINCT FROM OLD.subscriber_id
      AND NEW.subscriber_id IS NOT NULL THEN
      RAISE EXCEPTION 'partner subscriber can only be cleared';
    END IF;
    IF OLD.status <> 'unconfirmed' AND NEW.status = 'unconfirmed' THEN
      RAISE EXCEPTION 'a confirmed application cannot return to unconfirmed';
    END IF;
    IF OLD.personal_data_purged_at IS NOT NULL
      AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'a purged application keeps its status';
    END IF;
  END IF;
  IF NEW.status <> 'unconfirmed'
    AND (TG_OP = 'INSERT' OR OLD.status = 'unconfirmed')
    AND NOT EXISTS (
      SELECT 1 FROM subscriber
      WHERE id = NEW.subscriber_id AND status = 'verified'
    ) THEN
    RAISE EXCEPTION 'only an application confirmed by a verified member leaves unconfirmed';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER partner_application_guard BEFORE INSERT OR UPDATE ON partner
  FOR EACH ROW EXECUTE FUNCTION guard_partner_application();

REVOKE ALL ON partner FROM PUBLIC;
GRANT SELECT ON partner TO valstara_app;
GRANT INSERT (
  id, subscriber_id, status, status_changed_at, submitted_at,
  created_subscriber, confirmation_token_id, full_name, country_of_residence,
  partner_type, channels, handles, audience_size, promotion_plan,
  requested_code, university, student_email, company_name, age_confirmed,
  programme_terms_agreed
) ON partner TO valstara_app;
-- Confirmation sets applied; the purge and erasure clear the personal fields.
GRANT UPDATE (
  subscriber_id, status, status_changed_at, applied_at, confirmation_token_id,
  full_name, country_of_residence, channels, handles, audience_size,
  promotion_plan, requested_code, university, student_email, company_name,
  age_confirmed, programme_terms_agreed, personal_data_purged_at
) ON partner TO valstara_app;
