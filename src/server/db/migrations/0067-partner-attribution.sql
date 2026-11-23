-- E11.7-07: an edge's signup count and partner discount are durable facts.
ALTER TABLE referral_edge
  ADD COLUMN partner_id uuid REFERENCES partner(id),
  ADD COLUMN attribution_method text NOT NULL DEFAULT 'link'
    CHECK (attribution_method IN ('link', 'code', 'retroactive')),
  ADD COLUMN welcome_discount_pct integer CHECK (welcome_discount_pct IN (10, 15, 20)),
  ADD COLUMN signup_confirmed_count integer CHECK (signup_confirmed_count >= 0),
  ADD CONSTRAINT referral_edge_partner_discount_pair CHECK (
    (partner_id IS NULL) = (welcome_discount_pct IS NULL)
    AND (partner_id IS NULL OR (referrer_id IS NOT NULL AND referred_id IS NOT NULL))
  );

CREATE FUNCTION protect_partner_attribution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.signup_confirmed_count IS DISTINCT FROM OLD.signup_confirmed_count THEN
      RAISE EXCEPTION 'referral signup count is immutable';
    END IF;
    IF (NEW.partner_id, NEW.attribution_method, NEW.welcome_discount_pct)
      IS DISTINCT FROM (OLD.partner_id, OLD.attribution_method, OLD.welcome_discount_pct)
      AND NOT (
        OLD.partner_id IS NULL AND NEW.partner_id IS NOT NULL
        AND NEW.attribution_method = 'retroactive'
        AND OLD.state = 'confirmed' AND OLD.voided_at IS NULL
      ) AND NOT (
        OLD.partner_id IS NOT NULL AND NEW.partner_id IS NULL
        AND NEW.attribution_method = OLD.attribution_method
        AND (NEW.referrer_id IS NULL OR NEW.referred_id IS NULL)
      ) THEN
      RAISE EXCEPTION 'referral attribution is fixed after assignment';
    END IF;
  END IF;

  IF NEW.partner_id IS NOT NULL AND (
    TG_OP = 'INSERT' OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
      OR NEW.referrer_id IS DISTINCT FROM OLD.referrer_id
  ) AND NOT EXISTS (
    SELECT 1 FROM partner WHERE id = NEW.partner_id AND subscriber_id = NEW.referrer_id
  ) THEN
    RAISE EXCEPTION 'the referral partner must belong to the referrer';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER referral_edge_partner_attribution
  BEFORE INSERT OR UPDATE ON referral_edge FOR EACH ROW EXECUTE FUNCTION protect_partner_attribution();

CREATE INDEX referral_edge_confirmed_referrer_time ON referral_edge (referrer_id, confirmed_at)
  WHERE state = 'confirmed';
CREATE INDEX referral_edge_partner_id ON referral_edge (partner_id)
  WHERE partner_id IS NOT NULL;
CREATE INDEX audit_partner_approval_subject ON audit_log (subject_id)
  WHERE subject_type = 'partner' AND action = 'partner.approved';
CREATE INDEX audit_referral_void_subject ON audit_log (subject_id, action, at)
  WHERE subject_type = 'referral_edge' AND action IN ('referral.voided', 'referral.unvoided');

GRANT INSERT (partner_id, attribution_method, welcome_discount_pct, signup_confirmed_count),
      UPDATE (partner_id, attribution_method, welcome_discount_pct) ON referral_edge TO valstara_app;

-- Preserve the surviving subscriber's own benefits independently of an erased
-- referrer. The key and the two perks are the entire record.
CREATE TABLE retained_partner_entitlement (
  subscriber_id uuid PRIMARY KEY REFERENCES subscriber(id),
  welcome_discount_pct integer NOT NULL CHECK (welcome_discount_pct IN (10, 15, 20)),
  wave_one boolean NOT NULL CHECK (wave_one)
);
REVOKE ALL ON retained_partner_entitlement FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON retained_partner_entitlement TO valstara_app;

-- The app may flip a partner code but cannot activate a member code, reissue
-- a retired code, or activate a code for a non-active partnership.
CREATE FUNCTION set_partner_code_active(partner_id uuid, make_active boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.referral_code code SET active = make_active
  WHERE code.owner_kind = 'partner' AND code.owner_id = partner_id
    AND code.active IS DISTINCT FROM make_active
    AND (NOT make_active OR EXISTS (
      SELECT 1 FROM public.partner p JOIN public.subscriber s ON s.id = p.subscriber_id
      WHERE p.id = partner_id AND p.status = 'active'
        AND p.personal_data_purged_at IS NULL AND s.status = 'verified'
    ));
END;
$$;
REVOKE ALL ON FUNCTION set_partner_code_active(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_partner_code_active(uuid, boolean) TO valstara_app;

-- Prevent activation from committing on the opposite side of a flag change
-- from the override it read. Readers doing partner writes take the shared lock.
CREATE FUNCTION lock_partner_activation_flag_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND OLD.key = 'partners.enabled')
     OR (TG_OP <> 'DELETE' AND NEW.key = 'partners.enabled') THEN
    PERFORM pg_advisory_xact_lock(hashtext('valstara:partners.enabled'));
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER partner_activation_flag_write
  BEFORE INSERT OR UPDATE OR DELETE ON campaign_flag
  FOR EACH ROW EXECUTE FUNCTION lock_partner_activation_flag_write();
