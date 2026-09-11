ALTER TABLE milestone_award
  DROP CONSTRAINT uq_milestone_award_subscriber_tier;

ALTER TABLE milestone_award
  ADD CONSTRAINT uq_milestone_award_subscriber_tier_kind
  UNIQUE (subscriber_id, tier, reward_kind);
