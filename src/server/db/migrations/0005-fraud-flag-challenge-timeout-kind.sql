-- E3-03 (Turnstile verification). Founder-authorised 2026-09-07: the Turnstile
-- provider-timeout path accepts the signup, applies strict rate limits, and
-- flags the row for review (ADR-006, fallbacks.md "Turnstile unavailable" → P2).
-- The only "flag for review" surface is fraud_flag, whose kind set (E1-03) had
-- no value for this case; this additive, forward-only change adds one. The
-- signup route writes it directly through a minimal server/db path; the E5
-- fraud module owns every other kind (docs/modules/fraud.md).
--
-- Additive-safe: dropping the old CHECK and adding a superset CHECK preserves
-- every existing row (all satisfy the superset), and a previous image only ever
-- writes the six pre-existing kinds, all still valid.
ALTER TABLE fraud_flag DROP CONSTRAINT fraud_flag_kind_check;

ALTER TABLE fraud_flag
  ADD CONSTRAINT fraud_flag_kind_check
  CHECK (
    kind IN (
      'disposable_domain',
      'no_mx',
      'self_referral',
      'duplicate_identity',
      'ip_velocity',
      'manual',
      'challenge_timeout'
    )
  );
