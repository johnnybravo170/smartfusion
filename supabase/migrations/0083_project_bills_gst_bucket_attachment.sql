-- Add bucket association, GST tracking, and attachment support to project_bills.
--
-- amount_cents is now the pre-GST subtotal.
-- gst_cents tracks the GST portion separately (defaults to 0 so old rows are unaffected).
-- attachment_storage_path stores the Supabase Storage key for an uploaded PDF or image.
-- bucket_id links the bill to a cost bucket on the project (optional).

ALTER TABLE public.project_bills
  ADD COLUMN IF NOT EXISTS bucket_id              UUID    REFERENCES public.project_cost_buckets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gst_cents              INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attachment_storage_path TEXT;
