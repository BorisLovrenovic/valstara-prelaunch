-- E7-03: each entry retains the exact rules revision in force at accrual.
ALTER TABLE giveaway_entry
  ADD COLUMN rules_sha256 bytea NOT NULL,
  ADD CONSTRAINT giveaway_entry_rules_sha256_length
    CHECK (octet_length(rules_sha256) = 32);

GRANT SELECT (giveaway_rules_version) ON TABLE subscriber TO valstara_app;
GRANT UPDATE (giveaway_rules_version) ON TABLE subscriber TO valstara_app;
GRANT SELECT (source_edge_id, rules_version, rules_sha256)
  ON TABLE giveaway_entry TO valstara_app;
GRANT INSERT (id, subscriber_id, method, entries, rules_version,
              rules_sha256, source_edge_id)
  ON TABLE giveaway_entry TO valstara_app;
