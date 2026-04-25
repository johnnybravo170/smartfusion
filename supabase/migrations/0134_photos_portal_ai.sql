-- 0134_photos_portal_ai.sql
-- AI cluster, item 1: Henry's portal-aware photo suggestions.
--
-- Two new columns on photos:
--   ai_portal_tags    — Henry's suggested portal tags (homeowner-facing
--                       vocabulary: before / progress / behind_wall /
--                       issue / completion / marketing). Empty array
--                       when not yet processed.
--   ai_portal_caption — Henry's suggested homeowner-friendly caption
--                       (different vocabulary from the internal `caption`
--                       column, which is operator-voice).
--
-- These are SUGGESTIONS only — the operator promotes them via
-- "Apply Henry's tags" UI. The existing portal_tags / client_visible
-- columns from 0123 stay the source of truth for what's actually
-- published.

ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS ai_portal_tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_portal_caption TEXT;

COMMENT ON COLUMN public.photos.ai_portal_tags IS
  'Henry-suggested portal_tags (before / progress / behind_wall / issue / completion / marketing). Operator-promoted into portal_tags via UI.';
COMMENT ON COLUMN public.photos.ai_portal_caption IS
  'Henry-suggested homeowner-friendly caption. Operator promotes into caption via UI.';
