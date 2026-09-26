-- E7-04: a base or referral ledger row is exactly one draw unit.
-- VALIDATE checks all existing rows before this migration can complete.
ALTER TABLE giveaway_entry
  ADD CONSTRAINT giveaway_entry_one_unit CHECK (entries = 1) NOT VALID;

ALTER TABLE giveaway_entry
  VALIDATE CONSTRAINT giveaway_entry_one_unit;
