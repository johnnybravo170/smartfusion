-- 0006_service_catalog.sql
-- Per-tenant price list. One row per surface type the tenant quotes on.
-- Consumed by the pricing engine in Track B.

CREATE TABLE IF NOT EXISTS public.service_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    surface_type TEXT NOT NULL,
    label TEXT NOT NULL,
    price_per_sqft_cents INTEGER,
    min_charge_cents INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT service_catalog_tenant_surface_unique UNIQUE (tenant_id, surface_type)
);

COMMENT ON TABLE public.service_catalog IS 'Per-tenant surface type + pricing. Unique on (tenant_id, surface_type).';
