-- 0064_tenants_workers_can_edit_old_entries.sql
-- Tenant-wide flag controlling whether workers can edit/delete their own
-- time entries older than the 48-hour grace window. Default OFF so new
-- tenants get the stricter payroll-safe behavior; operators can flip it
-- on when they want the team to self-serve backfills.

ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS workers_can_edit_old_entries BOOLEAN NOT NULL DEFAULT FALSE;
