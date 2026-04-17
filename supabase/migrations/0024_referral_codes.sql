-- 0024_referral_codes.sql
-- Referral codes table for the owner-to-owner referral system (Plan A).
-- Each tenant can have one or more referral codes. The default type is
-- 'operator' (owner referral); 'affiliate' is reserved for future use.

CREATE TABLE public.referral_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'operator' CHECK (type IN ('operator', 'affiliate')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_referral_codes_tenant_id ON public.referral_codes (tenant_id);
CREATE INDEX idx_referral_codes_code ON public.referral_codes (code);

-- RLS
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;

-- Authenticated users can manage their own codes.
CREATE POLICY tenant_select_referral_codes ON public.referral_codes
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_referral_codes ON public.referral_codes
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_referral_codes ON public.referral_codes
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());

-- Anon can SELECT active codes (for the public landing page /r/[code]).
CREATE POLICY anon_select_active_referral_codes ON public.referral_codes
    FOR SELECT TO anon
    USING (is_active = true);
