-- E5-03: persist only the HMAC of a truncated prefix and grant the bounded
-- velocity query and 90-day retention purge their least-privilege columns.
GRANT INSERT (signup_ip_prefix_hash) ON TABLE subscriber TO valstara_app;
GRANT SELECT (signup_ip_prefix_hash, created_at) ON TABLE subscriber TO valstara_app;
GRANT UPDATE (signup_ip_prefix_hash, updated_at) ON TABLE subscriber TO valstara_app;
