-- Flip tenants.auto_assign_crew default to TRUE so new accounts get the
-- "every worker on every project" behaviour out of the box.
--
-- Background: this column was added in migration 0080 with default FALSE,
-- which matched the cautious-first stance at the time. Operator feedback
-- (Jonathan, 2026-05-12) is that the expected mental model is "all my crew
-- is on my projects unless I explicitly remove them" — turning it ON by
-- default removes a per-project setup step for every new tenant.
--
-- Existing tenants are intentionally NOT backfilled. Whatever they have
-- now (explicitly set or inherited from the old default) stays — flipping
-- the bit on an active tenant would auto-add every worker to every
-- existing project, which is silent + destructive. Operators who want it
-- ON can flip the Worker defaults checkbox themselves.

alter table public.tenants
  alter column auto_assign_crew set default true;
