-- 0058_photo_favorites.sql
-- Public Photo Showcase v1. Contractors mark favourite photos across their
-- projects and publish them at /showcase/{tenant.slug}.
--
-- `job_type` is deliberately freeform text (not FK to a managed table) — the
-- filter chips on the showcase page are driven by SELECT DISTINCT. If users
-- want renaming/merging later, we'll add a managed tenant_job_types table.

ALTER TABLE public.photos
    ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS job_type TEXT;

-- Partial index: only favourites are queried for the showcase, so skip the
-- sea of non-favourites.
CREATE INDEX IF NOT EXISTS idx_photos_favorites_tenant
    ON public.photos (tenant_id, job_type, created_at DESC)
    WHERE is_favorite = true;
