-- E11.7-03: the coupon ladder and wave 1 replace ADR-025's milestone tiers
-- (founder, 2026-11-17). The ladder's figures are configuration in
-- src/server/referral/config.ts; this migration creates the structures, retires
-- the old awards, and backfills both from the edges as they stand now.

-- 1. The coupon table. Derived state: the application recomputes it from the
--    owner's confirmed, non-voided referrals inside the same transaction as
--    every confirmation, void and un-void, and in the daily repair job.
--    `settled` cannot be stored: a coupon is held until the main platform sees
--    a referred friend's first order (ADR-012), or void below its unlock.
CREATE TABLE referral_coupon (
  id uuid PRIMARY KEY,
  subscriber_id uuid NOT NULL REFERENCES subscriber(id),
  coupon_number smallint NOT NULL CHECK (coupon_number >= 1),
  percent smallint CHECK (percent BETWEEN 1 AND 100),
  state text NOT NULL CHECK (state IN ('held', 'void')),
  -- The expiry is computed from the configured public-launch date, which is
  -- not known for certain until handoff; the row records only that basis.
  expiry_basis text NOT NULL DEFAULT 'public_launch'
    CHECK (expiry_basis = 'public_launch'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT referral_coupon_owner_number UNIQUE (subscriber_id, coupon_number),
  -- A held coupon has its percent; a void one has none.
  CONSTRAINT referral_coupon_percent_shape
    CHECK ((state = 'held') = (percent IS NOT NULL)),
  CONSTRAINT referral_coupon_updated_after_created
    CHECK (updated_at >= created_at)
);

-- The application inserts and recomputes coupons, and erasure deletes them
-- (E9-05). It can never change a coupon's owner, number or basis.
GRANT SELECT, DELETE ON TABLE referral_coupon TO valstara_app;
GRANT INSERT (id, subscriber_id, coupon_number, percent, state, created_at, updated_at)
  ON TABLE referral_coupon TO valstara_app;
GRANT UPDATE (percent, state, updated_at) ON TABLE referral_coupon TO valstara_app;

-- 2. Retire the milestone awards. Every award not already void is voided with
--    the reason `ladder_replaced`, audited one row per award, and never
--    deleted. The application can no longer create one.
ALTER TABLE milestone_award
  ADD COLUMN void_reason text,
  ADD CONSTRAINT milestone_award_void_reason CHECK (
    void_reason IS NULL OR (state = 'void' AND void_reason = 'ladder_replaced')
  );

-- The audit rows are written first, from the awards' states before the void,
-- in the same transaction as the void itself.
INSERT INTO audit_log (id, at, actor, action, subject_type, subject_id, detail)
SELECT gen_random_uuid(), CURRENT_TIMESTAMP, 'system:migration-0061',
  'referral.milestone_retired', 'milestone_award', award.id::text,
  jsonb_build_object(
    'reason', 'ladder_replaced',
    'subscriber_id', award.subscriber_id,
    'tier', award.tier,
    'reward_kind', award.reward_kind,
    'before', jsonb_build_object('state', award.state, 'void_reason', NULL),
    'after', jsonb_build_object('state', 'void', 'void_reason', 'ladder_replaced')
  )
FROM milestone_award award
WHERE award.state <> 'void';

UPDATE milestone_award
SET state = 'void', void_reason = 'ladder_replaced'
WHERE state <> 'void';

REVOKE INSERT ON TABLE milestone_award FROM valstara_app;

-- `referral_tier` is derived from settled awards, and none remain.
UPDATE subscriber SET referral_tier = 0 WHERE referral_tier <> 0;

-- 3. The window from verification order alone, written once at verification
--    (founder D1, 2026-11-17). `wave-1` here is the first-1,000 place, so a
--    later void never removes it. `access_window` is this window, or wave 1
--    when another wave-1 reason holds.
ALTER TABLE subscriber
  ADD COLUMN verification_order_window text
    CHECK (verification_order_window IN ('wave-1', 'wave-2', 'wave-3', 'wave-4'));

-- The earliest recorded promotion started from the verification-order window;
-- a member never promoted still holds it.
UPDATE subscriber
SET verification_order_window = COALESCE(
  (
    SELECT audit.detail->>'fromWindow'
    FROM audit_log audit
    WHERE audit.action = 'referral.access_window_promoted'
      AND audit.subject_type = 'subscriber'
      AND audit.subject_id = subscriber.id::text
    ORDER BY audit.at, audit.id
    LIMIT 1
  ),
  access_window
)
WHERE access_window IS NOT NULL;

CREATE FUNCTION preserve_verification_order_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'erased' THEN
    NEW.verification_order_window := NULL;
  ELSIF OLD.verification_order_window IS NOT NULL
    AND NEW.verification_order_window IS DISTINCT FROM OLD.verification_order_window THEN
    RAISE EXCEPTION 'subscriber.verification_order_window is write-once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER verification_order_window_write_once
BEFORE UPDATE OF verification_order_window, status ON subscriber
FOR EACH ROW EXECUTE FUNCTION preserve_verification_order_window();

GRANT UPDATE (verification_order_window) ON TABLE subscriber TO valstara_app;

-- 4. Backfill the ladder and wave 1 from the confirmed, non-voided edges, with
--    the founder's figures as configured when this migration was written:
--    coupons unlock at 3, 21 and 39 and step 5% every 3 referrals up to 30%;
--    3 referrals is wave 1. From here on the application recomputes both from
--    configuration.
INSERT INTO referral_coupon (
  id, subscriber_id, coupon_number, percent, state, created_at, updated_at
)
SELECT gen_random_uuid(), counted.referrer_id, ladder.coupon_number,
  LEAST(30, 5 * (1 + (counted.confirmed - ladder.unlock) / 3)), 'held',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT referrer_id, count(*)::integer AS confirmed
  FROM referral_edge
  WHERE state = 'confirmed' AND voided_at IS NULL AND referrer_id IS NOT NULL
  GROUP BY referrer_id
) counted
CROSS JOIN (VALUES (1, 3), (2, 21), (3, 39)) AS ladder(coupon_number, unlock)
WHERE counted.confirmed >= ladder.unlock;

