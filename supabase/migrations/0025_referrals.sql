-- 0025_referrals.sql
-- Referral tracking table. Each row represents one referral invitation
-- (pending, signed_up, converted, churned) and its reward status.

CREATE TABLE public.referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_code_id UUID NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
    referrer_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    referred_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
    referred_email TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed_up', 'converted', 'churned')),
    reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (reward_status IN ('pending', 'earned', 'applied', 'expired')),
    signed_up_at TIMESTAMPTZ,
    converted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_referrals_referrer_tenant_id ON public.referrals (referrer_tenant_id);
CREATE INDEX idx_referrals_referral_code_id ON public.referrals (referral_code_id);

-- RLS
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

-- Authenticated users can only see referrals they sent.
CREATE POLICY tenant_select_referrals ON public.referrals
    FOR SELECT TO authenticated
    USING (referrer_tenant_id = public.current_tenant_id());
