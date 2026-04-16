-- 0012_todos.sql
-- Per-user tasks. Optionally link to any top-level resource via
-- (related_type, related_id). Designed to be MCP-accessible in Phase 2.

CREATE TABLE IF NOT EXISTS public.todos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    title TEXT NOT NULL,
    done BOOLEAN NOT NULL DEFAULT false,
    due_date DATE,
    related_type TEXT CHECK (related_type IN ('customer', 'quote', 'job', 'invoice')),
    related_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.todos IS 'User tasks. related_type + related_id form a loose polymorphic link to customers/quotes/jobs/invoices.';