CREATE TEMPORARY TABLE coupon_ladder_wave ON COMMIT DROP AS
SELECT subscriber.id, subscriber.access_window AS from_window,
  COALESCE(edges.confirmed, 0) AS confirmed,
  CASE
    WHEN subscriber.verification_order_window = 'wave-1'
      OR COALESCE(edges.confirmed, 0) >= 3 THEN 'wave-1'
    ELSE subscriber.verification_order_window
  END AS to_window
FROM subscriber
LEFT JOIN (
  SELECT referrer_id, count(*)::integer AS confirmed
  FROM referral_edge
  WHERE state = 'confirmed' AND voided_at IS NULL
  GROUP BY referrer_id
) edges ON edges.referrer_id = subscriber.id
WHERE subscriber.verification_order_window IS NOT NULL;

INSERT INTO audit_log (id, at, actor, action, subject_type, subject_id, detail)
SELECT gen_random_uuid(), CURRENT_TIMESTAMP, 'system:migration-0061',
  'referral.access_window_recalculated', 'subscriber', wave.id::text,
  jsonb_build_object(
    'confirmedReferrals', wave.confirmed,
    'fromWindow', wave.from_window,
    'toWindow', wave.to_window,
    'verificationOrderWindow', subscriber.verification_order_window
  )
FROM coupon_ladder_wave wave
JOIN subscriber ON subscriber.id = wave.id
WHERE wave.from_window IS DISTINCT FROM wave.to_window;

UPDATE subscriber
SET access_window = wave.to_window, updated_at = CURRENT_TIMESTAMP
FROM coupon_ladder_wave wave
WHERE subscriber.id = wave.id
  AND wave.from_window IS DISTINCT FROM wave.to_window;

-- The recorded window is always honoured: a member's access window is the
-- window their verification order gave them, or wave 1. In particular, the
-- first-1,000 place (`wave-1` here) can never be lost. Added after the
-- recalculation, since a tier promotion could leave any earlier window.
ALTER TABLE subscriber
  ADD CONSTRAINT subscriber_access_window_from_order CHECK (
    verification_order_window IS NULL
    OR access_window = verification_order_window
    OR access_window = 'wave-1'
  );
