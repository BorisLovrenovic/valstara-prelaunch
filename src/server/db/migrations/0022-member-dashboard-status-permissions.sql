-- E6-05: the shared referral-status computation exposes the eligibility stamp
-- to the authenticated bearer. Other dashboard columns were already granted
-- to the runtime role by the tickets that introduced their read paths.

GRANT SELECT (giveaway_eligible) ON TABLE subscriber TO valstara_app;
