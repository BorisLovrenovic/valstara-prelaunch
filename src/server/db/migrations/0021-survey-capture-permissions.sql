-- E6-03: permit the runtime role to capture versioned survey answers and
-- denormalise the handoff category preference. The existing unique subscriber
-- key remains the database backstop for one replaceable response per person.

GRANT SELECT (id, status) ON TABLE subscriber TO valstara_app;
GRANT UPDATE (category_preference, updated_at) ON TABLE subscriber TO valstara_app;

GRANT SELECT (subscriber_id, answers, version) ON TABLE survey_response TO valstara_app;
GRANT INSERT (id, subscriber_id, answers, version) ON TABLE survey_response TO valstara_app;
GRANT UPDATE (answers, version) ON TABLE survey_response TO valstara_app;
