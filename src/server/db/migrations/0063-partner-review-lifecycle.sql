-- E11.7-06: founder review, contract tracking and the partner lifecycle
-- (docs/features/partner-programme.md#partner-lifecycle; founder decisions
-- D-052, 2026-11-22).
--
-- The founder's commands move an application through review, the contract
-- signed outside this system, and the partnership. This migration adds the
-- contract record and the internal notes, and replaces migration 0062's guard
-- trigger with one that allows exactly the eleven documented transitions.

ALTER TABLE partner
  -- Set by `contract-sent`, when the contract goes out through signfree.io.
  ADD COLUMN contract_sent_at timestamptz,
  -- Set by `contract-signed`: the signing date, the contract version and an
  -- optional signfree reference. Recording them makes the partner active.
  ADD COLUMN contract_signed_at date,
  ADD COLUMN contract_version text,
  -- Personal data: it identifies the person's signed contract. Cleared with
  -- the other personal fields by the purge and by erasure.
  ADD COLUMN contract_reference text,
  -- The founder's internal notes, replaced whole by `note`. Personal data,
  -- cleared by the purge and by erasure (D-052 Q4e).
  ADD COLUMN notes text;

-- The contract goes out before it is signed, and a contracted partner keeps
-- both records. A partner rejected after the contract went out keeps its
-- sending time; one rejected before has none.
ALTER TABLE partner ADD CONSTRAINT partner_contract_sent CHECK (
  CASE
    WHEN status IN ('contract_sent', 'active', 'paused', 'terminated')
      THEN contract_sent_at IS NOT NULL
    WHEN status = 'rejected' THEN true
    ELSE contract_sent_at IS NULL
  END
);
-- Exactly the contracted statuses carry the signing date and version, and
-- the contract is never signed before the UTC day it was sent.
ALTER TABLE partner ADD CONSTRAINT partner_contract_signed CHECK (
  (status IN ('active', 'paused', 'terminated')) = (contract_signed_at IS NOT NULL)
  AND (contract_signed_at IS NULL) = (contract_version IS NULL)
  AND (
    contract_signed_at IS NULL
    OR contract_signed_at >= (contract_sent_at AT TIME ZONE 'UTC')::date
  )
);
-- A version label, never free text.
ALTER TABLE partner ADD CONSTRAINT partner_contract_version CHECK (
  contract_version IS NULL OR contract_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$'
);
ALTER TABLE partner ADD CONSTRAINT partner_contract_reference CHECK (
  contract_reference IS NULL OR (
    contract_signed_at IS NOT NULL
    AND btrim(contract_reference) <> ''
    AND char_length(contract_reference) <= 200
  )
);
ALTER TABLE partner ADD CONSTRAINT partner_notes CHECK (
  notes IS NULL OR (btrim(notes) <> '' AND char_length(notes) <= 2000)
);

-- A purge clears the contract reference and the notes with every other
-- personal field. The status, type, timestamps, signing date and version stay.
ALTER TABLE partner DROP CONSTRAINT partner_purged_fields;
ALTER TABLE partner ADD CONSTRAINT partner_purged_fields CHECK (
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
    AND contract_reference IS NULL
    AND notes IS NULL
  )
);

-- One partner code per partner, registered at approval.
CREATE UNIQUE INDEX uq_referral_code_partner_owner
  ON referral_code (owner_id)
  WHERE owner_kind = 'partner' AND owner_id IS NOT NULL;

-- `partners list` filters on the status, and `--since` on applied_at.
CREATE INDEX idx_partner_review ON partner (status, applied_at, id)
  WHERE status <> 'unconfirmed';

-- The lifecycle guard replaces migration 0062's. It keeps every rule that
-- guard enforced and adds the transition matrix (D-052 Q1): exactly these
-- eleven moves between the eight statuses are allowed, and every other pair,
-- including any move out of rejected or terminated, is refused.
DROP TRIGGER partner_application_guard ON partner;
DROP FUNCTION guard_partner_application();

