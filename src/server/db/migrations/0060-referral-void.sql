-- E11.7-02: the founder can void one referral with a reason, and un-void it.
-- A void is a flag over the edge's state, never a state transition, so the
-- reward-gating transitions (E4-06) are untouched. Every consumer of the
-- confirmed count reads only non-voided edges.
ALTER TABLE referral_edge
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN void_reason text,
  ADD COLUMN voided_by text,
  -- A void always has a reason and a human actor; an edge that is not voided
  -- carries neither. Fraud signals flag, humans decide (AGENTS.md rule 4).
  ADD CONSTRAINT referral_edge_void_recorded CHECK (
    (voided_at IS NULL AND void_reason IS NULL AND voided_by IS NULL)
    OR (
      voided_at IS NOT NULL
      AND void_reason IS NOT NULL
      AND btrim(void_reason) <> ''
      AND char_length(void_reason) <= 200
      AND voided_by IS NOT NULL
      AND btrim(voided_by) <> ''
      AND voided_by NOT LIKE 'system:%'
    )
  );

-- Before the draw snapshot is committed, a void also voids the edge's
-- referral entry through the existing entry-void path (voided_at). The marker
-- records that this void caused it, so an un-void restores exactly that entry
-- and never one a disqualification or an erasure voided.
ALTER TABLE giveaway_entry
  ADD COLUMN voided_by_referral_void boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT giveaway_entry_referral_void_shape CHECK (
    NOT voided_by_referral_void
    OR (voided_at IS NOT NULL AND method = 'referral' AND source_edge_id IS NOT NULL)
  );

-- The application role already reads both tables (0050). It may write only
-- the void columns; inserts still leave the marker at its false default.
GRANT UPDATE (voided_at, void_reason, voided_by)
  ON TABLE referral_edge TO valstara_app;
GRANT UPDATE (voided_by_referral_void)
  ON TABLE giveaway_entry TO valstara_app;
