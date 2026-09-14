-- E5-01 follow-up within the same ticket: migration 0013 had already run in
-- the local production-shaped stack before label-boundary hardening. Keep it
-- immutable and strengthen the constraint forward-only.

ALTER TABLE domain_allow DROP CONSTRAINT domain_allow_domain_normalised;

ALTER TABLE domain_allow
  ADD CONSTRAINT domain_allow_domain_normalised CHECK (
    domain = lower(domain)
    AND domain = btrim(domain)
    AND length(domain) <= 253
    AND domain ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
    AND position('.' IN domain) > 0
    AND domain !~ '\.\.'
    AND domain !~ '(^|\.)-'
    AND domain !~ '-(\.|$)'
  );
