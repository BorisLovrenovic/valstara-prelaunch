-- E11.7-01: one namespace for every referral code, member and partner alike.
-- The code is stored upper case and is the primary key, so two codes that
-- differ only in case can never both exist. Member codes are mirrored from
-- subscriber.referral_code in the same transaction that assigns them; a
-- partner row's owner is the partner record that E11.7-05 creates.
CREATE TABLE referral_code (
  code text PRIMARY KEY,
  owner_kind text NOT NULL,
  owner_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referral_code_upper_case CHECK (code <> '' AND code = upper(code)),
  CONSTRAINT referral_code_owner_kind CHECK (owner_kind IN ('member', 'partner')),
  -- Partner codes follow the partner code rules: 4-16 of A-Z and 0-9.
  CONSTRAINT referral_code_partner_format CHECK (
    owner_kind <> 'partner' OR code ~ '^[A-Z0-9]{4,16}$'
  ),
  CONSTRAINT referral_code_active_has_owner CHECK (owner_id IS NOT NULL OR NOT active),
  -- A member code is active exactly while its subscriber holds it. Erasure
  -- retires it: the owner is cleared and the code is never reissued.
  CONSTRAINT referral_code_member_owner CHECK (
    owner_kind <> 'member' OR active = (owner_id IS NOT NULL)
  )
);

-- One member code per subscriber; also serves lookup by member owner.
CREATE UNIQUE INDEX uq_referral_code_member_owner
  ON referral_code (owner_id)
  WHERE owner_kind = 'member' AND owner_id IS NOT NULL;

-- The code, its kind and its creation time never change. A member row may
-- only be retired (owner cleared with active false), never revived.
CREATE FUNCTION protect_referral_code_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code
    OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'referral_code code, owner_kind and created_at are immutable';
  END IF;
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id AND NEW.owner_id IS NOT NULL THEN
    RAISE EXCEPTION 'referral_code owner can only be cleared';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER referral_code_identity BEFORE UPDATE ON referral_code
  FOR EACH ROW EXECUTE FUNCTION protect_referral_code_identity();

-- An active member row must be its subscriber's current referral code. The
-- check is deferred because generation claims the registry row before it
-- writes the subscriber, and reads the row's state at commit.
CREATE FUNCTION require_member_code_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_owner uuid;
  current_active boolean;
BEGIN
  SELECT owner_id, active INTO current_owner, current_active
  FROM referral_code WHERE code = NEW.code AND owner_kind = 'member';
  IF current_active AND NOT EXISTS (
    SELECT 1 FROM subscriber
    WHERE id = current_owner AND upper(referral_code) = NEW.code
  ) THEN
    RAISE EXCEPTION 'an active member code must be its subscriber''s referral code';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER referral_code_member_subscriber
  AFTER INSERT OR UPDATE ON referral_code
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_member_code_owner();

-- Every write of subscriber.referral_code is mirrored in the same
-- transaction. A code already held by another owner, in any case, is refused
-- with unique_violation; a cleared code (erasure) is retired.
CREATE FUNCTION sync_member_referral_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.referral_code IS NOT NULL
    AND NEW.referral_code IS DISTINCT FROM OLD.referral_code THEN
    UPDATE referral_code SET active = false, owner_id = NULL
    WHERE code = upper(OLD.referral_code)
      AND owner_kind = 'member' AND owner_id = OLD.id;
  END IF;
  IF NEW.referral_code IS NOT NULL AND (
    TG_OP = 'INSERT' OR NEW.referral_code IS DISTINCT FROM OLD.referral_code
  ) THEN
    INSERT INTO referral_code (code, owner_kind, owner_id)
    VALUES (upper(NEW.referral_code), 'member', NEW.id)
    ON CONFLICT DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM referral_code
      WHERE code = upper(NEW.referral_code)
        AND owner_kind = 'member' AND owner_id = NEW.id AND active
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'unique_violation',
        MESSAGE = 'referral code is already registered';
    END IF;
  END IF;
  RETURN NULL;
END; $$;

-- Creating the trigger locks subscriber writes until this migration commits,
-- so no code can be assigned between the trigger and the backfill.
CREATE TRIGGER subscriber_referral_code_registry
  AFTER INSERT OR UPDATE OF referral_code ON subscriber
  FOR EACH ROW EXECUTE FUNCTION sync_member_referral_code();

-- Backfill every existing member code. Codes are generated at verification,
-- so verified_at is the best record of when each was created.
INSERT INTO referral_code (code, owner_kind, owner_id, active, created_at)
SELECT upper(referral_code), 'member', id, true,
       COALESCE(verified_at, updated_at, created_at, CURRENT_TIMESTAMP)
FROM subscriber
WHERE referral_code IS NOT NULL;

REVOKE ALL ON referral_code FROM PUBLIC;
GRANT SELECT ON referral_code TO valstara_app;
GRANT INSERT (code, owner_kind, owner_id) ON referral_code TO valstara_app;
