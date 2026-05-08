-- 0209_projects_is_cost_plus.sql
-- Make the cost-plus / fixed-price billing distinction explicit on the
-- project. Today the choice is implicit — `generateFinalInvoiceAction`
-- branches on whether `getVarianceReport(projectId).estimated_cents > 0`,
-- which means "no priced estimate ⇒ cost-plus". That's fragile: an
-- operator who forgot to price the estimate silently bills cost-plus on
-- what was supposed to be a fixed-price job.
--
-- The flag also gates UI behaviour going forward — in particular the
-- pre-tax / tax auto-split on the expense forms only matters when the
-- project will mark up materials. And it gives us one place to hang
-- province/state-specific cost-plus behaviour as we expand beyond Canada.
--
-- Backfill via DEFAULT TRUE: every existing project becomes cost-plus,
-- which matches the production tenant's reality (Jonathan's projects
-- are all cost-plus). New projects also default to cost-plus; the
-- project-create UI gets a toggle to flip to fixed-price when needed.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS is_cost_plus BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.projects.is_cost_plus IS
  'Billing mode for the project. TRUE: bill labour + expenses + management fee; markup base is the contractor''s pre-tax cost (see migration 0208). FALSE: bill the priced estimate / contract balance. Governs the cost-plus path in generateFinalInvoiceAction and the auto-split tax chip on expense forms. Defaults TRUE — flip to FALSE on fixed-price jobs at project creation or via the project edit UI.';
