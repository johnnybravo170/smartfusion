-- 0201_portal_show_budget.sql
--
-- Customer-facing budget visibility on the portal. Defaults off so
-- existing portals don't change behavior on deploy. Operators opt in
-- per-tenant; per-project nullable override lets them suppress on
-- specific jobs (friend / family-discount work) while keeping the
-- default on for everything else.
--
-- Resolver: project value wins when non-null; null = inherit tenant.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS portal_show_budget BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS portal_show_budget BOOLEAN;

COMMENT ON COLUMN public.tenants.portal_show_budget IS
  'Default visibility of the per-bucket budget breakdown on customer portals for this tenant. False = hidden (default). Per-project override on projects.portal_show_budget supersedes this when non-null.';
COMMENT ON COLUMN public.projects.portal_show_budget IS
  'Per-project override of the tenant default. NULL = inherit tenant. TRUE = always show. FALSE = always hide.';
