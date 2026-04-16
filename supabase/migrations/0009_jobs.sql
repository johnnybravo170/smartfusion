-- 0009_jobs.sql
-- A job is the scheduled/in-progress/complete execution of a (usually accepted) quote.
-- `quote_id` is nullable + ON DELETE SET NULL so a job can survive its quote
-- being deleted (e.g. we might purge expired quotes).

CREATE TABLE IF NOT EXISTS public.jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    customer_id UUID REFERENCES public.customers (id) ON DELETE RESTRICT,
    quote_id UUID REFERENCES public.quotes (id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'booked'
        CHECK (status IN ('booked', 'in_progress', 'complete', 'cancelled')),
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.jobs IS 'Scheduled execution of work for a customer. Status transitions drive the Track C kanban.';
