-- E10-03: remember that a subscriber has answered the survey at least once.
-- Replacements and later all-skip submissions must not emit another completion.
ALTER TABLE survey_response ADD COLUMN first_answered_at timestamptz;

UPDATE survey_response
SET first_answered_at = created_at
WHERE answers->'category_preference' <> 'null'::jsonb
   OR answers->'shopping_frequency' <> 'null'::jsonb;

GRANT SELECT (first_answered_at) ON TABLE survey_response TO valstara_app;
GRANT INSERT (first_answered_at) ON TABLE survey_response TO valstara_app;
GRANT UPDATE (first_answered_at) ON TABLE survey_response TO valstara_app;

-- Verification derives anonymous buckets from the original, signed capture.
GRANT SELECT (utm, referred_by_id) ON TABLE subscriber TO valstara_app;
