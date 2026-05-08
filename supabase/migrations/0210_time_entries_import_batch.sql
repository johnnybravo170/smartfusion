-- 0210_time_entries_import_batch.sql (renumbered from 0192; the
-- original collided with 0192_phases_generic_seed.sql. Fully
-- idempotent so this applies cleanly.)
-- Phase F (last) of the onboarding-import wizard. Adds the same
-- provenance mechanism to time_entries that 0185–0209 added to the
-- other entity types.
--
-- Note on rollback semantics: time_entries has no `deleted_at` column
-- (it's a raw payroll/cost source), so the rollback action HARD-deletes
-- by import_batch_id rather than soft-deleting. Same trade-off as
-- expenses (Phase D). Receipt files in the imports bucket persist
-- regardless so a re-import is always possible.

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS import_batch_id UUID
    REFERENCES public.import_batches (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_time_entries_import_batch
  ON public.time_entries (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

COMMENT ON COLUMN public.time_entries.import_batch_id IS
  'Set when the time entry was bulk-imported via the onboarding wizard. NULL for live entries logged from the worker app or owner UI.';
