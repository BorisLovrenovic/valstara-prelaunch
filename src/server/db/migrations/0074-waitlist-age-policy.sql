-- E11.8-06: the waitlist at 13 and over, with an 18+ giveaway box.
--
-- `admission_age_policy` records the age policy a member joined under, when
-- their row is created, and never changes: switching `waitlist.age_13` off
-- later cannot remove a 13+ member's need for the giveaway box (founder
-- decision 2, D-081). Every existing row joined under the 18+ statement.
--
-- `giveaway_opt_in_at` records when the separate, unticked "I'm 18 or over,
-- enter me in the giveaway" box was ticked, and `giveaway_opt_in_source`
-- where: on a signup form (`signup`) or on `/me` (`member_status`). Both are
-- written once. A check rejects a tick without a signup: the time can never
-- precede the row's creation, and a tick on `/me` needs a verified member.
--
-- Erasure clears all three, as it clears `signup_had_ref`. Additive: an
-- earlier image ignores the columns, and every existing row stays valid.
ALTER TABLE subscriber
  ADD COLUMN admission_age_policy text DEFAULT '18_plus',
  ADD COLUMN giveaway_opt_in_at timestamptz,
  ADD COLUMN giveaway_opt_in_source text;

UPDATE subscriber SET admission_age_policy = NULL WHERE status = 'erased';

ALTER TABLE subscriber
  ADD CONSTRAINT subscriber_admission_age_policy_shape CHECK (
    (status = 'erased' AND admission_age_policy IS NULL) OR
    (status <> 'erased' AND admission_age_policy IN ('18_plus', '13_plus'))
  ),
  ADD CONSTRAINT subscriber_giveaway_opt_in_complete CHECK (
    (giveaway_opt_in_at IS NULL) = (giveaway_opt_in_source IS NULL)
  ),
  ADD CONSTRAINT subscriber_giveaway_opt_in_source CHECK (
    giveaway_opt_in_source IN ('signup', 'member_status')
  ),
  ADD CONSTRAINT subscriber_giveaway_opt_in_requires_signup CHECK (
    giveaway_opt_in_at IS NULL OR (
      status <> 'erased' AND created_at IS NOT NULL
      AND giveaway_opt_in_at >= created_at
      AND (giveaway_opt_in_source = 'signup' OR verified_at IS NOT NULL)
    )
  );

CREATE FUNCTION preserve_subscriber_age_admission() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'erased' THEN
    NEW.admission_age_policy := NULL;
    NEW.giveaway_opt_in_at := NULL;
    NEW.giveaway_opt_in_source := NULL;
    RETURN NEW;
  END IF;
  IF NEW.admission_age_policy IS DISTINCT FROM OLD.admission_age_policy THEN
    RAISE EXCEPTION 'subscriber.admission_age_policy is write-once';
  END IF;
  IF OLD.giveaway_opt_in_at IS NOT NULL AND (
    NEW.giveaway_opt_in_at IS DISTINCT FROM OLD.giveaway_opt_in_at OR
    NEW.giveaway_opt_in_source IS DISTINCT FROM OLD.giveaway_opt_in_source
  ) THEN
    RAISE EXCEPTION 'subscriber.giveaway_opt_in_at is write-once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subscriber_age_admission_write_once
BEFORE UPDATE ON subscriber
FOR EACH ROW EXECUTE FUNCTION preserve_subscriber_age_admission();

GRANT INSERT (admission_age_policy, giveaway_opt_in_at, giveaway_opt_in_source)
  ON TABLE subscriber TO valstara_app;
GRANT SELECT (admission_age_policy, giveaway_opt_in_at, giveaway_opt_in_source)
  ON TABLE subscriber TO valstara_app;
GRANT UPDATE (giveaway_opt_in_at, giveaway_opt_in_source)
  ON TABLE subscriber TO valstara_app;
