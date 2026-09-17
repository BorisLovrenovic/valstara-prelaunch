-- E5-06: prize ranking reads the entry weight through the same integrity
-- boundary as the referral leaderboard. Earlier grants already cover the
-- subscriber, flag, ownership and voiding columns used by both queries.

GRANT SELECT (entries) ON TABLE giveaway_entry TO valstara_app;