CREATE FUNCTION guard_partner_lifecycle() RETURNS trigger
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
    IF OLD.personal_data_purged_at IS NOT NULL
      AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'a purged application keeps its status';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF (OLD.status, NEW.status) NOT IN (
        ('unconfirmed', 'applied'),
        ('applied', 'approved'),
        ('applied', 'rejected'),
        ('approved', 'contract_sent'),
        ('approved', 'rejected'),
        ('contract_sent', 'active'),
        ('contract_sent', 'rejected'),
        ('active', 'paused'),
        ('active', 'terminated'),
        ('paused', 'active'),
        ('paused', 'terminated')
      ) THEN
        RAISE EXCEPTION 'partner status cannot move from % to %',
          OLD.status, NEW.status;
      END IF;
      IF NEW.status_changed_at < OLD.status_changed_at THEN
        RAISE EXCEPTION 'partner status_changed_at cannot move backwards';
      END IF;
      -- Approval registers the partner code first (E11.7-06 approve).
      IF NEW.status = 'approved' AND NOT EXISTS (
        SELECT 1 FROM referral_code
        WHERE owner_kind = 'partner' AND owner_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'an approved partner has a registered partner code';
      END IF;
    ELSIF NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at THEN
      RAISE EXCEPTION 'partner status_changed_at changes only with the status';
    END IF;

    -- The contract record is written once, by the transition that records it.
    IF NEW.contract_sent_at IS DISTINCT FROM OLD.contract_sent_at
      AND NOT (OLD.status = 'approved' AND NEW.status = 'contract_sent') THEN
      RAISE EXCEPTION 'partner contract_sent_at is set only by contract-sent';
    END IF;
    IF (NEW.contract_signed_at IS DISTINCT FROM OLD.contract_signed_at
        OR NEW.contract_version IS DISTINCT FROM OLD.contract_version)
      AND NOT (OLD.status = 'contract_sent' AND NEW.status = 'active') THEN
      RAISE EXCEPTION 'partner contract signing is recorded only by contract-signed';
    END IF;
    IF NEW.contract_reference IS DISTINCT FROM OLD.contract_reference
      AND NOT (OLD.status = 'contract_sent' AND NEW.status = 'active')
      AND NOT (NEW.contract_reference IS NULL AND NEW.personal_data_purged_at IS NOT NULL) THEN
      RAISE EXCEPTION 'partner contract_reference is set by contract-signed and cleared only by a purge';
    END IF;
  END IF;

  -- An application leaves `unconfirmed`, or is inserted past it, only for a
  -- verified member.
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
CREATE TRIGGER partner_lifecycle_guard BEFORE INSERT OR UPDATE ON partner
  FOR EACH ROW EXECUTE FUNCTION guard_partner_lifecycle();

-- A write that names the status must change it: a "move" from a status to
-- itself is not one of the eleven transitions. Writes that leave the status
-- out (the purge, erasure, notes, the partner type) are unaffected.
CREATE FUNCTION refuse_partner_status_unchanged() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'partner status cannot move from % to %', OLD.status, NEW.status;
END; $$;
CREATE TRIGGER partner_status_must_change BEFORE UPDATE OF status ON partner
  FOR EACH ROW WHEN (NEW.status = OLD.status)
  EXECUTE FUNCTION refuse_partner_status_unchanged();

-- An erased or purged partner's code is deactivated and never reissued
-- (planning default, moved to E11.7-06 by D-050): the registry row stays, so
-- the code can never be registered again, but it loses its owner and is
-- inactive, as a retired member code is. The application role has no UPDATE
-- on referral_code, so this narrowly scoped definer function does it, and only
-- for the row this partner owns.
CREATE FUNCTION retire_purged_partner_code() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE referral_code SET active = false, owner_id = NULL
  WHERE owner_kind = 'partner' AND owner_id = NEW.id;
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION retire_purged_partner_code() FROM PUBLIC;
CREATE TRIGGER partner_purge_retires_code
  AFTER UPDATE OF personal_data_purged_at ON partner
  FOR EACH ROW
  WHEN (OLD.personal_data_purged_at IS NULL AND NEW.personal_data_purged_at IS NOT NULL)
  EXECUTE FUNCTION retire_purged_partner_code();

-- The founder's commands set the type, the contract record and the notes.
GRANT UPDATE (
  partner_type, contract_sent_at, contract_signed_at, contract_version,
  contract_reference, notes
) ON partner TO valstara_app;
