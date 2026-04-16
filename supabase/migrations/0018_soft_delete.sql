-- 0018_soft_delete.sql
-- Add `deleted_at timestamptz` to customers, quotes, jobs, invoices per §13.9.
-- Soft-delete is enforced at the query layer (WHERE deleted_at IS NULL);
-- RLS still applies to soft-deleted rows.

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.quotes    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.jobs      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.invoices  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
