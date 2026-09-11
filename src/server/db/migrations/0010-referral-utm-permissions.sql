-- E4-02 persists only server-verified, signed UTM data at signup. The runtime
-- role needs this single additional insert column; it remains unable to alter
-- attribution after the initial write.
GRANT INSERT (utm) ON TABLE subscriber TO valstara_app;
