-- E5-02: duplicate-identity screening compares a new subscriber's normalised
-- local part with existing subscribers on other domains. Keep that lookup off
-- a full-table scan without collecting another identity attribute.

CREATE INDEX idx_subscriber_email_normalised_local_part
  ON subscriber ((split_part(email_normalised, '@', 1)));
