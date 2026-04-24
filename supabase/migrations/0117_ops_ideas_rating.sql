-- Human rating feedback loop for ops.ideas.
-- Scout-style agents read these ratings before producing new ideas.
-- Distinct from the legacy `rating` column (1-5 priority) — this is
-- explicit -2/-1/+1/+2 human feedback.
ALTER TABLE ops.ideas
  ADD COLUMN IF NOT EXISTS user_rating        SMALLINT
    CHECK (user_rating BETWEEN -2 AND 2),
  ADD COLUMN IF NOT EXISTS user_rating_reason TEXT,
  ADD COLUMN IF NOT EXISTS user_rated_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_rated_by      UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS ops_ideas_user_rating_idx
  ON ops.ideas (user_rated_at DESC) WHERE user_rating IS NOT NULL;
