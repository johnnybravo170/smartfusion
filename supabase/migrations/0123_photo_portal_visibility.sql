-- 0123_photo_portal_visibility.sql
-- Slice 2 of the Customer Portal & Home Record build.
--
-- Adds two columns on top of the existing single-tag `photos` system so
-- operators can publish photos to the homeowner portal with their own
-- vocabulary (before / progress / behind_wall / issue / completion /
-- marketing). The existing `tag` column stays untouched — it's the
-- internal documentation tag used by the gallery, AI suggestions, and
-- favorites flow. portal_tags is a separate, multi-valued, homeowner-
-- facing axis.
--
-- The behind_wall vocabulary tag is the foundation of the Home Record's
-- "what's behind every wall" gallery (Slice 6) — that section will pull
-- photos with portal_tags containing 'behind_wall' from this column.
--
-- Defaults:
--  * portal_tags '{}' so no existing photo accidentally appears on the
--    portal until the operator opts it in by tagging.
--  * client_visible TRUE so a tagged photo IS visible to the homeowner
--    by default — operators only flip it FALSE when they want to keep
--    a tagged photo internal (e.g. tagged 'issue' for triage but not
--    yet ready for client view).
--
-- The portal query reads photos where portal_tags <> '{}' AND
-- client_visible IS NOT FALSE, so absence of tags is the safe default.

ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS portal_tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS client_visible BOOLEAN NOT NULL DEFAULT TRUE;

-- GIN index on portal_tags for efficient `portal_tags @> '{behind_wall}'`
-- and `array_length(portal_tags, 1) > 0` style filters.
CREATE INDEX IF NOT EXISTS idx_photos_portal_tags
  ON public.photos USING GIN (portal_tags);

-- Partial b-tree for the hot portal query: per-project, only photos
-- actually published to the homeowner. Smaller and faster than the
-- generic project_id index for the public route's read path.
CREATE INDEX IF NOT EXISTS idx_photos_project_portal_visible
  ON public.photos (project_id, taken_at DESC NULLS LAST, uploaded_at DESC)
  WHERE project_id IS NOT NULL
    AND client_visible = TRUE
    AND array_length(portal_tags, 1) > 0
    AND deleted_at IS NULL;

COMMENT ON COLUMN public.photos.portal_tags IS
  'Homeowner-facing tags (multi-valued): before / progress / behind_wall / issue / completion / marketing. Empty array = not published to the portal. App-side enum, not a DB enum, so verticals can extend the vocabulary later.';

COMMENT ON COLUMN public.photos.client_visible IS
  'When false, hides a portal-tagged photo from the homeowner without un-tagging it. Default true so tagging implicitly publishes.';
