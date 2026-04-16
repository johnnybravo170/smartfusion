-- 0014_audit_log.sql
-- Append-only audit trail. Written from server actions for every sensitive
-- state transition. Used by the compliance-export job and by the Phase 2 AI
-- "what did I do last week" queries.

CREATE TABLE IF NOT EXISTS public.audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    user_id UUID,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID,
    metadata_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_log IS 'Append-only audit trail. user_id nullable for system/webhook-emitted events.';
