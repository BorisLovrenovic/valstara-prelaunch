-- Capture proof before erasure removes the referred subscriber's identity.
ALTER TABLE referral_edge
  ADD COLUMN referred_verified_on_detachment boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT referral_edge_detached_verification CHECK (
    NOT referred_verified_on_detachment OR (referred_id IS NULL AND referrer_id IS NOT NULL)
  );

CREATE FUNCTION record_detached_referral_verification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referred_id IS NOT NULL OR NEW.referrer_id IS NULL THEN
    NEW.referred_verified_on_detachment := false;
  ELSIF OLD.referred_id IS NOT NULL THEN
    NEW.referred_verified_on_detachment := EXISTS (
      SELECT 1 FROM subscriber WHERE id = OLD.referred_id AND verified_at IS NOT NULL
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER referral_edge_detached_verification
  BEFORE UPDATE OF referred_id, referrer_id ON referral_edge
  FOR EACH ROW EXECUTE FUNCTION record_detached_referral_verification();
