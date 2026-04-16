-- 0010_photos.sql
-- Job-attached photos. Storage bucket `photos` (created in Track D) enforces
-- a matching path convention: `{tenant_id}/{job_id}/{photo_id}.{ext}`.

CREATE TABLE IF NOT EXISTS public.photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    job_id UUID REFERENCES public.jobs (id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    tag TEXT NOT NULL DEFAULT 'other'
        CHECK (tag IN ('before', 'after', 'progress', 'other')),
    caption TEXT,
    taken_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.photos IS 'Job-attached photos. Storage bucket enforces path convention {tenant_id}/{job_id}/{photo_id}.{ext}.';
