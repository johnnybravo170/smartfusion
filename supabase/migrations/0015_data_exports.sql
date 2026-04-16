-- 0015_data_exports.sql
-- PIPEDA data-export jobs (§13.3). A user requests an export, a background
-- job builds a zip, uploads it to storage with a signed URL, emails the link.
-- Rows here are the status record; the payload lives in Supabase Storage.

CREATE TABLE IF NOT EXISTS public.data_exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'ready', 'expired', 'failed')),
    download_url TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.data_exports IS 'PIPEDA data-export request tracking. Payload lives in Supabase Storage; this is just the job record.';
