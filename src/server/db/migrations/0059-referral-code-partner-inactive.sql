-- E11.7-01, founder decision D-044 (2026-11-21): a partner code always enters
-- the registry inactive, whoever inserts it, so only partner activation
-- (E11.7-07) makes it live. Member rows are unchanged and still insert active.
-- Grants are unchanged: the application role keeps INSERT (code, owner_kind,
-- owner_id) and has no UPDATE.
CREATE FUNCTION insert_partner_code_inactive() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_kind = 'partner' THEN
    NEW.active := false;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER referral_code_partner_inactive BEFORE INSERT ON referral_code
  FOR EACH ROW EXECUTE FUNCTION insert_partner_code_inactive();
