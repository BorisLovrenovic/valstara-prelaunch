-- E7-03: enforce the first-entry stamp and index bounded reconciliation.
CREATE UNIQUE INDEX uq_giveaway_entry_source_edge
  ON giveaway_entry (source_edge_id)
  WHERE source_edge_id IS NOT NULL;

CREATE INDEX idx_subscriber_verified_at_for_entry
  ON subscriber (verified_at, id)
  WHERE status = 'verified';

CREATE INDEX idx_referral_edge_confirmed_at_for_entry
  ON referral_edge (confirmed_at, referrer_id, id)
  WHERE state = 'confirmed';

CREATE FUNCTION prevent_subscriber_giveaway_rules_version_reassignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.giveaway_rules_version IS NOT NULL
     AND NEW.giveaway_rules_version IS DISTINCT FROM OLD.giveaway_rules_version THEN
    RAISE EXCEPTION 'subscriber.giveaway_rules_version is write-once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subscriber_giveaway_rules_version_write_once
BEFORE UPDATE OF giveaway_rules_version ON subscriber
FOR EACH ROW
EXECUTE FUNCTION prevent_subscriber_giveaway_rules_version_reassignment();
