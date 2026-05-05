-- Competitor Brain support. Adds:
--   1. ops.competitors.slug — stable, URL-safe identifier. Backfilled from name.
--   2. ops.board_sessions.target_competitor_slug — when set on a session
--      whose advisor panel includes the Competitor Brain, the engine
--      switches that advisor into "embodying" mode and loads the
--      competitor's brief + tagged knowledge docs into its system prompt.

-- 1. ops.competitors.slug -------------------------------------------------

ALTER TABLE ops.competitors
  ADD COLUMN IF NOT EXISTS slug TEXT;

-- Backfill from name. Replace whitespace with '-', lowercase, strip
-- non-alphanumerics. Existing rows are populated; future inserts can pass
-- explicit slug or rely on a default at the application layer.
UPDATE ops.competitors
SET slug = lower(regexp_replace(regexp_replace(name, '\s+', '-', 'g'), '[^a-z0-9-]', '', 'gi'))
WHERE slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ops_competitors_slug_uniq
  ON ops.competitors (slug) WHERE slug IS NOT NULL;

-- 2. ops.board_sessions.target_competitor_slug ---------------------------

ALTER TABLE ops.board_sessions
  ADD COLUMN IF NOT EXISTS target_competitor_slug TEXT;

-- No FK constraint on the slug — competitors can be deleted without breaking
-- session history, and the engine's embodiment loader handles the
-- "competitor not found" case by falling back to generic mode.
