-- 0013_worklog_entries.sql
-- Timestamped work log. A mix of user-written notes and system-emitted events
-- (status transitions, quote sent, invoice paid, etc.). This table is the AI
-- memory substrate for Phase 2.

CREATE TABLE IF NOT EXISTS public.worklog_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    user_id UUID,
    entry_type TEXT NOT NULL DEFAULT 'note'
        CHECK (entry_type IN ('note', 'system', 'milestone')),
    title TEXT,
    body TEXT,
    related_type TEXT CHECK (related_type IN ('customer', 'quote', 'job', 'invoice')),
    related_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.worklog_entries IS 'Timestamped work log / activity feed. user_id nullable for system-emitted entries.';
