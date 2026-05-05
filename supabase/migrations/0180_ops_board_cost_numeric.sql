-- Cost columns on the board tables were originally INT (whole cents), but
-- the engine emits fractional cents (e.g. $0.0033 = 0.33¢) for tiny calls
-- like Anthropic prompt-cache reads. INT inserts those as 0.33 → "invalid
-- input syntax for type integer".
--
-- Fix: NUMERIC(10,4) — supports fractional cents to 0.0001 precision,
-- still well under 2^31 for any conceivable single-session spend, and
-- aligns with how `tokensToCents` already returns the value.

ALTER TABLE ops.board_messages
  ALTER COLUMN cost_cents TYPE NUMERIC(10, 4) USING cost_cents::numeric;

ALTER TABLE ops.board_sessions
  ALTER COLUMN budget_cents TYPE NUMERIC(10, 4) USING budget_cents::numeric;

ALTER TABLE ops.board_sessions
  ALTER COLUMN spent_cents TYPE NUMERIC(10, 4) USING spent_cents::numeric;
