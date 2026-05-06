-- 0186_projects_import_batch.sql
-- Phase B of the onboarding-import wizard. Adds the same provenance
-- mechanism to projects that 0185 added to customers: a nullable FK to
-- import_batches so every imported project carries its origin batch
-- and can be rolled back together.
--
-- Phase B is structurally additive — projects + estimate scaffolding
-- without money math. Tax provenance + invoice math freeze land in
-- Phase C alongside the invoices import.
--
-- Side-effect customer creation: when a project import references a
-- customer that doesn't exist yet, the import action auto-creates that
-- customer and tags it with the SAME projects-kind batch_id. This
-- preserves "rollback removes everything that came in this operation"
-- without forcing a two-step UX. customers.import_batch_id pointing
-- at a kind='projects' batch is fine — the FK is provenance, not
-- ownership.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS import_batch_id UUID
    REFERENCES public.import_batches (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_import_batch
  ON public.projects (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

COMMENT ON COLUMN public.projects.import_batch_id IS
  'Set when the project was created via the import wizard. NULL for hand-typed projects. May reference a kind=projects OR kind=customers batch (legacy intake flows could in principle tag too).';
