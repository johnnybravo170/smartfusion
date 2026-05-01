-- 0167_drop_jobs_from_gc_nav.sql
-- Drop the Jobs nav item from the renovation + tile vertical packs.
--
-- Renovation GCs and tile contractors think project-not-job. The /jobs
-- routes were a holdover from the pressure-washing / single-visit model
-- where one visit = one unit of work; for project-shaped verticals the
-- entry is duplicative with /projects and creates "what's a Job vs a
-- Project?" confusion in the sidebar.
--
-- Routes stay live (no URL breakage for anyone who bookmarked one) — we
-- only stop occupying nav real estate. If a tenant in these verticals
-- ever needs the Jobs surface, they can still navigate by URL or we can
-- restore the nav item per-tenant later.

UPDATE vertical_profile_packs
SET config = jsonb_set(
  config,
  '{nav_items}',
  (
    SELECT jsonb_agg(item)
    FROM jsonb_array_elements(config->'nav_items') AS item
    WHERE item->>'href' != '/jobs'
  )
)
WHERE vertical IN ('renovation', 'tile')
  AND config ? 'nav_items';
