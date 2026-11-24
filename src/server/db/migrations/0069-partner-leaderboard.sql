-- E11.7-10: earlier names stay unversioned until the partner confirms them.
ALTER TABLE partner ADD COLUMN display_name_disclosure_version integer
  CHECK (display_name_disclosure_version IS NULL OR (
    display_name_disclosure_version > 0 AND display_name IS NOT NULL
  ));

CREATE FUNCTION clear_partner_display_name_disclosure() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.display_name IS NULL OR NEW.personal_data_purged_at IS NOT NULL THEN
    NEW.display_name_disclosure_version := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER partner_display_name_disclosure_guard
  BEFORE INSERT OR UPDATE OF display_name, display_name_disclosure_version, personal_data_purged_at
  ON partner FOR EACH ROW EXECUTE FUNCTION clear_partner_display_name_disclosure();

GRANT UPDATE (display_name_disclosure_version) ON partner TO valstara_app;

CREATE TABLE partner_leaderboard_snapshot (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  as_of timestamptz
);
INSERT INTO partner_leaderboard_snapshot (singleton) VALUES (true);

CREATE TABLE partner_leaderboard_rank (
  partner_id uuid PRIMARY KEY REFERENCES partner (id),
  rank integer NOT NULL UNIQUE CHECK (rank > 0),
  confirmed_signups integer NOT NULL CHECK (confirmed_signups >= 0)
);

GRANT SELECT ON partner_leaderboard_snapshot TO valstara_app;
GRANT UPDATE (as_of) ON partner_leaderboard_snapshot TO valstara_app;
GRANT SELECT, INSERT, DELETE ON partner_leaderboard_rank TO valstara_app;
